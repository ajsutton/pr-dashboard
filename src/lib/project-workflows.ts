/**
 * Pure builders for the "expected / scheduled workflows" Projects view.
 *
 * No network here — the poller fetches raw config files + API payloads and
 * hands them to these functions, which is what makes them unit-testable.
 */

import type { CiJobStatusValue, DefaultBranchJob } from "../types.ts";

export interface CircleConfigFile {
  path: string;
  content: string;
}

export interface DefinedWorkflow {
  name: string;
  scheduled: boolean;
}

/** Parameter names that, when gating a workflow, mark it schedule-driven. */
const SCHEDULE_PARAM_RE = /schedul|weekly|nightly|daily|monthly|cron/i;

/**
 * Union of top-level workflow names across every committed CircleCI config
 * file (root config.yml plus any dynamic-config continuation files), each
 * flagged scheduled when its definition references a schedule trigger.
 *
 * Generic: no per-repo paths or parameter names are hard-coded. Files that
 * don't parse or have no `workflows:` map are skipped.
 */
export function scanCircleWorkflows(files: CircleConfigFile[]): DefinedWorkflow[] {
  const byName = new Map<string, boolean>();
  for (const f of files) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(f.content);
    } catch {
      continue;
    }
    const workflows = (doc as Record<string, unknown> | null)?.["workflows"];
    if (!workflows || typeof workflows !== "object") continue;
    for (const [name, def] of Object.entries(workflows as Record<string, unknown>)) {
      if (name === "version") continue;
      const scheduled = isScheduledWorkflow(def);
      byName.set(name, (byName.get(name) ?? false) || scheduled);
    }
  }
  return [...byName.entries()].map(([name, scheduled]) => ({ name, scheduled }));
}

function isScheduledWorkflow(def: unknown): boolean {
  if (!def || typeof def !== "object") return false;
  const d = def as Record<string, unknown>;
  // Legacy: workflows.<name>.triggers[].schedule.cron
  const triggers = d["triggers"];
  if (Array.isArray(triggers) && triggers.some((t) => t && typeof t === "object" && "schedule" in (t as object))) {
    return true;
  }
  // Modern: a `when` condition referencing pipeline.schedule or a schedule-y param.
  const when = d["when"];
  if (when === undefined) return false;
  const text = JSON.stringify(when);
  if (/pipeline\.schedule/i.test(text)) return true;
  const paramRefs = text.match(/pipeline\.parameters\.([A-Za-z0-9_-]+)/gi) ?? [];
  return paramRefs.some((r) => SCHEDULE_PARAM_RE.test(r));
}

export interface RawInsightsRun {
  status: string;
  created_at?: string | undefined;
  stopped_at?: string | undefined;
}

export interface ProjectLastRun {
  found: boolean;
  status?: CiJobStatusValue | undefined;
  at?: string | undefined;
  url?: string | undefined;
}

export interface ProjectWorkflow {
  repo: string;
  provider: "circleci" | "github";
  name: string;
  scheduled: boolean;
  disabledState?: "disabled_manually" | "disabled_inactivity" | undefined;
  lastRun: ProjectLastRun;
}

const CIRCLE_INSIGHTS_STATUS: Record<string, CiJobStatusValue> = {
  success: "success",
  failed: "failed",
  error: "failed",
  failing: "failed",
  canceled: "canceled",
  cancelled: "canceled",
  running: "running",
  on_hold: "blocked",
  blocked: "blocked",
  unauthorized: "blocked",
};

function mapInsightsStatus(raw: string | undefined): CiJobStatusValue {
  if (!raw) return "unknown";
  return CIRCLE_INSIGHTS_STATUS[raw] ?? "unknown";
}

export function buildCircleProjectWorkflows(args: {
  repo: string;
  org: string;
  defined: DefinedWorkflow[];
  runsByName: Record<string, RawInsightsRun[]>;
}): ProjectWorkflow[] {
  // `args.repo` is already the `owner/repo` slug, which is exactly the
  // `github/<owner>/<repo>` tail of a CircleCI pipelines URL.
  const projectUrl = `https://app.circleci.com/pipelines/github/${args.repo}`;

  // Only workflows defined in the committed config count as "expected". Insights
  // is used solely to fill in each one's last run (newest item first); a
  // workflow that ran recently but is no longer in the config (deleted/renamed)
  // is intentionally not surfaced.
  const out: ProjectWorkflow[] = [];
  for (const { name, scheduled } of args.defined) {
    const newest = (args.runsByName[name] ?? [])[0];
    const lastRun: ProjectLastRun = newest
      ? {
          found: true,
          status: mapInsightsStatus(newest.status),
          at: newest.stopped_at ?? newest.created_at,
          url: projectUrl,
        }
      : { found: false };
    out.push({ repo: args.repo, provider: "circleci", name, scheduled, lastRun });
  }
  return out;
}

export interface RawActionsWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface RawActionsRun {
  status: string;
  conclusion?: string | null | undefined;
  updated_at?: string | undefined;
  created_at?: string | undefined;
  html_url?: string | undefined;
}

export interface ActionsWorkflowInput {
  workflow: RawActionsWorkflow;
  fileContent?: string | undefined;
  latestRun?: RawActionsRun | undefined;
}

