/**
 * Dashboard demo mode. Enabled by adding `?test` to the URL.
 *
 * Synthesises a single test PR and cycles it through every interesting
 * dashboard state (passing → awaiting review → failing → in merge queue →
 * merged) every 5 seconds. The test PR is injected on top of whatever real
 * snapshot is currently loaded, so the live data keeps rendering alongside.
 *
 * The "merged" state simply removes the PR from both the PR list and the
 * queue; the dashboard's existing lifecycle diff sees that a queue entry
 * vanished and runs the slurp-into-ship animation automatically.
 */

const TEST_REPO = "demo/test-pr";
const TEST_PR_NUMBER = 9999;
const TEST_KEY = `${TEST_REPO}#${TEST_PR_NUMBER}`;
const TEST_BRANCH = "main";
const TEST_AUTHOR = "you";
const TEST_TITLE = "TEST PR — demo cycle through dashboard states";

export const TEST_STATES = ["passing", "awaiting", "failing", "failing-partial", "queued", "merged"];

/**
 * Additive modifiers that can be appended to any base state with `+`:
 *   ?test=passing+autoMergeEnabled+conflict
 * Each modifier is applied in turn to the synthesised PR card after the
 * base state has built it. Unknown modifier names within an otherwise-valid
 * entry are dropped silently.
 *
 * `stacked` simulates the new no-bridge-arrow case where the parent PR
 * isn't on the dashboard (e.g. it's in the merge queue or owned by another
 * author) — the child still surfaces "Stacked on #N" with the #N as a
 * link.
 */
const MODIFIERS = {
  autoMergeEnabled: (pr) => { pr.autoMergeEnabled = true; },
  conflict: (pr) => { pr.mergeable = "CONFLICTING"; },
  approved: (pr) => { pr.reviewDecision = "APPROVED"; },
  stacked: (pr) => {
    pr.parentPr = { repo: TEST_REPO, number: TEST_PR_NUMBER - 1, state: "OPEN" };
  },
};
export const TEST_MODIFIERS = Object.keys(MODIFIERS);

/**
 * `?test=passing+autoMergeEnabled` → `{ base: "passing", mods: Set("autoMergeEnabled") }`.
 *
 * Accepts `+` *or* whitespace between tokens: `URLSearchParams` decodes a
 * raw `+` in a query string as a space (form-urlencoded convention), so a
 * URL like `?test=passing+autoMergeEnabled` reaches us as
 * `"passing autoMergeEnabled"`. Treating both characters as separators
 * lets the user type `+` in the URL bar (the common case) *and* lets us
 * round-trip the canonical `+` form through `injectTestPr` directly.
 *
 * Unknown modifier names are dropped silently; the base is returned as-is
 * and is validated by the caller.
 */
function parseStateSpec(spec) {
  const [base, ...modList] = spec.split(/[+\s]+/).filter(Boolean);
  const mods = new Set(modList.filter((m) => Object.prototype.hasOwnProperty.call(MODIFIERS, m)));
  return { base: base ?? "", mods };
}

/**
 * Returns the ordered cycle of state specs for test mode, or `null` if the
 * URL doesn't enable test mode. `?test` (or `?test=`) returns every base
 * state in declaration order; `?test=passing,failing+conflict,merged` keeps
 * the supplied subset (entries with an unknown base are dropped; the cycle
 * falls back to the full base list when nothing valid remains).
 */
export function getTestCycle(search = location.search) {
  const params = new URLSearchParams(search);
  if (!params.has("test")) return null;
  const raw = params.get("test") ?? "";
  if (!raw) return [...TEST_STATES];
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = requested.filter((spec) => {
    const { base } = parseStateSpec(spec);
    return TEST_STATES.includes(base);
  });
  return valid.length > 0 ? valid : [...TEST_STATES];
}

function makeTestCi(rolledUp, { partial = false } = {}) {
  const isRunning = rolledUp === "running" || rolledUp === "queued";
  let workflows = [];
  if (rolledUp === "failed" && partial) {
    // One workflow already failed, another still chugging — the rollup is
    // "failed" but there's progress left to display.
    workflows = [{
      id: "wf-test-failed-partial",
      name: "CI",
      status: "failed",
      createdAt: new Date().toISOString(),
      jobs: [
        { name: "build", status: "success" },
        { name: "test (linux)", status: "failed" },
        { name: "test (windows)", status: "running" },
        { name: "lint", status: "queued" },
      ],
      elapsedMs: 120_000,
      progressPct: 100,
      url: "#",
    }];
  } else if (rolledUp === "failed") {
    workflows = [{
      id: "wf-test-failed",
      name: "CI",
      status: "failed",
      createdAt: new Date().toISOString(),
      jobs: [
        { name: "build", status: "success" },
        { name: "test (linux)", status: "failed" },
      ],
      elapsedMs: 120_000,
      progressPct: 100,
      url: "#",
    }];
  }
  return {
    provider: "github",
    commit: "0".repeat(40),
    branch: TEST_BRANCH,
    workflows,
    rolledUp,
    progressPct: isRunning ? 35 : 100,
    elapsedMs: 120_000,
    estimatedTotalMs: isRunning ? 360_000 : undefined,
    url: "#",
  };
}

