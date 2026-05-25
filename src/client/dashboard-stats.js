/**
 * Pure helper: turn a DashboardStats payload into the five stat cards the
 * dashboard renders. Each card descriptor has an `id` (DOM/data key), a
 * human label, a `count` (the big number on the front face), an `items`
 * array (rows for the back face), and a `kind` that distinguishes how the
 * table should render — `items` cards show one row per issue/PR, `totals`
 * cards show one row per repo.
 */
export function buildStatCards(stats) {
  const assignedIssues = stats.assignedIssues ?? [];
  const reviewRequests = stats.reviewRequests ?? [];
  const personal = stats.personalReviewRequests ?? [];
  const issueTotals = stats.totalIssuesByRepo ?? [];
  const prTotals = stats.totalPrsByRepo ?? [];
  // Prefer the server-provided totals when available — search.nodes is
  // capped at 100, so trusting length would understate large queues.
  const totalAssigned = stats.assignedIssuesTotalCount ?? assignedIssues.length;
  const totalReviews = stats.reviewRequestsTotalCount ?? reviewRequests.length;
  const totalPersonal = stats.personalReviewRequestsTotalCount ?? personal.length;
  return [
    {
      id: 'assigned-issues',
      label: 'Assigned Issues',
      count: totalAssigned,
      items: assignedIssues,
      kind: 'items',
    },
    {
      id: 'personal-reviews',
      label: 'Personal Review Requests',
      count: totalPersonal,
      items: personal,
      kind: 'items',
    },
    {
      id: 'review-requests',
      label: 'Review Requests',
      count: totalReviews,
      items: reviewRequests,
      kind: 'items',
    },
    {
      id: 'open-issues',
      label: 'Open Issues',
      count: sumCounts(issueTotals),
      items: issueTotals,
      kind: 'totals',
    },
    {
      id: 'open-prs',
      label: 'Open PRs',
      count: sumCounts(prTotals),
      items: prTotals,
      kind: 'totals',
    },
  ];
}

function sumCounts(rows) {
  let n = 0;
  for (const r of rows) n += r.count ?? 0;
  return n;
}
