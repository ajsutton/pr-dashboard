import { describe, expect, test } from "bun:test";
import {
  buildStats,
  buildTotalsByRepo,
  dedupReposByCanonical,
  deriveGhOrigin,
  DashboardPoller,
} from "./dashboard-poller.ts";
import type {
  DashboardGitHubClient,
  RawPr,
  RawReviewRequestItem,
  RawStatItem,
  RepoMeta,
  ViewerWorkload,
} from "./dashboard-github.ts";
import type { CircleCiClient } from "./circleci.ts";
import type { DashboardSnapshot } from "../types.ts";

function meta(canonical: string, openIssues = 0, openPrs = 0): RepoMeta {
  return { canonical, openIssues, openPrs };
}

describe("dedupReposByCanonical", () => {
  test("collapses pinned and PR entries that share a canonical name", () => {
    // After a repo transfer, GitHub redirects API queries for the old name to
    // the new one — so the pinned alias and the canonical name returned for
    // open PRs both point at the same repo.
    const out = dedupReposByCanonical(
      ["ajsutton/moolah-native"],
      ["moolah-rocks/moolah-native"],
      new Map([
        ["ajsutton/moolah-native", meta("moolah-rocks/moolah-native")],
        ["moolah-rocks/moolah-native", meta("moolah-rocks/moolah-native")],
      ]),
    );
    expect(out).toEqual(["moolah-rocks/moolah-native"]);
  });

  test("preserves pinned order ahead of PR-discovered repos", () => {
    const out = dedupReposByCanonical(
      ["a/one", "a/two"],
      ["b/three", "a/one"],
      new Map([
        ["a/one", meta("a/one")],
        ["a/two", meta("a/two")],
        ["b/three", meta("b/three")],
      ]),
    );
    expect(out).toEqual(["a/one", "a/two", "b/three"]);
  });

  test("falls back to the input name when the canonical map has no entry", () => {
    const out = dedupReposByCanonical(["a/x"], ["b/y"], new Map());
    expect(out).toEqual(["a/x", "b/y"]);
  });
});

describe("buildTotalsByRepo", () => {
  test("returns one row per ordered repo with openIssues count and URL", () => {
    const totals = buildTotalsByRepo(
      ["a/one", "b/two"],
      new Map([
        ["a/one", meta("a/one", 3, 5)],
        ["b/two", meta("b/two", 7, 0)],
      ]),
      "issues",
      "https://github.com",
    );
    expect(totals).toEqual([
      { repo: "a/one", count: 3, url: "https://github.com/a/one/issues?q=is%3Aissue+is%3Aopen" },
      { repo: "b/two", count: 7, url: "https://github.com/b/two/issues?q=is%3Aissue+is%3Aopen" },
    ]);
  });

  test("returns one row per ordered repo with openPrs count and URL", () => {
    const totals = buildTotalsByRepo(
      ["a/one"],
      new Map([["a/one", meta("a/one", 0, 4)]]),
      "prs",
      "https://github.com",
    );
    expect(totals).toEqual([
      { repo: "a/one", count: 4, url: "https://github.com/a/one/pulls?q=is%3Apr+is%3Aopen" },
    ]);
  });

  test("falls back to 0 when meta is missing for a repo", () => {
    const totals = buildTotalsByRepo(["a/missing"], new Map(), "issues", "https://github.com");
    expect(totals).toEqual([
      { repo: "a/missing", count: 0, url: "https://github.com/a/missing/issues?q=is%3Aissue+is%3Aopen" },
    ]);
  });
});

describe("deriveGhOrigin", () => {
  test("picks the origin from the first PR's url", () => {
    const origin = deriveGhOrigin(
      [{ url: "https://github.example.com/o/r/pull/1" }],
      "https://github.com",
    );
    expect(origin).toBe("https://github.example.com");
  });

  test("falls back to the prior origin when there are no PRs", () => {
    expect(deriveGhOrigin([], "https://github.com")).toBe("https://github.com");
  });
});

