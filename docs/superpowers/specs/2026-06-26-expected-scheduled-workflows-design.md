# Expected / scheduled workflows on the Projects board

**Date:** 2026-06-26
**Status:** Design — awaiting implementation plan

## Problem

The dashboard's **Projects** section currently shows only the CI workflows that
have *actually run* on a tracked repo's default branch within the last 72h. A
workflow that is *supposed* to run on a schedule but has stopped firing — or was
never wired up at all — is simply invisible. There is no way to spot it.

The motivating incident: in `ethereum-optimism/optimism`, several jobs were gated
on a `build_weekly` schedule trigger that didn't exist, so they silently never
ran. Nobody noticed because nothing on any dashboard showed the gap.

## Goal

Show the **expected set** of CI workflows for pinned repos — including ones that
haven't run recently or ever — each annotated with **when it last ran** and its
**last status**. Schedule-driven workflows are grouped first so a stale or
never-fired scheduled job is easy to eyeball.

This is **visualization only.** We do not compute "overdue" thresholds, parse
cron cadence to predict next-run, or flag anything as broken automatically. A
human reads "weekly tests — last run not found" or "last ran 23d ago" and draws
their own conclusion. (Rationale: cadence-vs-actual thresholding is error-prone
and noisy; surfacing the raw last-run next to the workflow name is enough to make
the `build_weekly` class of bug obvious.)

## Non-goals

- Auto-detecting / alerting on overdue or missing schedules.
- Parsing cron expressions to compute expected cadence or next-run time.
- Enumerating the real CircleCI scheduled-pipelines list. (The
  `/project/{slug}/schedule` API returns *Permission denied* without a token
  even for public projects, so it is not a reliable generic source. Scheduled
  classification comes from the config instead — see below.)
- Covering CI config that is generated programmatically at runtime (no static
  file to read). Static and file-based dynamic config are covered; script-
  generated continuation config is a documented blind spot.

## Scope

- **Pinned repos only** (`DASHBOARD_REPOS`). PR-discovered repos keep today's
  72h recent-runs behaviour only. Pinned-only bounds the extra API cost and
  targets the repos the user actively monitors.
- Opt-out via `DASHBOARD_PROJECT_WORKFLOWS=0` (default: on).
- Both **CircleCI** and **GitHub Actions**.

## Why the obvious approaches don't work (validated against the live repo)

| Source | Generic? | "stopped running" | "defined, never fired" |
|---|---|---|---|
| CircleCI compiled-config API (`/pipeline/{id}/config`) | yes | yes | **no** — see below |
| CircleCI Insights `/workflows` (90-day) | yes | yes | **no** |
| GitHub Actions `/actions/workflows` | yes | yes | **yes** |
| Scan `.circleci/**/*.yml` for `workflows:` keys | yes (impl) | yes | **yes** |

`optimism`'s root `.circleci/config.yml` is **CircleCI dynamic config**
(`setup: true`). The compiled-config API was tested on a real `develop` pipeline:
it returned only the 7 workflows that pipeline emitted; the scheduled workflows
(`weekly`, `cannon_full`, …) were **absent**. The setup job only emits the
continuation workflows relevant to the trigger that fired, so a workflow gated on
a non-existent schedule never appears in any pipeline's compiled config — and
unioning multiple pipelines can't help, because a missing trigger produces no
pipeline to find. The only thing that reveals a never-fired workflow is its
definition in committed source. Hence the `.circleci/**/*.yml` scan.

## Data sources

### CircleCI (per pinned repo)

**Defined set** — generically scan the committed config:
1. List `.circleci/` recursively via the GitHub contents API; collect every
   `*.yml` / `*.yaml` file (`config.yml` plus any continuation files in
   subdirectories).
2. Parse each with `Bun.YAML.parse` (native in Bun 1.3+ — **no new dependency**).
   Files that fail to parse or have no `workflows:` map are skipped silently.
3. The **defined set** = union of top-level keys under each file's `workflows:`
   map, excluding the reserved `version` key.
