/**
 * Is the whole board green? True only when nothing on the dashboard is
 * failing — across My PRs, the merge queue, and Projects — and nothing
 * currently in progress is re-running after a red.
 *
 * Drives the Kermit easter egg: he only perches on the status pill when
 * there's genuinely nothing to worry about.
 *
 * Rules:
 *  - A PR / queue entry counts as a failure when its CI rollup is "failed".
 *  - A Projects job counts as a failure when its latest run is "failed" or
 *    "blocked", OR when it's in progress (running/queued) and its previous
 *    completed run was something other than success — that "previous run
 *    was green" clause keeps Kermit away while a known-red job re-runs.
 *  - An in-progress item with no prior result isn't a failure: nothing red.
 *  - An empty / not-yet-loaded board returns false — there's nothing to
 *    celebrate on a blank screen.
 */
export function boardAllGreen(snap) {
  if (!snap) return false;

  const prs = snap.prs ?? [];
  const queues = snap.mergeQueues ?? [];
  const jobs = snap.defaultBranchJobs ?? [];

  const queueEntries = queues.flatMap((q) => q.entries ?? []);
  if (prs.length === 0 && queueEntries.length === 0 && jobs.length === 0) {
    return false;
  }

  for (const pr of prs) {
    if (pr.ci?.rolledUp === 'failed') return false;
  }
  for (const entry of queueEntries) {
    if (entry.ci?.rolledUp === 'failed') return false;
  }
  for (const job of jobs) {
    if (jobFailing(job)) return false;
  }
  return true;
}

function jobFailing(job) {
  const latest = job.latest?.status;
  if (latest === 'failed' || latest === 'blocked') return true;
  const inProgress = latest === 'running' || latest === 'queued';
  if (inProgress && job.lastCompleted && job.lastCompleted.status !== 'success') {
    return true;
  }
  return false;
}
