/**
 * Compute per-PR lifecycle classes between two dashboard snapshots so the
 * client can choose the right entrance/exit/move animation:
 *
 *   entering  → PR not previously visible — slide up from off-screen bottom
 *   merging   → PR was in the merge queue and is now gone — almost
 *               certainly merged; slurp it into the repo's branch card
 *   exiting   → PR no longer visible (and didn't go through the queue) —
 *               fall off the bottom of the screen
 *   ejecting  → PR was in merge queue, now in the stack — move back to
 *               the stack with a red pulse
 *
 * (PR entering the queue — "enqueueing" — needs no special class; the default
 * view-transition group already interpolates the position change cleanly.)
 *
 * State is keyed by PR key so the caller can carry one Map across renders.
 */

export function diffPrLifecycles(prev, next) {
  const entering = new Set();
  const exiting = new Set();
  const ejecting = new Set();
  const merging = new Set();

  for (const [key, st] of next) {
    const before = prev.get(key);
    if (!before) {
      entering.add(key);
    } else if (before.inQueue && !st.inQueue) {
      ejecting.add(key);
    }
  }
  for (const [key, before] of prev) {
    if (next.has(key)) continue;
    if (before.inQueue) merging.add(key);
    else exiting.add(key);
  }

  return { entering, exiting, ejecting, merging };
}

/** Build the lifecycle-input Map from a snapshot. */
export function prLifecycleState(snap) {
  const map = new Map();
  for (const pr of snap.prs) {
    map.set(pr.key, { inQueue: !!pr.isInMergeQueue });
  }
  return map;
}

/** Stable, CSS-safe view-transition-name shared by a PR's stack and queue cards. */
export function prVtName(repo, number) {
  return `pr-${repo.replace(/[^a-zA-Z0-9]/g, "_")}-${number}`;
}

/**
 * Snapshot of every merge-queue entry keyed by `repo#prNumber`. Includes
 * other people's PRs (which never appear in snap.prs) so we can spot
 * ejections that the snap.prs-driven diff above can't see.
 */
export function queueLifecycleState(snap) {
  const map = new Map();
  for (const q of snap?.mergeQueues ?? []) {
    for (const e of q.entries ?? []) {
      const key = `${q.repo}#${e.prNumber}`;
      map.set(key, {
        mine: !!e.mine,
        state: e.state ?? null,
        ciRolledUp: e.ci?.rolledUp ?? null,
      });
    }
  }
  return map;
}

/**
 * Other-owned merge-queue entries that vanished between snapshots with a
 * clear failure signal — i.e. they were ejected, not merged. Returned as a
 * Set of `repo#prNumber` keys.
 *
 * Own PRs are handled by `diffPrLifecycles` (ejecting/merging) which has
 * a stronger signal: it can see the PR re-appear in the stack.
 *
 * "Likely merged" non-mine vanishes (success/queued/no signal) are left
 * untouched so the dashboard doesn't celebrate a teammate's success with
 * an explosion.
 */
export function diffQueueEjections(prev, next) {
  const exploding = new Set();
  for (const [key, before] of prev) {
    if (next.has(key)) continue;
    if (before.mine) continue;
    if (before.state === "UNMERGEABLE" || before.ciRolledUp === "failed") {
      exploding.add(key);
    }
  }
  return exploding;
}