/**
 * True when a GitHub Actions workflow is defined by a committed file in the
 * repo (`.github/workflows/…`). The Actions API also returns GitHub-managed
 * "dynamic" workflows (path `dynamic/…`, e.g. Copilot code review, default
 * CodeQL setup, Dependabot) that aren't in the codebase; those are excluded so
 * the Projects view shows only code-defined workflows.
 */
export function isCodeDefinedWorkflowPath(path: string | undefined): boolean {
  return !!path && path.startsWith(".github/workflows/");
}

const PULL_REQUEST_ONLY_EVENTS: Record<string, true> = {
  pull_request: true,
  pull_request_target: true,
  merge_group: true,
};

/**
 * True for Actions events whose runs belong to pull requests or merge queues,
 * rather than to the repository's default branch. GitHub's REST `branch`
 * filter compares the bare head-branch name, so a fork PR whose branch is also
 * named `develop` can otherwise leak into a `branch=develop` query.
 */
export function isPullRequestScopedActionsEvent(event: string | undefined): boolean {
  return !!event && PULL_REQUEST_ONLY_EVENTS[event] === true;
}

function actionsWorkflowEvents(fileContent: string | undefined): Set<string> | undefined {
  if (!fileContent) return undefined;
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(fileContent);
  } catch {
    return undefined;
  }
  const on = (doc as Record<string, unknown> | null)?.["on"];
  if (typeof on === "string") return new Set([on]);
  if (Array.isArray(on)) {
    if (!on.every((event) => typeof event === "string")) return undefined;
    return new Set(on);
  }
  if (on && typeof on === "object") return new Set(Object.keys(on));
  return undefined;
}

export function isPullRequestOnlyActionsWorkflow(fileContent: string | undefined): boolean {
  const events = actionsWorkflowEvents(fileContent);
  return !!events?.size && [...events].every((event) => isPullRequestScopedActionsEvent(event));
}

function mapActionsStatus(status: string, conclusion: string | null | undefined): CiJobStatusValue {
  const s = status.toLowerCase();
  const c = (conclusion ?? "").toLowerCase();
  if (s === "completed") {
    switch (c) {
      case "success":
      case "neutral":
      case "skipped":
        return "success";
      case "failure":
      case "timed_out":
      case "startup_failure":
      case "action_required":
        return "failed";
      case "cancelled":
        return "canceled";
      case "stale":
        return "blocked";
      default:
        return "unknown";
    }
  }
  if (s === "in_progress") return "running";
  if (s === "queued" || s === "pending" || s === "waiting" || s === "requested") return "queued";
  return "unknown";
}

function actionsScheduled(fileContent: string | undefined): boolean {
  if (!fileContent) return false;
  let doc: unknown;
  try {
    // Detection relies on the YAML parser treating bare `on` as the string key "on" (YAML 1.2 semantics).
    doc = Bun.YAML.parse(fileContent);
  } catch {
    return /^\s*schedule\s*:/m.test(fileContent);
  }
  const on = (doc as Record<string, unknown> | null)?.["on"];
  if (on && typeof on === "object" && "schedule" in (on as object)) return true;
  return false;
}

export function buildActionsProjectWorkflows(repo: string, inputs: ActionsWorkflowInput[]): ProjectWorkflow[] {
  return inputs.map(({ workflow, fileContent, latestRun }) => {
    const lastRun: ProjectLastRun = latestRun
      ? {
          found: true,
          status: mapActionsStatus(latestRun.status, latestRun.conclusion),
          at: latestRun.updated_at ?? latestRun.created_at,
          url: latestRun.html_url,
        }
      : { found: false };
    const disabledState =
      workflow.state === "disabled_manually" || workflow.state === "disabled_inactivity" ? workflow.state : undefined;
    return {
      repo,
      provider: "github" as const,
      name: workflow.name,
      scheduled: actionsScheduled(fileContent),
      disabledState,
      lastRun,
    };
  });
}

const keyOf = (repo: string, provider: string, name: string) => `${repo}::${provider}::${name}`;

/**
 * Fold expected workflows into the recent-run job list. When a recent-run job
 * already exists for the same (repo, provider, name) it is the richer source —
 * keep its run data and only annotate it expected/scheduled/disabledState.
 * Otherwise add a latest-less card carrying the long-lookback lastRun.
 */
export function mergeProjectWorkflows(
  jobs: DefaultBranchJob[],
  expected: ProjectWorkflow[],
): DefaultBranchJob[] {
  const byKey = new Map<string, DefaultBranchJob>();
  for (const j of jobs) {
    byKey.set(keyOf(j.repo, j.provider ?? "github", j.name), j);
  }
  for (const e of expected) {
    const k = keyOf(e.repo, e.provider, e.name);
    const existing = byKey.get(k);
    if (existing) {
      // Annotate without mutating the input: emit a fresh copy.
      byKey.set(k, { ...existing, expected: true, scheduled: e.scheduled, disabledState: e.disabledState });
    } else {
      byKey.set(k, {
        key: k,
        repo: e.repo,
        branch: "",
        name: e.name,
        provider: e.provider,
        expected: true,
        scheduled: e.scheduled,
        disabledState: e.disabledState,
        lastRun: e.lastRun,
      });
    }
  }
  return [...byKey.values()];
}
