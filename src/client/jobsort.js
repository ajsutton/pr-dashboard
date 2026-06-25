/**
 * Sort key for default-branch job cards. Failing first to draw attention,
 * then in-progress (currently running/queued), then cancelled, then passing,
 * then everything else. The previous completed result wins over the in-flight
 * run — a job that last failed stays at the top even while it re-runs.
 */
export function jobSortRank(job) {
  const completed = job.lastCompleted?.status;
  const latest = job.latest?.status;
  if (completed === "failed" || completed === "blocked") return 0;
  if (latest === "running" || latest === "queued") return 1;
  if (completed === "canceled") return 2;
  if (completed === "success") return 3;
  return 4;
}

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
