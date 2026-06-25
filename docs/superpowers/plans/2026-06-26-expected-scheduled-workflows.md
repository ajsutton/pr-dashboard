# Expected / Scheduled Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the expected set of CI workflows (CircleCI + GitHub Actions) for pinned repos in the Projects board, each annotated with when it last ran, so a scheduled job that has stopped firing or never fired is visible.

**Architecture:** A new slow (~5 min) poller loop builds, per pinned repo, an "expected workflow" list from the committed CircleCI config (`.circleci/**/*.yml` scan) unioned with CircleCI Insights actuals, plus the GitHub Actions workflows API. Pure builders in a new `project-workflows.ts` turn raw API/file data into `ProjectWorkflow` records, which a pure merge folds into the existing `defaultBranchJobs` array. The existing job card renders three states (in-window run / older last run / last run not found), with scheduled workflows grouped first.

**Tech Stack:** Bun + TypeScript server, vanilla-JS client, `bun:test`. YAML via native `Bun.YAML.parse` (Bun 1.3+). No new dependencies.

## Global Constraints

- **All tests must pass before committing:** `bun test`. Run with `eval "$(mise activate zsh)"` first (bun is on the mise PATH, not the default PATH).
- **No new runtime dependencies.** Use `Bun.YAML.parse` for YAML; native `fetch` for HTTP.
- **Pure builders are unit-tested; network clients are thin wrappers** that fetch then delegate to an exported pure parser. Keep all mapping logic in pure functions so it is testable without the network.
- **Clients are injectable interfaces** (`DashboardGitHubClient`, `CircleCiClient`); tests pass fakes — never hit the real network in tests.
- **Scope: pinned repos only** (`DASHBOARD_REPOS`). Feature is on by default; `DASHBOARD_PROJECT_WORKFLOWS=0` disables it; `DASHBOARD_PROJECT_WORKFLOWS_MS` (default `300000`) sets the slow interval.
- **Visualization only** — no overdue/threshold/cron-cadence logic.
- Follow existing file conventions: pure functions exported from `src/lib/*.ts`, raw-shape interfaces named `Raw*`, `cat -n`-style code matching surrounding style.

---

## File Structure

- **Create** `src/lib/project-workflows.ts` — pure builders: config scan → defined set + scheduled flag; Insights → CircleCI `ProjectWorkflow[]`; Actions raw → GitHub `ProjectWorkflow[]`; merge `ProjectWorkflow[]` into `DefaultBranchJob[]`. Owns the `ProjectWorkflow` type and the `Raw*` shapes for Insights/Actions.
- **Create** `src/lib/project-workflows.test.ts` — unit tests for all of the above.
- **Modify** `src/types.ts` — make `DefaultBranchJob.latest` optional; add `provider`, `expected`, `scheduled`, `disabledState`, `lastRun`.
- **Modify** `src/lib/circleci.ts` — add `getInsightsWorkflows` + `getInsightsWorkflowRuns` to the `CircleCiClient` interface and `RealCircleCiClient`; export raw Insights shapes.
- **Modify** `src/lib/dashboard-github.ts` — add `listCircleConfigFiles`, `fetchActionsWorkflows`, `fetchLatestWorkflowRun`, `fetchTextFile` to `DashboardGitHubClient` + `RealDashboardGitHubClient`; export raw Actions shapes.
- **Modify** `src/lib/github-checks.ts` — set `provider` on the `DefaultBranchJob`s built by `buildDefaultBranchJobs` ("github") and `buildCircleDefaultBranchJobs` ("circleci").
- **Modify** `src/lib/dashboard-poller.ts` — new `refreshProjectWorkflows()` slow loop, `expectedByRepo` state, merge in `attachCiToCards`, pinned-only + env gating.
- **Modify** `src/client/jobsort.js` + `src/client/jobsort.test.js` — extend ordering: scheduled first, then existing rank, then oldest-last-run first.
- **Modify** `src/client/dashboard.js` — `renderJobCard` three states + scheduled badge; `renderJobs` sort using the new comparator.
- **Modify** `src/client/dashboard.test.js` — render-state tests.
- **Modify** `public/dashboard.css` — scheduled badge + "last run not found" styling.
- **Modify** `README.md` — env-var table.

---

### Task 1: CircleCI config scan → defined set + scheduled classification

**Files:**
- Create: `src/lib/project-workflows.ts`
- Test: `src/lib/project-workflows.test.ts`

**Interfaces:**
- Consumes: nothing (pure, takes YAML strings).
- Produces:
  - `interface CircleConfigFile { path: string; content: string }`
  - `interface DefinedWorkflow { name: string; scheduled: boolean }`
  - `function scanCircleWorkflows(files: CircleConfigFile[]): DefinedWorkflow[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/project-workflows.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { scanCircleWorkflows, type CircleConfigFile } from "./project-workflows.ts";

describe("scanCircleWorkflows", () => {
  test("unions workflow names across files, excludes version, dedupes", () => {
    const files: CircleConfigFile[] = [
      { path: ".circleci/config.yml", content: "version: 2.1\nworkflows:\n  build:\n    jobs: [a]\n" },
      { path: ".circleci/continue/main.yml", content: "workflows:\n  build:\n    jobs: [a]\n  deploy:\n    jobs: [b]\n" },
    ];
    const got = scanCircleWorkflows(files).map((w) => w.name).sort();
    expect(got).toEqual(["build", "deploy"]);
  });

  test("skips files that fail to parse or have no workflows map", () => {
    const files: CircleConfigFile[] = [
      { path: "a.yml", content: ": : not valid yaml : :" },
      { path: "b.yml", content: "jobs:\n  only-jobs:\n    steps: []\n" },
      { path: "c.yml", content: "workflows:\n  real:\n    jobs: [x]\n" },
    ];
    expect(scanCircleWorkflows(files).map((w) => w.name)).toEqual(["real"]);
  });

  test("flags legacy cron trigger as scheduled", () => {
    const content = "workflows:\n  nightly:\n    triggers:\n      - schedule:\n          cron: \"0 0 * * *\"\n          filters: {}\n    jobs: [a]\n";
    const got = scanCircleWorkflows([{ path: "x.yml", content }]);
    expect(got).toEqual([{ name: "nightly", scheduled: true }]);
  });

  test("flags when-condition referencing pipeline.schedule as scheduled", () => {
    const content = "workflows:\n  wf:\n    when: << pipeline.schedule.name >>\n    jobs: [a]\n";
    expect(scanCircleWorkflows([{ path: "x.yml", content }])[0]!.scheduled).toBe(true);
  });

  test("flags when-condition referencing a schedule-named parameter", () => {
    const content = "workflows:\n  wf:\n    when:\n      or:\n        - equal: [true, << pipeline.parameters.run_scheduled_weekly_tests >>]\n    jobs: [a]\n";
    expect(scanCircleWorkflows([{ path: "x.yml", content }])[0]!.scheduled).toBe(true);
  });

  test("plain PR-triggered workflow is not scheduled", () => {
    const content = "workflows:\n  pr:\n    jobs: [a]\n";
    expect(scanCircleWorkflows([{ path: "x.yml", content }])[0]!.scheduled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `eval "$(mise activate zsh)" && bun test src/lib/project-workflows.test.ts`
Expected: FAIL — cannot find module `./project-workflows.ts` / `scanCircleWorkflows is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/project-workflows.ts`:

```ts
/**
 * Pure builders for the "expected / scheduled workflows" Projects view.
 *
 * No network here — the poller fetches raw config files + API payloads and
 * hands them to these functions, which is what makes them unit-testable.
 */

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `eval "$(mise activate zsh)" && bun test src/lib/project-workflows.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-workflows.ts src/lib/project-workflows.test.ts
git commit -m "Add CircleCI config workflow scan + scheduled classification"
```