4. Cache the parsed result keyed by the `.circleci` tree SHA; only re-fetch and
   re-parse when that SHA changes.

This is generic — no per-repo paths or parameter names are hard-coded. Caveat:
it may pick up workflow keys from helper/template files that aren't really
scheduled in production; acceptable for a visualization, and they'll typically
show a real last-run so they don't look broken.

**Last run + status** — from Insights:
- One call to `/insights/{slug}/workflows?reporting-window=last-90-days` lists
  every workflow that ran in the window (names only; no per-run timestamps).
- For each workflow in the *defined set* that also appears in that list, call
  `/insights/{slug}/workflows/{name}?reporting-window=last-90-days`; `items[0]`
  (newest-first) gives `created_at` / `stopped_at` and `status` → last-run time +
  last status. Verified to work anonymously on the public project.
- A defined workflow absent from the Insights list → **"last run not found"**
  (no per-workflow call needed). This bounds the per-workflow call count to
  "workflows that actually ran," which is small.

**Scheduled classification** (best-effort, from the scanned source YAML). A
workflow is flagged `scheduled` if any of:
- it has a legacy `triggers:` entry containing `schedule` / `cron`; or
- a `when` condition references `pipeline.schedule` (any field); or
- a `when` condition references a pipeline parameter whose name matches
  `/schedul|weekly|nightly|daily|monthly|cron/i`.

If none match, it is not flagged scheduled (still shown, just not grouped first).

### GitHub Actions (per pinned repo)

- `GET /repos/{o}/{r}/actions/workflows` → the full defined set, including
  never-run workflows, each with `id`, `name`, `path`, and `state`
  (`active` / `disabled_manually` / `disabled_inactivity`).
- Last run + status: `GET /repos/{o}/{r}/actions/workflows/{id}/runs?per_page=1`
  → most recent run's `conclusion` + timestamp + html_url. No runs →
  **"last run not found."**
