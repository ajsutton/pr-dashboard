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

/**
 * Decide what Kermit should do for the latest board state. Pure so the
 * appear/topple/hide state machine can be unit-tested without a DOM.
 *
 *   - `show`  — perch him (hop-in); also used to recover if the board flips
 *               back to green while he's mid-topple.
 *   - `fall`  — board went red while he was perched: topple backwards off the
 *               pill, then hide.
 *   - `hide`  — same trigger as `fall` but under reduced motion: just leave,
 *               no animation.
 *   - `none`  — nothing to do (already perched, already gone, already falling).
 *
 * @param {{green: boolean, visible: boolean, falling: boolean, reducedMotion: boolean}} state
 * @returns {'show' | 'fall' | 'hide' | 'none'}
 */
export function nextKermitAction({ green, visible, falling, reducedMotion }) {
  if (green) {
    // Perch him if he's away, or catch him mid-fall and hop him back up.
    return !visible || falling ? 'show' : 'none';
  }
  // Board is red. Only act if he's currently perched and not already toppling.
  if (!visible || falling) return 'none';
  return reducedMotion ? 'hide' : 'fall';
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