---

### Task 2: Map CircleCI Insights → ProjectWorkflow[]

**Files:**
- Modify: `src/lib/project-workflows.ts`
- Test: `src/lib/project-workflows.test.ts`

**Interfaces:**
- Consumes: `DefinedWorkflow` (Task 1); `CiJobStatusValue` from `../types.ts`.
- Produces:
  - `interface RawInsightsRun { status: string; created_at?: string; stopped_at?: string }`
  - `interface ProjectWorkflow { repo: string; provider: "circleci" | "github"; name: string; scheduled: boolean; disabledState?: "disabled_manually" | "disabled_inactivity"; lastRun: ProjectLastRun }`
  - `interface ProjectLastRun { found: boolean; status?: CiJobStatusValue; at?: string; url?: string }`
  - `function buildCircleProjectWorkflows(args: { repo: string; org: string; defined: DefinedWorkflow[]; ranWorkflowNames: Set<string>; runsByName: Record<string, RawInsightsRun[]> }): ProjectWorkflow[]`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/project-workflows.test.ts`:

```ts
import { buildCircleProjectWorkflows } from "./project-workflows.ts";

describe("buildCircleProjectWorkflows", () => {
  const base = { repo: "o/r", org: "o" };

  test("maps last run from newest insights item", () => {
    const out = buildCircleProjectWorkflows({
      ...base,
      defined: [{ name: "main", scheduled: false }],
      ranWorkflowNames: new Set(["main"]),
      runsByName: {
        main: [
          { status: "success", created_at: "2026-06-20T00:00:00Z", stopped_at: "2026-06-20T00:05:00Z" },
          { status: "failed", created_at: "2026-06-10T00:00:00Z", stopped_at: "2026-06-10T00:05:00Z" },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.lastRun).toEqual({
      found: true,
      status: "success",
      at: "2026-06-20T00:05:00Z",
      url: "https://app.circleci.com/pipelines/github/o/r",
    });
  });

  test("defined workflow that never ran → found:false, no per-workflow data needed", () => {
    const out = buildCircleProjectWorkflows({
      ...base,
      defined: [{ name: "weekly", scheduled: true }],
      ranWorkflowNames: new Set(),
      runsByName: {},
    });
    expect(out[0]!).toMatchObject({ name: "weekly", scheduled: true, provider: "circleci", lastRun: { found: false } });
  });

  test("workflow that ran but is not in defined set is still included", () => {
    const out = buildCircleProjectWorkflows({
      ...base,
      defined: [],
      ranWorkflowNames: new Set(["setup"]),
      runsByName: { setup: [{ status: "success", created_at: "2026-06-20T00:00:00Z", stopped_at: "2026-06-20T00:01:00Z" }] },
    });
    expect(out.map((w) => w.name)).toEqual(["setup"]);
    expect(out[0]!.lastRun.found).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `eval "$(mise activate zsh)" && bun test src/lib/project-workflows.test.ts`
Expected: FAIL — `buildCircleProjectWorkflows is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to the top of `src/lib/project-workflows.ts` (after existing imports — add the import line):

```ts
import type { CiJobStatusValue } from "../types.ts";
```

Append:

```ts
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
  ranWorkflowNames: Set<string>;
  runsByName: Record<string, RawInsightsRun[]>;
}): ProjectWorkflow[] {
  const scheduledByName = new Map(args.defined.map((d) => [d.name, d.scheduled]));
  const names = new Set<string>([...args.defined.map((d) => d.name), ...args.ranWorkflowNames]);
  const projectUrl = `https://app.circleci.com/pipelines/github/${args.org}/${args.repo.replace(/^[^/]+\//, "")}`;

  const out: ProjectWorkflow[] = [];
  for (const name of names) {
    const runs = args.runsByName[name] ?? [];
    const newest = runs[0];
    const lastRun: ProjectLastRun = newest
      ? {
          found: true,
          status: mapInsightsStatus(newest.status),
          at: newest.stopped_at ?? newest.created_at,
          url: projectUrl,
        }
      : { found: false };
    out.push({
      repo: args.repo,
      provider: "circleci",
      name,
      scheduled: scheduledByName.get(name) ?? false,
      lastRun,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `eval "$(mise activate zsh)" && bun test src/lib/project-workflows.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-workflows.ts src/lib/project-workflows.test.ts
git commit -m "Map CircleCI Insights runs to ProjectWorkflow records"
```

---

### Task 3: Map GitHub Actions → ProjectWorkflow[]

**Files:**
- Modify: `src/lib/project-workflows.ts`
- Test: `src/lib/project-workflows.test.ts`

**Interfaces:**
- Consumes: `ProjectWorkflow`, `ProjectLastRun` (Task 2).
- Produces:
  - `interface RawActionsWorkflow { id: number; name: string; path: string; state: string }`
  - `interface RawActionsRun { status: string; conclusion?: string | null; updated_at?: string; created_at?: string; html_url?: string }`
  - `interface ActionsWorkflowInput { workflow: RawActionsWorkflow; fileContent?: string | undefined; latestRun?: RawActionsRun | undefined }`
  - `function buildActionsProjectWorkflows(repo: string, inputs: ActionsWorkflowInput[]): ProjectWorkflow[]`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/project-workflows.test.ts`:

```ts
import { buildActionsProjectWorkflows } from "./project-workflows.ts";

describe("buildActionsProjectWorkflows", () => {
  test("maps latest run conclusion + time + url", () => {
    const out = buildActionsProjectWorkflows("o/r", [
      {
        workflow: { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
        fileContent: "on:\n  push:\n",
        latestRun: { status: "completed", conclusion: "success", updated_at: "2026-06-20T00:05:00Z", html_url: "https://x/run/1" },
      },
    ]);
    expect(out[0]!).toMatchObject({
      repo: "o/r",
      provider: "github",
      name: "CI",
      scheduled: false,
      lastRun: { found: true, status: "success", at: "2026-06-20T00:05:00Z", url: "https://x/run/1" },
    });
  });

  test("on: schedule in the file marks it scheduled", () => {
    const out = buildActionsProjectWorkflows("o/r", [
      {
        workflow: { id: 2, name: "Nightly", path: ".github/workflows/nightly.yml", state: "active" },
        fileContent: "on:\n  schedule:\n    - cron: '0 0 * * *'\n",
        latestRun: undefined,
      },
    ]);
    expect(out[0]!).toMatchObject({ name: "Nightly", scheduled: true, lastRun: { found: false } });
  });

  test("carries disabled state", () => {
    const out = buildActionsProjectWorkflows("o/r", [
      { workflow: { id: 3, name: "Old", path: ".github/workflows/old.yml", state: "disabled_inactivity" }, latestRun: undefined },
    ]);
    expect(out[0]!.disabledState).toBe("disabled_inactivity");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `eval "$(mise activate zsh)" && bun test src/lib/project-workflows.test.ts`
Expected: FAIL — `buildActionsProjectWorkflows is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/project-workflows.ts`:

```ts
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

function mapActionsStatus(status: string, conclusion: string | null | undefined): CiJobStatusValue {
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

function actionsScheduled(fileContent: string | undefined): boolean {
  if (!fileContent) return false;
  let doc: unknown;
  try {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `eval "$(mise activate zsh)" && bun test src/lib/project-workflows.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-workflows.ts src/lib/project-workflows.test.ts
git commit -m "Map GitHub Actions workflows to ProjectWorkflow records"
```

---

### Task 4: Extend `DefaultBranchJob` type + merge ProjectWorkflows into jobs

**Files:**
- Modify: `src/types.ts:92-103` (the `DefaultBranchJob` interface)
- Modify: `src/lib/github-checks.ts` (set `provider` on built jobs)
- Modify: `src/lib/project-workflows.ts` (add the merge fn)
- Test: `src/lib/project-workflows.test.ts`

**Interfaces:**
- Consumes: `DefaultBranchJob` (now with new fields), `ProjectWorkflow` (Task 2).
- Produces: `function mergeProjectWorkflows(jobs: DefaultBranchJob[], expected: ProjectWorkflow[]): DefaultBranchJob[]`

- [ ] **Step 1: Extend the type**

In `src/types.ts`, replace the `DefaultBranchJob` interface (currently lines ~92-103) with:

```ts
export interface DefaultBranchJob {
  /** Stable identity for view-transition / DOM diffing. */
  key: string;
  repo: string;
  branch: string;
  /** Workflow name (GitHub Actions workflow or CircleCI workflow). */
  name: string;
  /** Most recent run within the recent-runs window. Absent for an expected
   *  workflow that has not run recently. */
  latest?: DefaultBranchJobRun | undefined;
  /** Most recent *completed* run within the window. */
  lastCompleted?: DefaultBranchJobRun | undefined;
  /** CI provider, used to key the merge against expected workflows. */
  provider?: "circleci" | "github" | undefined;
  /** True when this workflow appears in the committed config / Actions list. */
  expected?: boolean | undefined;
  /** True when the workflow is schedule-driven. */
  scheduled?: boolean | undefined;
  /** GitHub Actions disabled state, when applicable. */
  disabledState?: "disabled_manually" | "disabled_inactivity" | undefined;
  /** Long-lookback last run, used when there is no in-window `latest`.
   *  `found: false` → render "last run not found". */
  lastRun?: { found: boolean; status?: CiJobStatusValue; at?: string; url?: string } | undefined;
}
```

- [ ] **Step 2: Run typecheck to confirm `latest?` optional change compiles**

Run: `eval "$(mise activate zsh)" && bun run typecheck`
Expected: PASS (no errors — `latest` was always set by existing builders, so making it optional is safe).

- [ ] **Step 3: Set `provider` on existing builders**

In `src/lib/github-checks.ts`, in `buildDefaultBranchJobs` add `provider: "github",` to the pushed object (inside `out.push({ ... })`), and in `buildCircleDefaultBranchJobs` add `provider: "circleci",` to its pushed object. Example for the GitHub one:

```ts
    out.push({
      key: `${opts.repo}::wf-${workflowId}`,
      repo: opts.repo,
      branch: opts.branch,
      name: newest.workflowName,
      provider: "github",
      latest: workflowRunToJobRun(newest, opts.repo, opts.durationStats, opts.now),
      lastCompleted: completed
        ? workflowRunToJobRun(completed, opts.repo, opts.durationStats, opts.now)
        : undefined,
    });
```

And for CircleCI:

```ts
    out.push({
      key: `${opts.repo}::circle::${name}`,
      repo: opts.repo,
      branch: opts.branch,
      name,
      provider: "circleci",
      latest: circleWorkflowToRun(newest, opts.org, opts.repo, opts.durationStats, opts.now),
      lastCompleted: completed
        ? circleWorkflowToRun(completed, opts.org, opts.repo, opts.durationStats, opts.now)
        : undefined,
    });
```

- [ ] **Step 4: Write the failing merge test**

Append to `src/lib/project-workflows.test.ts`:

```ts
import { mergeProjectWorkflows } from "./project-workflows.ts";
import type { DefaultBranchJob } from "../types.ts";
import type { ProjectWorkflow } from "./project-workflows.ts";

describe("mergeProjectWorkflows", () => {
  const recentJob: DefaultBranchJob = {
    key: "o/r::circle::main",
    repo: "o/r",
    branch: "develop",
    name: "main",
    provider: "circleci",
    latest: {
      status: "success", url: "u", headSha: "s",
      startedAt: "2026-06-26T00:00:00Z", elapsedMs: 1000, progressPct: 100,
    },
  };

  test("annotates an existing recent-run job, keeps its latest", () => {
    const expected: ProjectWorkflow[] = [
      { repo: "o/r", provider: "circleci", name: "main", scheduled: false, lastRun: { found: true, status: "success", at: "2026-06-26T00:00:00Z" } },
    ];
    const out = mergeProjectWorkflows([recentJob], expected);
    expect(out).toHaveLength(1);
    expect(out[0]!.latest).toBeDefined();
    expect(out[0]!.expected).toBe(true);
  });

  test("adds an expected-only workflow as a latest-less card", () => {
    const expected: ProjectWorkflow[] = [
      { repo: "o/r", provider: "circleci", name: "weekly", scheduled: true, lastRun: { found: false } },
    ];
    const out = mergeProjectWorkflows([recentJob], expected);
    const weekly = out.find((j) => j.name === "weekly")!;
    expect(weekly.latest).toBeUndefined();
    expect(weekly).toMatchObject({ expected: true, scheduled: true, provider: "circleci", lastRun: { found: false } });
    expect(weekly.key).toBe("o/r::circleci::weekly");
  });

  test("does not merge across providers with the same name", () => {
    const ghExpected: ProjectWorkflow[] = [
      { repo: "o/r", provider: "github", name: "main", scheduled: false, lastRun: { found: true, status: "failed", at: "2026-06-25T00:00:00Z" } },
    ];
    const out = mergeProjectWorkflows([recentJob], ghExpected);
    expect(out).toHaveLength(2); // circleci "main" (recent) + github "main" (expected)
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `eval "$(mise activate zsh)" && bun test src/lib/project-workflows.test.ts`
Expected: FAIL — `mergeProjectWorkflows is not a function`.

- [ ] **Step 6: Write minimal implementation**

Add the import at the top of `src/lib/project-workflows.ts`:

```ts
import type { DefaultBranchJob } from "../types.ts";
```

Append:

```ts
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
      existing.expected = true;
      existing.scheduled = e.scheduled;
      if (e.disabledState) existing.disabledState = e.disabledState;
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
```

- [ ] **Step 7: Run full test suite**

Run: `eval "$(mise activate zsh)" && bun test`
Expected: PASS (existing + 15 project-workflows tests).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/lib/github-checks.ts src/lib/project-workflows.ts src/lib/project-workflows.test.ts
git commit -m "Merge expected workflows into default-branch job list"
```

---

### Task 5: Ordering — scheduled first, then rank, then oldest-last-run

**Files:**
- Modify: `src/client/jobsort.js`
- Test: `src/client/jobsort.test.js`

**Interfaces:**
- Consumes: a `DefaultBranchJob`-shaped object (`scheduled`, `latest`, `lastRun`, existing rank inputs).
- Produces: `export function projectJobCompare(a, b, repoOrder)` returning a sort number. (Keep existing `jobSortRank` export unchanged.)

- [ ] **Step 1: Read the current file**

Read `src/client/jobsort.js` to learn the exact `jobSortRank` signature and what fields it reads. The new comparator must call it for the middle tier.

- [ ] **Step 2: Write the failing test**

Append to `src/client/jobsort.test.js` (match the file's existing import style):

```js
import { test, expect, describe } from "bun:test";
import { projectJobCompare } from "./jobsort.js";

describe("projectJobCompare", () => {
  const repoOrder = new Map([["o/r", 0]]);
  const mk = (over) => ({ repo: "o/r", branch: "", name: "n", ...over });

  test("scheduled sorts before non-scheduled", () => {
    const sched = mk({ name: "weekly", scheduled: true, lastRun: { found: false } });
    const plain = mk({ name: "ci", latest: { status: "success", progressPct: 100 } });
    expect(projectJobCompare(sched, plain, repoOrder)).toBeLessThan(0);
  });

  test("within scheduled, never-run/oldest sorts first", () => {
    const never = mk({ name: "a", scheduled: true, lastRun: { found: false } });
    const recent = mk({ name: "b", scheduled: true, lastRun: { found: true, at: "2026-06-26T00:00:00Z" } });
    expect(projectJobCompare(never, recent, repoOrder)).toBeLessThan(0);
  });

  test("older last-run sorts before newer", () => {
    const old = mk({ name: "a", scheduled: true, lastRun: { found: true, at: "2026-06-01T00:00:00Z" } });
    const fresh = mk({ name: "b", scheduled: true, lastRun: { found: true, at: "2026-06-25T00:00:00Z" } });
    expect(projectJobCompare(old, fresh, repoOrder)).toBeLessThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `eval "$(mise activate zsh)" && bun test src/client/jobsort.test.js`
Expected: FAIL — `projectJobCompare is not a function`.

- [ ] **Step 4: Write minimal implementation**

Append to `src/client/jobsort.js` (uses the existing `jobSortRank` defined in the same file):

```js
/**
 * Sort comparator for the Projects grid once expected/scheduled workflows are
 * folded in. Tiers, in order:
 *   1. scheduled workflows before non-scheduled
 *   2. existing jobSortRank (failures/running first)
 *   3. oldest "last run" first (never-run counts as oldest) so stale jobs float up
 *   4. server repo order, then name
 */
export function projectJobCompare(a, b, repoOrder) {
  const sa = a.scheduled ? 0 : 1;
  const sb = b.scheduled ? 0 : 1;
  if (sa !== sb) return sa - sb;

  const ra = jobSortRank(a);
  const rb = jobSortRank(b);
  if (ra !== rb) return ra - rb;

  const ta = lastRunMs(a);
  const tb = lastRunMs(b);
  if (ta !== tb) return ta - tb;

  const ria = repoOrder.get(a.repo) ?? 1e6;
  const rib = repoOrder.get(b.repo) ?? 1e6;
  if (ria !== rib) return ria - rib;
  if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
  return a.name.localeCompare(b.name);
}

function lastRunMs(job) {
  // In-window run wins; else the long-lookback lastRun; else never (0 = oldest).
  if (job.latest && job.latest.startedAt) return Date.parse(job.latest.startedAt) || 0;
  if (job.lastRun && job.lastRun.found && job.lastRun.at) return Date.parse(job.lastRun.at) || 0;
  return 0;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `eval "$(mise activate zsh)" && bun test src/client/jobsort.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/jobsort.js src/client/jobsort.test.js
git commit -m "Add Projects ordering: scheduled first, oldest last-run first"
```

---

### Task 6: Render three card states + scheduled badge

**Files:**
- Modify: `src/client/dashboard.js` (`renderJobCard` ~686-732, `renderJobs` ~734-755)
- Modify: `public/dashboard.css`
- Test: `src/client/dashboard.test.js`

**Interfaces:**
- Consumes: `DefaultBranchJob` with `latest?`, `lastRun?`, `scheduled`, `disabledState`.
- Produces: updated `renderJobCard` (exported if not already; export it for the test).

- [ ] **Step 1: Confirm export + read render code**

Read `src/client/dashboard.js` around `renderJobCard`/`renderJobs` and check `src/client/dashboard.test.js` for how DOM-producing functions are tested (look for existing `renderJobCard` or similar import). If `renderJobCard` is not exported, add `export` to it.

- [ ] **Step 2: Write the failing test**

Append to `src/client/dashboard.test.js` (match its import/setup style):

```js
import { renderJobCard } from "./dashboard.js";

describe("renderJobCard expected/scheduled states", () => {
  test("older last run shows age + status, no progress bar", () => {
    const html = renderJobCard({
      key: "o/r::circleci::weekly", repo: "o/r", branch: "", name: "weekly",
      provider: "circleci", expected: true, scheduled: true,
      lastRun: { found: true, status: "success", at: new Date(Date.now() - 9 * 86400000).toISOString(), url: "u" },
    });
    expect(html).toContain("weekly");
    expect(html).toContain("9d");
    expect(html).not.toContain("db-bar-fill");
    expect(html).toContain("db-job-sched"); // scheduled badge marker
  });

  test("never run shows 'last run not found'", () => {
    const html = renderJobCard({
      key: "o/r::circleci::weekly", repo: "o/r", branch: "", name: "weekly",
      provider: "circleci", expected: true, scheduled: true,
      lastRun: { found: false },
    });
    expect(html).toContain("last run not found");
  });

  test("in-window run still renders the normal card", () => {
    const html = renderJobCard({
      key: "o/r::circleci::main", repo: "o/r", branch: "develop", name: "main", provider: "circleci",
      latest: { status: "running", url: "u", headSha: "s", startedAt: new Date().toISOString(), elapsedMs: 1000, progressPct: 42 },
    });
    expect(html).toContain("db-bar-fill");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `eval "$(mise activate zsh)" && bun test src/client/dashboard.test.js`
Expected: FAIL — `renderJobCard` not exported / no handling for `lastRun`.

- [ ] **Step 4: Implement the three states**

In `src/client/dashboard.js`, replace `renderJobCard` so it branches on `job.latest`. Keep the existing in-window branch verbatim for when `job.latest` is present; add the expected-only branch. The scheduled badge (`db-job-sched`) renders whenever `job.scheduled`. Full replacement:

```js
function schedBadge(job) {
  return job.scheduled ? `<span class="db-job-sched" title="scheduled">⏱</span>` : "";
}

export function renderJobCard(job) {
  const slash = job.repo.indexOf("/");
  const repoOwner = slash >= 0 ? job.repo.slice(0, slash) : "";
  const repoName = slash >= 0 ? job.repo.slice(slash + 1) : job.repo;
  const branch = job.branch || "";
  const vt = `db-job-${job.key.replace(/[^a-zA-Z0-9-]/g, "_")}`;

  // Expected workflow with no in-window run: render a last-run / not-found card.
  if (!job.latest) {
    const lr = job.lastRun || { found: false };
    const tone = lr.found ? jobTone(lr.status) : "muted";
    const ageText = lr.found && lr.at ? `last ran ${fmtAge(Date.now() - Date.parse(lr.at))} ago` : "last run not found";
    const disabled = job.disabledState ? `<span class="db-job-disabled">disabled</span>` : "";
    const href = lr.url || "#";
    return `
    <article class="db-job db-job-expected" data-head-tone="${tone}" data-foot-tone="${tone}" data-job-key="${escapeAttr(job.key)}" style="view-transition-name: ${vt}">
      <a class="db-job-head" href="${escapeAttr(href)}" target="_blank" rel="noopener">
        <div class="db-job-project">
          ${repoOwner ? `<span class="db-job-project-owner">${escapeHtml(repoOwner)}/</span>` : ""}<span class="db-job-project-repo">${escapeHtml(repoName)}</span>
        </div>
        <header class="db-job-meta">
          <span class="db-job-name">${schedBadge(job)}${escapeHtml(job.name || "(unnamed workflow)")}</span>
          ${disabled}
        </header>
        <div class="db-job-time">${escapeHtml(ageText)}</div>
      </a>
      <a class="db-job-foot" data-tone="${tone}" href="${escapeAttr(href)}" target="_blank" rel="noopener">
        <span class="db-job-foot-label">${lr.found ? escapeHtml(String(lr.status).toUpperCase()) : "NOT FOUND"}</span>
      </a>
    </article>`;
  }

  const latest = job.latest;
  const completed = job.lastCompleted;
  const headTone = jobTone(latest.status);
  const footTone = completed ? jobTone(completed.status) : "muted";
  const isRunning = latest.status === "running" || latest.status === "queued";
  const pct = Math.max(0, Math.min(100, Math.round(latest.progressPct ?? 0)));
  const latestElapsed = fmtAge(latest.elapsedMs);
  const latestEst = isRunning && latest.estimatedDurationMs ? ` / ${fmtAge(latest.estimatedDurationMs)}` : "";
  const headTime = isRunning ? `${pct}% · ${latestElapsed}${latestEst}` : latestElapsed;
  const bar = isRunning
    ? `<div class="db-bar"><div class="db-bar-fill" data-tone="${headTone}" style="width:${pct}%"></div></div>`
    : "";
  const completedAgo = completed?.stoppedAt ? fmtAge(Date.now() - Date.parse(completed.stoppedAt)) : "";
  const completedLabel = completed ? completed.status.toUpperCase() : "NO RECENT RESULT";
  const completedHref = completed?.url || latest.url;
  const headHref = latest.url;
  return `
    <article class="db-job" data-head-tone="${headTone}" data-foot-tone="${footTone}" data-job-key="${escapeAttr(job.key)}" style="view-transition-name: ${vt}">
      <a class="db-job-head" href="${escapeAttr(headHref)}" target="_blank" rel="noopener">
        <div class="db-job-project">
          ${repoOwner ? `<span class="db-job-project-owner">${escapeHtml(repoOwner)}/</span>` : ""}<span class="db-job-project-repo">${escapeHtml(repoName)}</span>
          ${branch ? `<span class="db-job-project-branch">${escapeHtml(branch)}</span>` : ""}
        </div>
        <header class="db-job-meta">
          <span class="db-job-name">${schedBadge(job)}${escapeHtml(job.name || "(unnamed workflow)")}</span>
          <span class="db-job-status">${escapeHtml(latest.status.toUpperCase())}</span>
        </header>
        <div class="db-job-time">${escapeHtml(headTime)}</div>
        ${bar}
      </a>
      <a class="db-job-foot" data-tone="${footTone}" href="${escapeAttr(completedHref)}" target="_blank" rel="noopener">
        <span class="db-job-foot-label">${escapeHtml(completedLabel)}</span>
        ${completedAgo ? `<span class="db-job-foot-age">${escapeHtml(completedAgo)} ago</span>` : ""}
      </a>
    </article>`;
}
```

- [ ] **Step 5: Use the new comparator in `renderJobs`**

In `src/client/dashboard.js`, add `import { projectJobCompare } from "./jobsort.js";` if `jobsort.js` exports are not already imported (check existing imports — `jobSortRank` may already be imported; add `projectJobCompare` to that import). Replace the `.sort(...)` body in `renderJobs` with:

```js
  const repoOrder = new Map((snap.repos ?? []).map((r, i) => [r, i]));
  const sorted = [...jobs].sort((a, b) => projectJobCompare(a, b, repoOrder));
```

- [ ] **Step 6: Add CSS**

Append to `public/dashboard.css`:

```css
.db-job-sched { margin-right: 0.3em; opacity: 0.85; }
.db-job-expected .db-job-time { opacity: 0.8; font-style: italic; }
.db-job-disabled,
.db-job-expected .db-job-foot-label { letter-spacing: 0.04em; }
.db-job-disabled { margin-left: 0.4em; font-size: 0.75em; opacity: 0.7; text-transform: uppercase; }
```

- [ ] **Step 7: Run tests**

Run: `eval "$(mise activate zsh)" && bun test src/client/dashboard.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/client/dashboard.js public/dashboard.css src/client/dashboard.test.js
git commit -m "Render expected/scheduled workflow card states + ordering"
```

---

### Task 7: CircleCI client — Insights methods

**Files:**
- Modify: `src/lib/circleci.ts` (`CircleCiClient` interface ~90-104, `RealCircleCiClient` ~132-237)

**Interfaces:**
- Consumes: existing `RealCircleCiClient.get<T>`.
- Produces (added to `CircleCiClient`):
  - `getInsightsWorkflowNames(org: string, repo: string): Promise<string[]>`
  - `getInsightsWorkflowRuns(org: string, repo: string, workflowName: string): Promise<RawInsightsRun[]>` (returns the `project-workflows.ts` `RawInsightsRun` shape: `{ status, created_at?, stopped_at? }`, newest first)

- [ ] **Step 1: Add to the interface**

In `src/lib/circleci.ts`, add an import:

```ts
import type { RawInsightsRun } from "./project-workflows.ts";
```

Add to the `CircleCiClient` interface:

```ts
  getInsightsWorkflowNames(org: string, repo: string): Promise<string[]>;
  getInsightsWorkflowRuns(org: string, repo: string, workflowName: string): Promise<RawInsightsRun[]>;
```

- [ ] **Step 2: Implement on `RealCircleCiClient`**

Add these methods to `RealCircleCiClient`:

```ts
  async getInsightsWorkflowNames(org: string, repo: string): Promise<string[]> {
    const data = await this.get<{ items?: Array<{ name?: string }> }>(
      `/insights/gh/${org}/${repo}/workflows?reporting-window=last-90-days`,
    );
    return (data?.items ?? []).map((i) => i.name ?? "").filter(Boolean);
  }

  async getInsightsWorkflowRuns(org: string, repo: string, workflowName: string): Promise<RawInsightsRun[]> {
    const data = await this.get<{ items?: Array<{ status?: string; created_at?: string; stopped_at?: string }> }>(
      `/insights/gh/${org}/${repo}/workflows/${encodeURIComponent(workflowName)}?reporting-window=last-90-days`,
    );
    return (data?.items ?? []).map((i) => ({ status: i.status ?? "", created_at: i.created_at, stopped_at: i.stopped_at }));
  }
```

- [ ] **Step 3: Typecheck**

Run: `eval "$(mise activate zsh)" && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Smoke-check against the live public project (manual, not a unit test)**

Run: `curl -s "https://circleci.com/api/v2/insights/gh/ethereum-optimism/optimism/workflows?reporting-window=last-90-days" | head -c 200`
Expected: JSON with an `items` array containing `name`. (Confirms the path shape the code builds.)

- [ ] **Step 5: Run full suite (ensures interface addition didn't break fakes)**

Run: `eval "$(mise activate zsh)" && bun test`
Expected: PASS. (If a test fake implements `CircleCiClient`, add the two methods returning `[]` — search `implements CircleCiClient` and any `circle:` test doubles.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/circleci.ts
git commit -m "Add CircleCI Insights workflow + runs client methods"
```

---

### Task 8: GitHub client — config files, Actions workflows, runs, file fetch

**Files:**
- Modify: `src/lib/dashboard-github.ts` (`DashboardGitHubClient` interface ~124-149, `RealDashboardGitHubClient` ~562+, uses existing `ghRest`)

**Interfaces:**
- Consumes: existing `ghRest(path)`.
- Produces (added to `DashboardGitHubClient`):
  - `listCircleConfigFiles(repo: string): Promise<CircleConfigFile[]>` — every `*.yml`/`*.yaml` under `.circleci/` (recursive), `{ path, content }`.
  - `fetchTextFile(repo: string, path: string): Promise<string | undefined>`
  - `fetchActionsWorkflows(repo: string): Promise<RawActionsWorkflow[]>`
  - `fetchLatestWorkflowRun(repo: string, workflowId: number): Promise<RawActionsRun | undefined>`

- [ ] **Step 1: Add imports + interface methods**

In `src/lib/dashboard-github.ts` add:

```ts
import type { CircleConfigFile, RawActionsWorkflow, RawActionsRun } from "./project-workflows.ts";
```

Add to `DashboardGitHubClient`:

```ts
  listCircleConfigFiles(repo: string): Promise<CircleConfigFile[]>;
  fetchTextFile(repo: string, path: string): Promise<string | undefined>;
  fetchActionsWorkflows(repo: string): Promise<RawActionsWorkflow[]>;
  fetchLatestWorkflowRun(repo: string, workflowId: number): Promise<RawActionsRun | undefined>;
```

- [ ] **Step 2: Implement on `RealDashboardGitHubClient`**

Add these methods (use the git Trees API to enumerate `.circleci/` in one call, then fetch each file's raw content via the contents API):

```ts
  async listCircleConfigFiles(repo: string): Promise<CircleConfigFile[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return [];
    const head = await this.fetchDefaultBranchHead(repo);
    if (!head) return [];
    const tree = (await ghRest(
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(head.branch)}?recursive=1`,
    )) as { tree?: Array<{ path?: string; type?: string }> } | undefined;
    const paths = (tree?.tree ?? [])
      .filter((t) => t.type === "blob" && typeof t.path === "string"
        && t.path.startsWith(".circleci/") && /\.ya?ml$/i.test(t.path))
      .map((t) => t.path as string);
    const files: CircleConfigFile[] = [];
    for (const path of paths) {
      const content = await this.fetchTextFile(repo, path);
      if (content != null) files.push({ path, content });
    }
    return files;
  }

  async fetchTextFile(repo: string, path: string): Promise<string | undefined> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;
    const data = (await ghRest(
      `/repos/${owner}/${name}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    )) as { content?: string; encoding?: string } | undefined;
    if (!data?.content) return undefined;
    if (data.encoding === "base64") return Buffer.from(data.content, "base64").toString("utf8");
    return data.content;
  }

  async fetchActionsWorkflows(repo: string): Promise<RawActionsWorkflow[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return [];
    const data = (await ghRest(`/repos/${owner}/${name}/actions/workflows?per_page=100`)) as
      | { workflows?: Array<{ id?: number; name?: string; path?: string; state?: string }> }
      | undefined;
    return (data?.workflows ?? [])
      .filter((w) => typeof w.id === "number")
      .map((w) => ({ id: w.id as number, name: w.name ?? "", path: w.path ?? "", state: w.state ?? "active" }));
  }

  async fetchLatestWorkflowRun(repo: string, workflowId: number): Promise<RawActionsRun | undefined> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;
    const data = (await ghRest(
      `/repos/${owner}/${name}/actions/workflows/${workflowId}/runs?per_page=1`,
    )) as { workflow_runs?: Array<Record<string, unknown>> } | undefined;
    const r = data?.workflow_runs?.[0];
    if (!r) return undefined;
    return {
      status: (r["status"] as string) ?? "",
      conclusion: (r["conclusion"] as string | null) ?? undefined,
      created_at: (r["created_at"] as string) ?? undefined,
      updated_at: (r["updated_at"] as string) ?? undefined,
      html_url: (r["html_url"] as string) ?? undefined,
    };
  }
```

- [ ] **Step 3: Typecheck**

Run: `eval "$(mise activate zsh)" && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Run full suite (add the four methods to any test fake implementing the interface)**

Run: `eval "$(mise activate zsh)" && bun test`
Expected: PASS. Search `implements DashboardGitHubClient` and any `github:` test doubles in `dashboard-poller.test.ts`; add stubs returning `[]` / `undefined` for the new methods so doubles still satisfy the interface.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard-github.ts src/lib/dashboard-poller.test.ts
git commit -m "Add GitHub client methods for config files + Actions workflows"
```

---

### Task 9: Poller — slow refresh loop, merge, env + pinned-only gating

**Files:**
- Modify: `src/lib/dashboard-poller.ts`
- Test: `src/lib/dashboard-poller.test.ts`

**Interfaces:**
- Consumes: all client methods (Tasks 7-8), `scanCircleWorkflows`/`buildCircleProjectWorkflows`/`buildActionsProjectWorkflows`/`mergeProjectWorkflows` (Tasks 1-4).
- Produces: `expectedByRepo: Map<string, ProjectWorkflow[]>` state; `refreshProjectWorkflows()`; merge applied in `attachCiToCards`.

- [ ] **Step 1: Read the poller test to learn the fake-client pattern**

Read `src/lib/dashboard-poller.test.ts` to see how `github`/`circle` fakes and `pinnedRepos` are passed, and how `onSnapshot` is asserted.

- [ ] **Step 2: Write the failing test**

Append to `src/lib/dashboard-poller.test.ts` a test that builds a poller with fakes returning: one pinned repo, a `.circleci/config.yml` defining `main` + `weekly` (weekly scheduled), Insights listing only `main`, and asserts that after `refreshProjectWorkflows()` the snapshot's `defaultBranchJobs` contains a `weekly` entry with `lastRun.found === false` and `scheduled === true`. Use the existing fake-client style from the file. Example skeleton (adapt field names to the file's existing fakes):

```js
test("refreshProjectWorkflows folds expected scheduled workflows into jobs", async () => {
  const snaps = [];
  const poller = new DashboardPoller({
    pinnedRepos: ["o/r"],
    github: makeFakeGitHub({
      defaultBranchHead: { branch: "develop", sha: "s", checks: [] },
      circleConfigFiles: [{ path: ".circleci/config.yml", content: "workflows:\n  main:\n    jobs: [a]\n  weekly:\n    when: << pipeline.schedule.name >>\n    jobs: [b]\n" }],
      actionsWorkflows: [],
    }),
    circle: makeFakeCircle({ insightsNames: ["main"], insightsRuns: { main: [{ status: "success", created_at: "2026-06-20T00:00:00Z", stopped_at: "2026-06-20T00:01:00Z" }] } }),
    onSnapshot: (s) => snaps.push(s),
  });
  await poller.refreshGitHub();
  await poller.refreshProjectWorkflows();
  const jobs = snaps.at(-1).defaultBranchJobs;
  const weekly = jobs.find((j) => j.name === "weekly");
  expect(weekly).toBeTruthy();
  expect(weekly.scheduled).toBe(true);
  expect(weekly.lastRun.found).toBe(false);
});
```

(If the file has no `makeFakeGitHub`/`makeFakeCircle` helpers, extend the existing inline fake objects with the new methods instead — the key point is the fakes return the values above.)

- [ ] **Step 3: Run test to verify it fails**

Run: `eval "$(mise activate zsh)" && bun test src/lib/dashboard-poller.test.ts`
Expected: FAIL — `refreshProjectWorkflows is not a function`.

- [ ] **Step 4: Implement the loop + state + merge + gating**

In `src/lib/dashboard-poller.ts`:

Add imports:

```ts
import {
  scanCircleWorkflows,
  buildCircleProjectWorkflows,
  buildActionsProjectWorkflows,
  mergeProjectWorkflows,
  type ProjectWorkflow,
  type ActionsWorkflowInput,
} from "./project-workflows.ts";
```

Add constants near the other cadence constants:

```ts
const PROJECT_WORKFLOWS_MS = Number(process.env.DASHBOARD_PROJECT_WORKFLOWS_MS) || 300_000;
const PROJECT_WORKFLOWS_ENABLED = process.env.DASHBOARD_PROJECT_WORKFLOWS !== "0";
```

Add state fields to the class:

```ts
  private expectedByRepo = new Map<string, ProjectWorkflow[]>();
  private projectWorkflowsTimer: ReturnType<typeof setTimeout> | null = null;
```

In `start()`, after `this.scheduleCi();`, add:

```ts
    if (PROJECT_WORKFLOWS_ENABLED && this.pinnedRepos.length > 0) {
      await this.refreshProjectWorkflows();
      this.scheduleProjectWorkflows();
    }
```

In `stop()`, add `if (this.projectWorkflowsTimer) clearTimeout(this.projectWorkflowsTimer);`.

Add the scheduler + refresh:

```ts
  private scheduleProjectWorkflows(): void {
    if (this.stopped) return;
    this.projectWorkflowsTimer = setTimeout(async () => {
      await this.refreshProjectWorkflows();
      this.scheduleProjectWorkflows();
    }, PROJECT_WORKFLOWS_MS);
  }

  /**
   * Slow loop: for each pinned repo, build the expected workflow set from the
   * committed CircleCI config (∪ Insights actuals) plus the GitHub Actions
   * workflows list. Best-effort; folded into defaultBranchJobs on broadcast.
   */
  async refreshProjectWorkflows(): Promise<void> {
    const next = new Map<string, ProjectWorkflow[]>();
    await Promise.all(
      this.pinnedRepos.map(async (repo) => {
        const list: ProjectWorkflow[] = [];
        const [owner, name] = repo.split("/");
        if (!owner || !name) return;
        // CircleCI
        try {
          const files = await this.github.listCircleConfigFiles(repo);
          const defined = scanCircleWorkflows(files);
          if (defined.length > 0 || true) {
            const ranNames = await this.circle.getInsightsWorkflowNames(owner, name);
            const runsByName: Record<string, import("./project-workflows.ts").RawInsightsRun[]> = {};
            await Promise.all(
              ranNames.map(async (wf) => {
                runsByName[wf] = await this.circle.getInsightsWorkflowRuns(owner, name, wf);
              }),
            );
            list.push(
              ...buildCircleProjectWorkflows({
                repo, org: owner, defined, ranWorkflowNames: new Set(ranNames), runsByName,
              }),
            );
          }
        } catch (err) {
          this.errors.push(`project-workflows circle ${repo}: ${String(err)}`);
        }
        // GitHub Actions
        try {
          const workflows = await this.github.fetchActionsWorkflows(repo);
          const inputs: ActionsWorkflowInput[] = await Promise.all(
            workflows.map(async (w) => ({
              workflow: w,
              fileContent: w.path ? await this.github.fetchTextFile(repo, w.path) : undefined,
              latestRun: await this.github.fetchLatestWorkflowRun(repo, w.id),
            })),
          );
          list.push(...buildActionsProjectWorkflows(repo, inputs));
        } catch (err) {
          this.errors.push(`project-workflows actions ${repo}: ${String(err)}`);
        }
        next.set(repo, list);
      }),
    );
    this.expectedByRepo = next;
    this.attachCiToCards();
    this.broadcast();
  }
```

At the **end** of `attachCiToCards()` (after `this.defaultBranchJobs = jobs;` and before the merge-queue block, or after it — anywhere `this.defaultBranchJobs` is finalized), fold in expected workflows:

```ts
    const expected: ProjectWorkflow[] = [];
    for (const repo of this.pinnedRepos) {
      const e = this.expectedByRepo.get(repo);
      if (e) expected.push(...e);
    }
    if (expected.length > 0) {
      this.defaultBranchJobs = mergeProjectWorkflows(this.defaultBranchJobs, expected);
    }
```

Remove the `|| true` placeholder from the CircleCI block in `refreshProjectWorkflows` before finishing — it was only to show intent; the correct condition is to always query Insights (defined set may be empty but Insights still lists run workflows). Final form:

```ts
          const ranNames = await this.circle.getInsightsWorkflowNames(owner, name);
```

(i.e. drop the `if (defined.length > 0 || true)` wrapper entirely and run the Insights fetch unconditionally.)

- [ ] **Step 5: Run test to verify it passes**

Run: `eval "$(mise activate zsh)" && bun test src/lib/dashboard-poller.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `eval "$(mise activate zsh)" && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/dashboard-poller.ts src/lib/dashboard-poller.test.ts
git commit -m "Poller: slow loop building expected/scheduled workflow set"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md` (env-var table ~23-32)

- [ ] **Step 1: Add env vars to the README table**

In `README.md`, add two rows to the env-var table:

```markdown
| `DASHBOARD_PROJECT_WORKFLOWS` | `1` (on) | set to `0` to disable the expected/scheduled-workflow view in Projects. When on, pinned repos (`DASHBOARD_REPOS`) also show every workflow defined in their CircleCI config + GitHub Actions, annotated with when it last ran — so a scheduled job that has stopped firing or never fired is visible. |
| `DASHBOARD_PROJECT_WORKFLOWS_MS` | `300000` | how often (ms) to refresh the expected-workflow set. Separate, slower cadence than the live CI polling. |
```

- [ ] **Step 2: Verify the table renders (visual scan)**

Read `README.md` and confirm the two rows are well-formed Markdown within the existing table.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document DASHBOARD_PROJECT_WORKFLOWS env vars"
```

---

## Final verification

- [ ] Run the whole suite once more: `eval "$(mise activate zsh)" && bun test` → all pass.
- [ ] Typecheck: `eval "$(mise activate zsh)" && bun run typecheck` → clean.
- [ ] Manual smoke (optional, needs `GH_TOKEN`): run the server with `DASHBOARD_REPOS=ethereum-optimism/optimism` and confirm the Projects section lists scheduled workflows, with stale/never-run ones grouped first and labelled "last ran … ago" / "last run not found".

---

## Self-review notes (author)

- **Spec coverage:** config scan (T1), scheduled classification (T1/T3), Insights last-run (T2/T7), Actions defined-set + last-run + disabled state (T3/T8), "last run not found" (T2/T3/T6), fold-into-`defaultBranchJobs` model (T4), scheduled-first + oldest-first ordering (T5), three render states + badge (T6), slow cadence + pinned-only + env gating (T9), README (T10). All spec sections map to a task.
- **Type consistency:** `ProjectWorkflow`/`ProjectLastRun`/`RawInsightsRun`/`RawActionsWorkflow`/`RawActionsRun` defined in `project-workflows.ts` (T2/T3) and imported by `circleci.ts` (T7) and `dashboard-github.ts` (T8); `DefaultBranchJob` new fields (T4) used by merge (T4), sort (T5), render (T6). Merge key `${repo}::${provider}::${name}` is consistent between `mergeProjectWorkflows` and the `provider` set on existing builders (T4 Step 3).
- **Note for implementer:** Tasks 7 & 8 add methods to client interfaces — every test double implementing those interfaces must gain the new methods (stubs returning `[]`/`undefined`). The plan calls this out in T7 Step 5 and T8 Step 4.