- `scheduled` flag: fetch the workflow file at `path` (cached by content SHA) and
  check for an `on: schedule` key. (A run with `event: schedule` corroborates it
  but can't reveal a never-run scheduled workflow, so the file is authoritative.)
- A `disabled_*` state is surfaced on the card (it's a legitimate reason a
  scheduled workflow stopped — informative, not auto-flagged as an error).

## Cadence & cost

- A **new slow refresh loop**, `refreshProjectWorkflows()`, runs every
  **~5 minutes** (`DASHBOARD_PROJECT_WORKFLOWS_MS`, default `300_000`),
  independent of the 12–60s CI cadence. Scheduled/expected data does not need
  fast updates.
- Config files and Actions workflow files are cached by SHA, so steady-state
  cost per tick is: 1 Insights list call + a handful of per-workflow Insights
  calls + 1 Actions workflows call + a few Actions runs calls, per pinned repo.
- All calls are best-effort; failures push a message onto the existing snapshot
  `errors` array and leave the previous data in place.

## Data model

Approach **(A): fold into the existing `defaultBranchJobs` grid** (chosen over a
separate snapshot section so the entries render "in the Projects list" and reuse
the existing card / grid / sort).

Extend `DefaultBranchJob` in `src/types.ts`:

```ts
export interface DefaultBranchJob {
  key: string;
  repo: string;
  branch: string;
  name: string;
  latest?: DefaultBranchJobRun | undefined;   // now OPTIONAL
  lastCompleted?: DefaultBranchJobRun | undefined;
  // --- new ---
  provider?: "circleci" | "github" | undefined;
  expected?: boolean | undefined;             // sourced from the defined set
  scheduled?: boolean | undefined;
  /** Disabled state for GitHub Actions workflows, when applicable. */
  disabledState?: "disabled_manually" | "disabled_inactivity" | undefined;
  /**
   * Long-lookback last run (may be far older than the 72h window) used when
   * there is no in-window `latest`. `found: false` → render "last run not found".
   */
  lastRun?: { found: boolean; status?: CiJobStatusValue; at?: string; url?: string } | undefined;
}
```

`latest` becomes optional: an expected workflow with no in-window run has no
`latest`; the card falls back to `lastRun`.

## Server flow

1. `refreshGitHub()` is unchanged; it still produces the window-bounded
   `defaultBranchJobs` from PR/branch checks + CircleCI records.
2. New `refreshProjectWorkflows()` (slow loop) builds, per pinned repo, an
   **expected-workflow list** (CircleCI defined-set ∪ Insights actuals, plus
   Actions workflows), stored in `this.expectedByRepo`.
3. A pure merge function folds `expectedByRepo` into `defaultBranchJobs` on every
   broadcast (called from the existing `attachCiToCards`, so it survives both
   GitHub and CI refreshes):
   - **Dedup key** = `${repo}::${provider}::${name}`. CircleCI recent-run jobs
     are re-keyed to use the workflow name so they merge with the defined set.
   - If a recent-run job already exists for that key, it is the richer source —
     keep its `latest` / `lastCompleted` and only annotate it with
     `expected` / `scheduled` / `provider` / `disabledState`.
   - Otherwise add a new entry with `latest` undefined and `lastRun` populated
     from Insights/Actions (or `{ found: false }`).

New module **`src/lib/project-workflows.ts`** holds the pure builders
(config scan → defined set, scheduled classification, Insights/Actions → lastRun,
and the merge) so they are unit-testable without the network. Client methods are
added to `RealDashboardGitHubClient` (contents listing, file fetch, Actions
workflows + runs) and `RealCircleCiClient` (Insights list + per-workflow runs),
behind the existing client interfaces so tests inject fakes.

## Rendering

`renderJobCard` (`src/client/dashboard.js`) gains three states:
- **In-window run** (`latest` present) — unchanged.
- **Older last run** (`lastRun.found`, no `latest`) — head shows the workflow +
  repo + a **scheduled badge** (clock) when `scheduled`; body shows
  "last ran {age} ago" with the last-status colour; no progress bar.
- **Not found** (`lastRun.found === false`) — muted "last run not found" state;
  scheduled badge still shown if applicable. A `disabledState` shows a small
  "disabled" tag.

**Sort / grouping** (`renderJobs`): scheduled workflows first, then the existing
`jobSortRank` (failures first), then **oldest-last-run first** (so stale /
never-run float up within their group), then repo order, then name.

## Configuration summary

| Var | Default | Description |
|---|---|---|
| `DASHBOARD_PROJECT_WORKFLOWS` | `1` | set `0` to disable the expected/scheduled workflow view |
| `DASHBOARD_PROJECT_WORKFLOWS_MS` | `300000` | slow-refresh interval (ms) |

Update `README.md` env-var table accordingly.

## Testing

Unit tests (Bun, injectable mock clients — existing pattern):
- **Config scan**: static single `config.yml`; multi-file dynamic config
  (`config.yml` + continuation files in subdirs) → correct unioned defined set;
  `version` excluded; unparseable file skipped.
- **Scheduled classification**: legacy `triggers.schedule.cron`; `when` ref to
  `pipeline.schedule`; `when` ref to a `*_weekly` / `*scheduled*` parameter;
  Actions `on: schedule`; negative case.
- **Insights mapping**: `items[0]` → last-run time + status; empty items →
  `{ found: false }`; workflow absent from list → not found without a per-workflow
  call.
- **Actions mapping**: workflows list incl. never-run; `runs?per_page=1` → last
  run; no runs → not found; `disabledState` carried through.
- **Merge**: recent-run job wins over expected entry and gets annotated; expected-
  only entry added with `latest` undefined; dedup key matches across providers.
- **Sort/grouping**: scheduled first, then failures, then oldest-last-run first.
- **Client render** (jsdom-style, matching existing client tests): the three card
  states render the expected labels, including "last run not found" and the
  scheduled badge.

All tests must pass (`bun test`) before commit, per project non-negotiables.
