/**
 * Build a CiPipelineStatus from raw GitHub check contexts (typically
 * GitHub Actions). Uses only data already in the GraphQL response — no
 * extra API calls.
 */

import { JobDurationStats, isCircleCiUrl, type RawWorkflow as CircleRawWorkflow, type RawPipeline as CircleRawPipeline } from "./circleci.ts";
import type { RawCheckContext, RawWorkflowRun } from "./dashboard-github.ts";
import type { CiJobStatus, CiPipelineStatus, CiWorkflowStatus, DefaultBranchJob, DefaultBranchJobRun } from "../types.ts";

function mapCheckRunStatus(status: string | undefined, conclusion: string | undefined): CiJobStatus["status"] {
  const s = (status ?? "").toUpperCase();
  const c = (conclusion ?? "").toUpperCase();
  if (s === "COMPLETED") {
    switch (c) {
      case "SUCCESS":
      case "NEUTRAL":
      case "SKIPPED":
        return "success";
      case "FAILURE":
      case "TIMED_OUT":
      case "STARTUP_FAILURE":
      case "ACTION_REQUIRED":
        return "failed";
      case "CANCELLED":
        return "canceled";
      case "STALE":
        return "blocked";
      default:
        return "unknown";
    }
  }
  if (s === "IN_PROGRESS") return "running";
  if (s === "QUEUED" || s === "PENDING" || s === "WAITING" || s === "REQUESTED") return "queued";
  return "unknown";
}

function mapStatusContext(state: string | undefined): CiJobStatus["status"] {
  switch ((state ?? "").toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failed";
    case "PENDING":
    case "EXPECTED":
      return "queued";
    default:
      return "unknown";
  }
}

function dedupeChecksByName(checks: RawCheckContext[]): RawCheckContext[] {
  const keyOf = (c: RawCheckContext): string =>
    c.__typename === "CheckRun" ? c.name ?? "" : c.context ?? "";
  const timeOf = (c: RawCheckContext): number => {
    const t = c.completedAt ?? c.startedAt;
    return t ? Date.parse(t) : 0;
  };
  const latest = new Map<string, RawCheckContext>();
  for (const c of checks) {
    const key = keyOf(c);
    const existing = latest.get(key);
    if (!existing || timeOf(c) >= timeOf(existing)) latest.set(key, c);
  }
  return [...latest.values()];
}

function rollUp(statuses: CiJobStatus["status"][]): CiJobStatus["status"] {
  if (statuses.length === 0) return "unknown";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.some((s) => s === "queued")) return "queued";
  if (statuses.some((s) => s === "blocked")) return "blocked";
  if (statuses.every((s) => s === "success")) return "success";
  if (statuses.some((s) => s === "canceled")) return "canceled";
  return "unknown";
}

export interface BuildChecksPipelineOpts {
  repo: string;
  commit: string;
  branch?: string | undefined;
  checks: RawCheckContext[];
  durationStats: JobDurationStats;
  now: number;
  /** Skip checks whose detailsUrl points at CircleCI — CircleCI provides its own pipeline. */
  skipCircleCi?: boolean | undefined;
}

/**
 * Returns a synthetic CiPipelineStatus aggregating non-CircleCI check runs +
 * status contexts. Returns undefined if there are no eligible checks.
 */
