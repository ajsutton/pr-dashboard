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
