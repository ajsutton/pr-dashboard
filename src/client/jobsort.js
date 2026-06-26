/**
 * Category rank for a Projects job card. Lower sorts first:
 *   0 failed      — last settled result failed/blocked (incl. an old recorded run)
 *   1 cancelled   — last settled result cancelled
 *   2 in progress — currently running or queued
 *   3 scheduled, never run — kept high so a never-fired schedule stands out
 *   4 passing     — last settled result success
 *   5 other       — ran, but status unknown / unclassified
 *   6 never run (not scheduled) — least interesting; dropped to the end
 *
 * The last settled result (last completed in-window run, or the long-lookback
 * recorded run) drives fail/cancel/pass; the in-flight run drives "in progress".
 * A job that last failed stays in the failed tier even while it re-runs.
 */
export function jobCategory(job) {
  const terminal = terminalStatus(job);
  const live = job.latest?.status;
  const everRan = !!(job.latest || job.lastCompleted || (job.lastRun && job.lastRun.found));
  if (terminal === "failed" || terminal === "blocked") return 0;
  if (terminal === "canceled") return 1;
  if (live === "running" || live === "queued") return 2;
  // A scheduled workflow that has never run stays high (rank 3) so a never-fired
  // schedule is visible; a non-scheduled never-run workflow drops to the very end.
  if (!everRan) return job.scheduled ? 3 : 6;
  if (terminal === "success") return 4;
  return 5;
}

/**
 * The last *settled* result we know for a job — from the in-window completed
 * run, else the long-lookback recorded run, else a latest run that has already
 * finished. Running/queued is not a settled result, so it's ignored here.
 */
function terminalStatus(job) {
  if (job.lastCompleted?.status) return job.lastCompleted.status;
  if (job.lastRun && job.lastRun.found) return job.lastRun.status;
  const l = job.latest?.status;
  if (l && l !== "running" && l !== "queued") return l;
  return undefined;
}

/**
 * Sort comparator for the Projects grid once expected/scheduled workflows are
 * folded in. Tiers, in order:
 *   1. jobCategory (failed, cancelled, in progress, scheduled-never-run,
 *      never-run, passing, other)
 *   2. most recent run first within a category
 *   3. server repo order, then name
 */
export function projectJobCompare(a, b, repoOrder) {
  const ca = jobCategory(a);
  const cb = jobCategory(b);
  if (ca !== cb) return ca - cb;

  const ta = lastRunMs(a);
  const tb = lastRunMs(b);
  if (ta !== tb) return tb - ta; // most recent first

  const ria = repoOrder.get(a.repo) ?? 1e6;
  const rib = repoOrder.get(b.repo) ?? 1e6;
  if (ria !== rib) return ria - rib;
  if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
  return a.name.localeCompare(b.name);
}

function lastRunMs(job) {
  // In-window run wins; else the long-lookback lastRun; else 0 (never ran).
  if (job.latest && job.latest.startedAt) return Date.parse(job.latest.startedAt) || 0;
  if (job.lastRun && job.lastRun.found && job.lastRun.at) return Date.parse(job.lastRun.at) || 0;
  return 0;
}
