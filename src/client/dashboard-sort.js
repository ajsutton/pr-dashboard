/**
 * Lower = more action required. Used to sort stacks so the most
 * actionable PRs surface at the top of the dashboard.
 *
 *   1 → ready to merge (or already merging): approved + CI not failing
 *   2 → approved, CI failing — needs investigation
 *   3 → unapproved, CI failing — has issues
 *   4 → unapproved, CI passing — waiting on review
 *   5 → draft — no action expected yet
 *
 * Empty/missing reviewDecision is "no review required" (e.g. solo repo)
 * and is treated as approved. Running CI is treated as not-yet-failing.
 */
export function prActionRank(pr) {
  if (pr.isDraft) return 5;
  if (pr.isInMergeQueue) return 1;
  const approved = pr.reviewDecision === "APPROVED" || !pr.reviewDecision;
  const ciStatus = pr.ci?.rolledUp;
  const failing = ciStatus === "failed" || ciStatus === "blocked" || ciStatus === "canceled";
  if (approved && !failing) return 1;
  if (approved && failing) return 2;
  if (failing) return 3;
  return 4;
}

function stackRank(stack, byKey) {
  let best = 99;
  for (const k of stack.prKeys) {
    const pr = byKey.get(k);
    if (!pr) continue;
    const r = prActionRank(pr);
    if (r < best) best = r;
  }
  return best;
}

export function sortStacks(stacks, byKey) {
  return [...stacks].sort((a, b) => {
    const rankDiff = stackRank(a, byKey) - stackRank(b, byKey);
    if (rankDiff !== 0) return rankDiff;
    return b.prKeys.length - a.prKeys.length;
  });
}