export function buildChecksPipelineStatus(opts: BuildChecksPipelineOpts): CiPipelineStatus | undefined {
  const eligible = opts.checks.filter((c) => {
    if (!opts.skipCircleCi) return true;
    return !isCircleCiUrl(c.detailsUrl) && !isCircleCiUrl(c.targetUrl);
  });
  if (eligible.length === 0) return undefined;

  // Group CheckRun by workflow name; bucket StatusContext under "checks".
  const groups = new Map<string, RawCheckContext[]>();
  for (const c of eligible) {
    const isCheckRun = c.__typename === "CheckRun";
    const groupName = isCheckRun ? c.workflowName ?? "GitHub Actions" : "checks";
    const arr = groups.get(groupName) ?? [];
    arr.push(c);
    groups.set(groupName, arr);
  }

  // Reran checks (and stale in_progress runs left over from abandoned merge_group
  // attempts) show up alongside the latest entry. Keep only the latest run per
  // job name so a prior failure or orphaned in-progress check doesn't poison
  // the rolled-up status.
  for (const [name, items] of groups) {
    groups.set(name, dedupeChecksByName(items));
  }

  const workflows: CiWorkflowStatus[] = [];
  let pipelineStart = Infinity;
  let pipelineStop = -Infinity;
  let anyRunning = false;

  for (const [name, items] of groups) {
    const jobs: CiJobStatus[] = items.map((c) => {
      const isCheckRun = c.__typename === "CheckRun";
      const status = isCheckRun
        ? mapCheckRunStatus(c.status, c.conclusion)
        : mapStatusContext(c.state);
      const jobName = isCheckRun ? c.name ?? "" : c.context ?? "";
      const startedMs = c.startedAt ? Date.parse(c.startedAt) : undefined;
      const stoppedMs = c.completedAt ? Date.parse(c.completedAt) : undefined;
      const finishedMs = stoppedMs ?? (status === "running" && startedMs ? opts.now : undefined);
      const durationMs = startedMs && finishedMs ? finishedMs - startedMs : undefined;
      const key = `${opts.repo}::${name}::${jobName}`;
      if (status === "success" && durationMs && durationMs > 0) opts.durationStats.record(key, durationMs);
      const estimatedDurationMs = opts.durationStats.estimate(key);
      return {
        name: jobName,
        status,
        startedAt: c.startedAt,
        stoppedAt: c.completedAt,
        durationMs,
        estimatedDurationMs,
        url: c.detailsUrl ?? c.targetUrl,
      };
    });

    const wfStatus = rollUp(jobs.map((j) => j.status));
    if (wfStatus === "running" || wfStatus === "queued") anyRunning = true;

    const startedMsValues = jobs.map((j) => j.startedAt ? Date.parse(j.startedAt) : undefined).filter((n): n is number => typeof n === "number");
    const stoppedMsValues = jobs.map((j) => j.stoppedAt ? Date.parse(j.stoppedAt) : undefined).filter((n): n is number => typeof n === "number");
    const wfStart = startedMsValues.length > 0 ? Math.min(...startedMsValues) : opts.now;
    const wfStop = wfStatus === "success" || wfStatus === "failed" || wfStatus === "canceled"
      ? (stoppedMsValues.length > 0 ? Math.max(...stoppedMsValues) : opts.now)
      : undefined;
    pipelineStart = Math.min(pipelineStart, wfStart);
    if (wfStop != null) pipelineStop = Math.max(pipelineStop, wfStop);

    const elapsedMs = (wfStop ?? opts.now) - wfStart;
    const estimates = jobs.map((j) => j.estimatedDurationMs).filter((n): n is number => typeof n === "number");
    const estimatedTotalMs = estimates.length > 0 ? Math.max(...estimates) : undefined;
    const progressPct = computeWorkflowProgress(jobs, wfStatus, elapsedMs, estimatedTotalMs);

    workflows.push({
      id: name,
      name,
      status: wfStatus,
      createdAt: new Date(wfStart).toISOString(),
      stoppedAt: wfStop != null ? new Date(wfStop).toISOString() : undefined,
      jobs,
      estimatedTotalMs,
      elapsedMs,
      progressPct,
      url: jobs[0]?.url ?? `https://github.com/${opts.repo}/commit/${opts.commit}/checks`,
    });
  }

  const rolledUp = rollUp(workflows.map((w) => w.status));
  const elapsedMs = Number.isFinite(pipelineStart)
    ? (Number.isFinite(pipelineStop) && !anyRunning ? pipelineStop : opts.now) - pipelineStart
    : 0;
  const estimates = workflows.map((w) => w.estimatedTotalMs).filter((n): n is number => typeof n === "number");
  const estimatedTotalMs = estimates.length > 0 ? Math.max(...estimates) : undefined;
  const progressPct = aggregateProgress(workflows, rolledUp);

  return {
    provider: "github",
    commit: opts.commit,
    branch: opts.branch,
    workflows,
    rolledUp,
    progressPct,
    elapsedMs: Math.max(0, elapsedMs),
    estimatedTotalMs,
    url: `https://github.com/${opts.repo}/commit/${opts.commit}/checks`,
  };
}

function computeWorkflowProgress(
  jobs: CiJobStatus[],
  status: CiJobStatus["status"],
  elapsedMs: number,
  estimatedTotalMs: number | undefined,
): number {
  if (status === "success" || status === "failed" || status === "canceled") return 100;
  if (jobs.length === 0) return 0;
  const done = jobs.filter((j) => j.status === "success" || j.status === "failed" || j.status === "canceled").length;
  const byCount = done / jobs.length;
  if (!estimatedTotalMs || estimatedTotalMs <= 0) return Math.round(byCount * 100);
  const byTime = Math.min(elapsedMs / estimatedTotalMs, 0.99);
  return Math.max(0, Math.min(99, Math.round((byCount + byTime) * 50)));
}

function aggregateProgress(workflows: CiWorkflowStatus[], rolledUp: CiJobStatus["status"]): number {
  if (workflows.length === 0) return 0;
  if (rolledUp === "success" || rolledUp === "failed" || rolledUp === "canceled") return 100;
  const avg = workflows.reduce((a, w) => a + w.progressPct, 0) / workflows.length;
  return Math.max(0, Math.min(99, Math.round(avg)));
}