function makeTestPr({ reviewDecision, ciStatus, isInMergeQueue, ciOptions }) {
  return {
    key: TEST_KEY,
    repo: TEST_REPO,
    number: TEST_PR_NUMBER,
    title: TEST_TITLE,
    url: "#",
    author: TEST_AUTHOR,
    isDraft: false,
    state: "OPEN",
    reviewDecision,
    mergeable: "MERGEABLE",
    isInMergeQueue,
    headRefName: "test-branch",
    headSha: "0".repeat(40),
    baseRefName: TEST_BRANCH,
    defaultBranch: TEST_BRANCH,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reviews: [],
    reviewRequested: [],
    childPrs: [],
    ci: makeTestCi(ciStatus, ciOptions),
  };
}

function makeTestQueueEntry() {
  return {
    repo: TEST_REPO,
    position: 1,
    prNumber: TEST_PR_NUMBER,
    prTitle: TEST_TITLE,
    prUrl: "#",
    author: TEST_AUTHOR,
    state: "QUEUED",
    enqueuedAt: new Date().toISOString(),
    mine: true,
    ci: makeTestCi("running"),
  };
}

/**
 * Returns a shallow clone of `snap` with the test PR / queue entry layered
 * on top per `stateSpec`. `stateSpec` is `base[+mod1+mod2…]` — see
 * `MODIFIERS` for the supported modifier names. Always present in `repos`
 * + `defaultBranchByRepo` so the ship card is around for the merge
 * animation across all states.
 */
export function injectTestPr(snap, stateSpec) {
  const out = {
    ...snap,
    prs: [...(snap.prs ?? [])],
    stacks: [...(snap.stacks ?? [])],
    mergeQueues: (snap.mergeQueues ?? []).map((q) => ({ ...q, entries: [...q.entries] })),
    defaultBranchByRepo: [...(snap.defaultBranchByRepo ?? [])],
    repos: [...(snap.repos ?? [])],
  };

  if (!out.defaultBranchByRepo.some((d) => d.repo === TEST_REPO)) {
    out.defaultBranchByRepo.push({ repo: TEST_REPO, branch: TEST_BRANCH });
  }
  if (!out.repos.includes(TEST_REPO)) {
    out.repos.push(TEST_REPO);
  }

  const { base, mods } = parseStateSpec(stateSpec);
  let testPr = null;
  let testQueueEntry = null;
  switch (base) {
    case "passing":
      testPr = makeTestPr({ reviewDecision: "APPROVED", ciStatus: "success", isInMergeQueue: false });
      break;
    case "awaiting":
      testPr = makeTestPr({ reviewDecision: "REVIEW_REQUIRED", ciStatus: "success", isInMergeQueue: false });
      break;
    case "failing":
      testPr = makeTestPr({ reviewDecision: "REVIEW_REQUIRED", ciStatus: "failed", isInMergeQueue: false });
      break;
    case "failing-partial":
      // Failed rollup, but some jobs are still running so the card should
      // be red AND show a live progress bar with the failures listed.
      testPr = makeTestPr({
        reviewDecision: "REVIEW_REQUIRED",
        ciStatus: "failed",
        isInMergeQueue: false,
        ciOptions: { partial: true },
      });
      break;
    case "queued":
      // PR stays in snap.prs with isInMergeQueue=true so the lifecycle
      // diff sees it transition to/from the queue and the slurp animation
      // fires when it disappears.
      testPr = makeTestPr({ reviewDecision: "APPROVED", ciStatus: "running", isInMergeQueue: true });
      testQueueEntry = makeTestQueueEntry();
      break;
    case "merged":
      // Intentionally don't add the PR — the diff between queued and
      // merged drives the merge animation.
      break;
  }

  if (testPr) {
    for (const m of mods) MODIFIERS[m](testPr);
    out.prs.push(testPr);
    out.stacks.push({ rootKey: TEST_KEY, prKeys: [TEST_KEY] });
  }
  if (testQueueEntry) {
    let q = out.mergeQueues.find((q) => q.repo === TEST_REPO);
    if (!q) {
      q = { repo: TEST_REPO, entries: [] };
      out.mergeQueues.push(q);
    }
    q.entries = [...q.entries, testQueueEntry];
  }

  return out;
}

export function emptyTestSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    user: "test-user",
    prs: [],
    stacks: [],
    mergeQueues: [],
    defaultBranchJobs: [],
    defaultBranchByRepo: [],
    repos: [],
    stats: {
      assignedIssues: [],
      assignedIssuesTotalCount: 0,
      reviewRequests: [],
      reviewRequestsTotalCount: 0,
      personalReviewRequests: [],
      personalReviewRequestsTotalCount: 0,
      totalIssuesByRepo: [],
      totalPrsByRepo: [],
    },
    errors: [],
  };
}
