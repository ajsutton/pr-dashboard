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
 * Returns the ordered cycle of states for test mode, or `null` if the URL
 * doesn't enable test mode. `?test` (or `?test=`) returns every state in
 * declaration order; `?test=passing,failing,merged` returns just the
 * requested subset (unknown names are dropped, and falling back to the full
 * cycle when nothing valid remains).
 */
export function getTestCycle(search = location.search) {
  const params = new URLSearchParams(search);
  if (!params.has("test")) return null;
  const raw = params.get("test") ?? "";
  if (!raw) return [...TEST_STATES];
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = requested.filter((s) => TEST_STATES.includes(s));
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
 * on top per `stateName`. Always present in `repos` + `defaultBranchByRepo`
 * so the ship card is around for the merge animation across all states.
 */
export function injectTestPr(snap, stateName) {
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

  switch (stateName) {
    case "passing":
      out.prs.push(makeTestPr({ reviewDecision: "APPROVED", ciStatus: "success", isInMergeQueue: false }));
      out.stacks.push({ rootKey: TEST_KEY, prKeys: [TEST_KEY] });
      break;
    case "awaiting":
      out.prs.push(makeTestPr({ reviewDecision: "REVIEW_REQUIRED", ciStatus: "success", isInMergeQueue: false }));
      out.stacks.push({ rootKey: TEST_KEY, prKeys: [TEST_KEY] });
      break;
    case "failing":
      out.prs.push(makeTestPr({ reviewDecision: "REVIEW_REQUIRED", ciStatus: "failed", isInMergeQueue: false }));
      out.stacks.push({ rootKey: TEST_KEY, prKeys: [TEST_KEY] });
      break;
    case "failing-partial":
      // Failed rollup, but some jobs are still running so the card should
      // be red AND show a live progress bar with the failures listed.
      out.prs.push(makeTestPr({
        reviewDecision: "REVIEW_REQUIRED",
        ciStatus: "failed",
        isInMergeQueue: false,
        ciOptions: { partial: true },
      }));
      out.stacks.push({ rootKey: TEST_KEY, prKeys: [TEST_KEY] });
      break;
    case "queued": {
      // PR stays in snap.prs with isInMergeQueue=true so the lifecycle
      // diff sees it transition to/from the queue and the slurp animation
      // fires when it disappears.
      out.prs.push(makeTestPr({ reviewDecision: "APPROVED", ciStatus: "running", isInMergeQueue: true }));
      out.stacks.push({ rootKey: TEST_KEY, prKeys: [TEST_KEY] });
      let q = out.mergeQueues.find((q) => q.repo === TEST_REPO);
      if (!q) {
        q = { repo: TEST_REPO, entries: [] };
        out.mergeQueues.push(q);
      }
      q.entries = [...q.entries, makeTestQueueEntry()];
      break;
    }
    case "merged":
      // Intentionally don't add the PR — the diff between queued and
      // merged drives the merge animation.
      break;
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
    errors: [],
  };
}