function mapRunStatus(status: string, conclusion: string | undefined): CiJobStatus["status"] {
  const s = (status ?? "").toLowerCase();
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

export interface BuildDefaultBranchJobsOpts {
  repo: string;
  branch: string;
  /** All workflow runs harvested from the recent runs endpoint for this branch. */
  runs: RawWorkflowRun[];
  durationStats: JobDurationStats;
  now: number;
  /** Drop workflows whose latest run started before now-windowMs. */
  windowMs: number;
}

/**
 * One DefaultBranchJob per workflow_id. Each card aggregates all runs for a
 * workflow on the default branch and surfaces:
 *   - latest: the most-recent run (drives the progress / top of the card)
 *   - lastCompleted: the most-recent terminal run (drives the bottom colour)
 *
 * Sort key is the run's `createdAt` so that a re-run of an old commit doesn't
 * appear "newer" than a fresh push.
 */
export function buildDefaultBranchJobs(opts: BuildDefaultBranchJobsOpts): DefaultBranchJob[] {
  if (opts.runs.length === 0) return [];

  const groups = new Map<number, RawWorkflowRun[]>();
  for (const r of opts.runs) {
    const arr = groups.get(r.workflowId) ?? [];
    arr.push(r);
    groups.set(r.workflowId, arr);
  }

  const out: DefaultBranchJob[] = [];
  for (const [workflowId, runs] of groups) {
    const sorted = [...runs].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const newest = sorted[0]!;
    const newestStartMs = newest.startedAt ? Date.parse(newest.startedAt) : Date.parse(newest.createdAt);
    if (opts.now - newestStartMs > opts.windowMs) continue;
    const completed = sorted.find((r) => {
      const s = mapRunStatus(r.status, r.conclusion);
      return s === "success" || s === "failed" || s === "canceled" || s === "blocked";
    });
    out.push({
      key: `${opts.repo}::wf-${workflowId}`,
      repo: opts.repo,
      branch: opts.branch,
      name: newest.workflowName,
      latest: workflowRunToJobRun(newest, opts.repo, opts.durationStats, opts.now),
      lastCompleted: completed
        ? workflowRunToJobRun(completed, opts.repo, opts.durationStats, opts.now)
        : undefined,
    });
  }
  return out;
}

export interface CircleWorkflowRecord {
  workflow: CircleRawWorkflow;
  pipeline: CircleRawPipeline;
}

export interface BuildCircleDefaultBranchJobsOpts {
  repo: string;
  branch: string;
  org: string;
  /** Project slug used to build workflow URLs (`<org>/<repo>` already split). */
  records: CircleWorkflowRecord[];
  durationStats: JobDurationStats;
  now: number;
  windowMs: number;
}

/**
 * One DefaultBranchJob per distinct workflow name (across all CircleCI
 * pipelines pulled for the branch). Same latest / lastCompleted split as the
 * GitHub Actions path. Filters jobs whose newest run is past the window.
 */
export function buildCircleDefaultBranchJobs(opts: BuildCircleDefaultBranchJobsOpts): DefaultBranchJob[] {
  if (opts.records.length === 0) return [];
  const groups = new Map<string, CircleWorkflowRecord[]>();
  for (const rec of opts.records) {
    const name = rec.workflow.name;
    const arr = groups.get(name) ?? [];
    arr.push(rec);
    groups.set(name, arr);
  }

  const out: DefaultBranchJob[] = [];
  for (const [name, records] of groups) {
    const sorted = [...records].sort(
      (a, b) => Date.parse(b.workflow.created_at) - Date.parse(a.workflow.created_at),
    );
    const newest = sorted[0]!;
    const newestStartMs = Date.parse(newest.workflow.created_at);
    if (opts.now - newestStartMs > opts.windowMs) continue;
    const completed = sorted.find((r) => {
      const s = mapCircleStatus(r.workflow.status);
      return s === "success" || s === "failed" || s === "canceled" || s === "blocked";
    });
    out.push({
      key: `${opts.repo}::circle::${name}`,
      repo: opts.repo,
      branch: opts.branch,
      name,
      latest: circleWorkflowToRun(newest, opts.org, opts.repo, opts.durationStats, opts.now),
      lastCompleted: completed
        ? circleWorkflowToRun(completed, opts.org, opts.repo, opts.durationStats, opts.now)
        : undefined,
    });
  }
  return out;
}

const CIRCLE_STATUS_MAP: Record<string, DefaultBranchJobRun["status"]> = {
  success: "success",
  running: "running",
  not_run: "unknown",
  failed: "failed",
  error: "failed",
  failing: "failed",
  on_hold: "blocked",
  blocked: "blocked",
  canceled: "canceled",
  cancelled: "canceled",
  unauthorized: "blocked",
  queued: "queued",
  not_running: "queued",
  retried: "running",
};

function mapCircleStatus(raw: string | undefined): DefaultBranchJobRun["status"] {
  if (!raw) return "unknown";
  return CIRCLE_STATUS_MAP[raw] ?? "unknown";
}

function circleWorkflowToRun(
  rec: CircleWorkflowRecord,
  org: string,
  repo: string,
  durationStats: JobDurationStats,
  now: number,
): DefaultBranchJobRun {
  const status = mapCircleStatus(rec.workflow.status);
  const startMs = Date.parse(rec.workflow.created_at);
  const stopMs = rec.workflow.stopped_at ? Date.parse(rec.workflow.stopped_at) : undefined;
  const isTerminal = status === "success" || status === "failed" || status === "canceled" || status === "blocked";
  const finishedMs = stopMs ?? (isTerminal ? startMs : undefined);
  const elapsedMs = Math.max(0, (finishedMs ?? now) - startMs);
  const statsKey = `${repo}::default-branch-circle::${rec.workflow.name}`;
  if (status === "success" && elapsedMs > 0) durationStats.record(statsKey, elapsedMs);
  const estimatedDurationMs = durationStats.estimate(statsKey);
  const progressPct = isTerminal
    ? 100
    : estimatedDurationMs && estimatedDurationMs > 0
      ? Math.max(0, Math.min(99, Math.round((elapsedMs / estimatedDurationMs) * 100)))
      : 50;
  const repoForUrl = repo.includes("/") ? repo : `${org}/${repo}`;
  const repoSlug = repoForUrl.replace(/^[^/]+\//, "");
  return {
    status,
    url: `https://app.circleci.com/pipelines/github/${org}/${repoSlug}/${rec.pipeline.number}/workflows/${rec.workflow.id}`,
    headSha: rec.pipeline.commit,
    startedAt: new Date(startMs).toISOString(),
    stoppedAt: stopMs ? new Date(stopMs).toISOString() : undefined,
    elapsedMs,
    estimatedDurationMs,
    progressPct,
  };
}

function workflowRunToJobRun(
  r: RawWorkflowRun,
  repo: string,
  durationStats: JobDurationStats,
  now: number,
): DefaultBranchJobRun {
  const status = mapRunStatus(r.status, r.conclusion);
  const startMs = r.startedAt ? Date.parse(r.startedAt) : Date.parse(r.createdAt);
  const isTerminal = status === "success" || status === "failed" || status === "canceled" || status === "blocked";
  // GitHub bumps updatedAt for non-terminal events too, so only trust it as
  // the stop time once the run actually finished.
  const stopMs = isTerminal && r.updatedAt ? Date.parse(r.updatedAt) : undefined;
  const elapsedMs = Math.max(0, (stopMs ?? now) - startMs);
  const statsKey = `${repo}::default-branch::${r.workflowName}`;
  if (status === "success" && elapsedMs > 0) durationStats.record(statsKey, elapsedMs);
  const estimatedDurationMs = durationStats.estimate(statsKey);
  const progressPct = isTerminal
    ? 100
    : estimatedDurationMs && estimatedDurationMs > 0
      ? Math.max(0, Math.min(99, Math.round((elapsedMs / estimatedDurationMs) * 100)))
      : 50;
  return {
    status,
    url: r.url,
    headSha: r.headSha,
    startedAt: new Date(startMs).toISOString(),
    stoppedAt: stopMs ? new Date(stopMs).toISOString() : undefined,
    elapsedMs,
    estimatedDurationMs,
    progressPct,
  };
}

/**
 * Merge a CircleCI pipeline status with a synthetic GitHub Actions one. The
 * CircleCI pipeline is authoritative for any workflow it covers; GitHub
 * workflows are appended for anything CircleCI doesn't include.
 */
export function mergePipelines(
  primary: CiPipelineStatus | undefined,
  secondary: CiPipelineStatus | undefined,
): CiPipelineStatus | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const workflows = [...primary.workflows, ...secondary.workflows];
  const rolledUp = rollUp(workflows.map((w) => w.status));
  const elapsedMs = Math.max(primary.elapsedMs, secondary.elapsedMs);
  const estimates = [primary.estimatedTotalMs, secondary.estimatedTotalMs].filter(
    (n): n is number => typeof n === "number",
  );
  const estimatedTotalMs = estimates.length > 0 ? Math.max(...estimates) : undefined;
  const progressPct = aggregateProgress(workflows, rolledUp);
  return {
    provider: primary.provider,
    pipelineId: primary.pipelineId,
    pipelineNumber: primary.pipelineNumber,
    commit: primary.commit,
    branch: primary.branch,
    workflows,
    rolledUp,
    progressPct,
    elapsedMs,
    estimatedTotalMs,
    url: primary.url,
  };
}
