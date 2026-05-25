import { describe, expect, test } from "bun:test";
import {
  buildStats,
  buildTotalsByRepo,
  dedupReposByCanonical,
  deriveGhOrigin,
} from "./dashboard-poller.ts";
import type { RawReviewRequestItem, RawStatItem, RepoMeta } from "./dashboard-github.ts";

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
});