describe("buildStats", () => {
  const issue: RawStatItem = {
    repo: "o/r",
    number: 10,
    title: "Track",
    url: "https://github.com/o/r/issues/10",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-02T00:00:00Z",
  };
  const reviewReq = (over: Partial<RawReviewRequestItem>): RawReviewRequestItem => ({
    repo: "o/r",
    number: 1,
    title: "PR",
    url: "https://github.com/o/r/pull/1",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-02T00:00:00Z",
    reviewerLogins: [],
    ...over,
  });

  const baseArgs = {
    viewerLogin: "alice",
    assignedIssues: [],
    assignedIssuesTotalCount: 0,
    reviewRequestedPrs: [] as RawReviewRequestItem[],
    reviewRequestedPrsTotalCount: 0,
    personalReviewRequestedPrs: [] as RawStatItem[],
    personalReviewRequestsTotalCount: 0,
    orderedRepos: [] as string[],
    repoMeta: new Map<string, RepoMeta>(),
    ghOrigin: "https://github.com",
  };

  test("flags review requests as personal when viewer's login is in the reviewer list", () => {
    const stats = buildStats({
      ...baseArgs,
      reviewRequestedPrs: [reviewReq({ number: 1, reviewerLogins: ["alice"] })],
    });
    expect(stats.reviewRequests[0]!.isPersonal).toBe(true);
  });

  test("flags review requests as group-only when only team reviewers are present", () => {
    const stats = buildStats({
      ...baseArgs,
      // reviewerLogins captures only User reviewers, so a team-only request
      // arrives with an empty array.
      reviewRequestedPrs: [reviewReq({ number: 2, reviewerLogins: [] })],
    });
    expect(stats.reviewRequests[0]!.isPersonal).toBe(false);
  });

  test("flags review requests as group-only when other-user reviewers are present but not the viewer", () => {
    const stats = buildStats({
      ...baseArgs,
      reviewRequestedPrs: [reviewReq({ number: 3, reviewerLogins: ["bob", "carol"] })],
    });
    expect(stats.reviewRequests[0]!.isPersonal).toBe(false);
  });

  test("copies assigned issue fields and builds totals in repo order", () => {
    const stats = buildStats({
      ...baseArgs,
      assignedIssues: [issue],
      orderedRepos: ["o/r", "x/y"],
      repoMeta: new Map([
        ["o/r", { canonical: "o/r", openIssues: 4, openPrs: 6 }],
        ["x/y", { canonical: "x/y", openIssues: 1, openPrs: 2 }],
      ]),
    });
    expect(stats.assignedIssues).toEqual([issue]);
    expect(stats.totalIssuesByRepo.map((r) => [r.repo, r.count])).toEqual([
      ["o/r", 4],
      ["x/y", 1],
    ]);
    expect(stats.totalPrsByRepo.map((r) => [r.repo, r.count])).toEqual([
      ["o/r", 6],
      ["x/y", 2],
    ]);
  });

  test("passes through server-provided total counts (so cards can show counts past the 100-node search cap)", () => {
    const stats = buildStats({
      ...baseArgs,
      assignedIssuesTotalCount: 137,
      reviewRequestedPrsTotalCount: 215,
      personalReviewRequestsTotalCount: 4,
    });
    expect(stats.assignedIssuesTotalCount).toBe(137);
    expect(stats.reviewRequestsTotalCount).toBe(215);
    expect(stats.personalReviewRequestsTotalCount).toBe(4);
  });

  test("personalReviewRequests comes from the dedicated user-review-requested search, not filtered from the group list", () => {
    // Before this fix, the personal-reviews detail filtered the group list
    // (capped at 100), so personal items outside the first 100 group
    // results disappeared from the table even though the count was right.
    const personalA: RawStatItem = {
      repo: "o/r", number: 11, title: "personal A",
      url: "https://github.com/o/r/pull/11",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
    };
    const personalB: RawStatItem = {
      repo: "o/r", number: 22, title: "personal B (not in group list)",
      url: "https://github.com/o/r/pull/22",
      createdAt: "2026-04-30T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    };
    const stats = buildStats({
      ...baseArgs,
      reviewRequestedPrs: [reviewReq({ number: 99, reviewerLogins: [] })],
      personalReviewRequestedPrs: [personalA, personalB],
      personalReviewRequestsTotalCount: 2,
    });
    expect(stats.personalReviewRequests.map((p) => p.number)).toEqual([11, 22]);
  });
});

describe("DashboardPoller refresh resilience", () => {
  function rawPr(number: number): RawPr {
    return {
      repo: "me/app",
      number,
      baseRefName: "main",
      headRefName: `feature-${number}`,
      defaultBranch: "main",
      title: `PR ${number}`,
      url: `https://github.com/me/app/pull/${number}`,
      isDraft: false,
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      isInMergeQueue: false,
      autoMergeEnabled: false,
      headRefOid: `sha-${number}`,
      author: "me",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-21T00:00:00Z",
      reviews: [],
      reviewRequested: [],
      associatedOnBase: [],
      checks: [],
    };
  }

  function workload(prs: RawPr[]): ViewerWorkload {
    return {
      prs,
      assignedIssues: [],
      assignedIssuesTotalCount: 0,
      reviewRequestedPrs: [],
      reviewRequestedPrsTotalCount: 0,
      personalReviewRequestedPrs: [],
      personalReviewRequestsTotalCount: 0,
    };
  }

  // Minimal client: a scripted workload sequence + no-op everything else.
  function fakeClient(workloads: Array<() => Promise<ViewerWorkload>>): DashboardGitHubClient {
    let i = 0;
    return {
      fetchViewer: () => Promise.resolve({ login: "me" }),
      fetchViewerWorkload: () => workloads[Math.min(i++, workloads.length - 1)]!(),
      resolveRepoMeta: () => Promise.resolve(new Map()),
      fetchMergeQueue: () => Promise.resolve([]),
      fetchDefaultBranchHead: () => Promise.resolve(undefined),
      fetchDefaultBranchRecentRuns: () => Promise.resolve([]),
      listCircleConfigFiles: () => Promise.resolve([]),
      fetchTextFile: () => Promise.resolve(undefined),
      fetchActionsWorkflows: () => Promise.resolve([]),
      fetchLatestWorkflowRun: () => Promise.resolve(undefined),
    };
  }

  // The whole point of the fix: when a GitHub refresh throws (HTTP error or a
  // partial GraphQL error surfaced as a thrown viewer-missing), the poller must
  // keep the PRs from the last good fetch rather than broadcasting an empty
  // board.
  test("keeps the previous PRs when a later refresh throws", async () => {
    const snaps: DashboardSnapshot[] = [];
    const github = fakeClient([
      () => Promise.resolve(workload([rawPr(1), rawPr(2)])),
      () => Promise.reject(new Error("GitHub returned no viewer")),
    ]);
    const poller = new DashboardPoller({ github, onSnapshot: (s) => snaps.push(s) });

    await poller.refreshGitHub();
    expect(poller.getSnapshot().prs.map((p) => p.number).sort()).toEqual([1, 2]);

    await poller.refreshGitHub();
    const after = poller.getSnapshot();
    expect(after.prs.map((p) => p.number).sort()).toEqual([1, 2]);
    expect(after.errors.length).toBeGreaterThan(0);
  });
});

describe("DashboardPoller refreshProjectWorkflows", () => {
  const CIRCLE_CONFIG_YAML = [
    "workflows:",
    "  main:",
    "    jobs: [build]",
    "  weekly:",
    "    when: << pipeline.schedule.name >>",
    "    jobs: [report]",
  ].join("\n");

  function makeGitHubWithWorkflows(): DashboardGitHubClient {
    return {
      fetchViewer: () => Promise.resolve({ login: "me" }),
      fetchViewerWorkload: () =>
        Promise.resolve({
          prs: [],
          assignedIssues: [],
          assignedIssuesTotalCount: 0,
          reviewRequestedPrs: [],
          reviewRequestedPrsTotalCount: 0,
          personalReviewRequestedPrs: [],
          personalReviewRequestsTotalCount: 0,
        }),
      resolveRepoMeta: () => Promise.resolve(new Map()),
      fetchMergeQueue: () => Promise.resolve([]),
      fetchDefaultBranchHead: () =>
        Promise.resolve({ branch: "main", sha: "abc123", checks: [] }),
      fetchDefaultBranchRecentRuns: () => Promise.resolve([]),
      listCircleConfigFiles: () =>
        Promise.resolve([{ path: ".circleci/config.yml", content: CIRCLE_CONFIG_YAML }]),
      fetchTextFile: () => Promise.resolve(undefined),
      fetchActionsWorkflows: () => Promise.resolve([]),
      fetchLatestWorkflowRun: () => Promise.resolve(undefined),
    };
  }

  function makeCircleWithInsights(): CircleCiClient {
    return {
      getPipelineByNumber: () => Promise.resolve(undefined),
      getPipelineForSha: () => Promise.resolve(undefined),
      getLatestPipelineForBranch: () => Promise.resolve(undefined),
      listPipelinesForBranchSince: () => Promise.resolve([]),
      getWorkflows: () => Promise.resolve([]),
      getJobs: () => Promise.resolve([]),
      getFailedTests: () => Promise.resolve([]),
      getInsightsWorkflowNames: (_owner, _name) => Promise.resolve(["main"]),
      getInsightsWorkflowRuns: (_owner, _name, wf) =>
        Promise.resolve(
          wf === "main"
            ? [{ status: "success", created_at: "2026-06-20T00:00:00Z", stopped_at: "2026-06-20T00:01:00Z" }]
            : [],
        ),
    };
  }

  test("folds expected scheduled workflows into defaultBranchJobs", async () => {
    const snaps: DashboardSnapshot[] = [];
    const poller = new DashboardPoller({
      pinnedRepos: ["o/r"],
      github: makeGitHubWithWorkflows(),
      circle: makeCircleWithInsights(),
      onSnapshot: (s) => snaps.push(s),
    });

    await poller.refreshGitHub();
    await poller.refreshProjectWorkflows();

    const jobs = snaps.at(-1)!.defaultBranchJobs;
    const weekly = jobs.find((j) => j.name === "weekly");
    expect(weekly).toBeTruthy();
    expect(weekly!.scheduled).toBe(true);
    expect(weekly!.lastRun!.found).toBe(false);
  });
});
