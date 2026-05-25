import { describe, expect, test } from "bun:test";
import {
  buildPrCards,
  buildStacks,
  parseRepoMetaNode,
  parseReviewRequestNode,
  parseStatItemNode,
  type RawPr,
} from "./dashboard-github.ts";

function mkRaw(over: Partial<RawPr> & { repo: string; number: number; baseRefName: string; headRefName: string }): RawPr {
  return {
    defaultBranch: "main",
    title: `PR ${over.number}`,
    url: `https://github.com/${over.repo}/pull/${over.number}`,
    isDraft: false,
    state: "OPEN",
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    isInMergeQueue: false,
    autoMergeEnabled: false,
    headRefOid: `sha-${over.number}`,
    author: "me",
    createdAt: "2026-05-20T00:00:00Z",
    updatedAt: "2026-05-21T00:00:00Z",
    reviews: [],
    reviewRequested: [],
    associatedOnBase: [],
    checks: [],
    ...over,
  };
}

describe("buildPrCards", () => {
  test("detects parent PR when baseRef matches another PR's head", () => {
    const raws: RawPr[] = [
      mkRaw({ repo: "o/r", number: 1, baseRefName: "main", headRefName: "feat-a" }),
      mkRaw({
        repo: "o/r",
        number: 2,
        baseRefName: "feat-a",
        headRefName: "feat-b",
        associatedOnBase: [{ repo: "o/r", number: 1, state: "OPEN", headRefName: "feat-a" }],
      }),
    ];
    const cards = buildPrCards(raws);
    expect(cards[0]!.parentPr).toBeUndefined();
    expect(cards[1]!.parentPr).toEqual({ repo: "o/r", number: 1, state: "OPEN" });
  });

  test("PR targeting default branch is never stacked (default-branch sync PRs aren't parents)", () => {
    // Real case: ethereum-optimism/optimism PR targeting "develop" was matched
    // against PR #958 ("Develop Master Merge", head=develop, base=master).
    // A PR targeting the repo's default branch is a root by definition; any
    // other PR whose head is the default branch is a sync PR, not a parent.
    const raws: RawPr[] = [
      mkRaw({
        repo: "o/r",
        number: 100,
        baseRefName: "develop",
        headRefName: "aj/feat/x",
        defaultBranch: "develop",
        associatedOnBase: [
          { repo: "o/r", number: 958, state: "MERGED", headRefName: "develop" },
        ],
      }),
    ];
    const cards = buildPrCards(raws);
    expect(cards[0]!.parentPr).toBeUndefined();
  });

  test("ignores cross-repo associatedOnBase matches (forks of upstream share branch names)", () => {
    // GitHub's baseRef.associatedPullRequests can return PRs from forks whose
    // headRefName collides with our baseRefName — e.g. omgnetwork/optimism#9
    // with headRefName "develop" is not a parent of ethereum-optimism/optimism PRs
    // targeting "develop". Parent must be in the same repo.
    const raws: RawPr[] = [
      mkRaw({
        repo: "ethereum-optimism/optimism",
        number: 20997,
        baseRefName: "develop",
        headRefName: "aj/chore/x",
        associatedOnBase: [
          { repo: "omgnetwork/optimism", number: 9, state: "MERGED", headRefName: "develop" },
        ],
      }),
    ];
    const cards = buildPrCards(raws);
    expect(cards[0]!.parentPr).toBeUndefined();
  });

  test("propagates autoMergeEnabled from RawPr to PrCard", () => {
    const raws: RawPr[] = [
      mkRaw({ repo: "o/r", number: 1, baseRefName: "main", headRefName: "feat-a", autoMergeEnabled: true }),
      mkRaw({ repo: "o/r", number: 2, baseRefName: "main", headRefName: "feat-b", autoMergeEnabled: false }),
      mkRaw({ repo: "o/r", number: 3, baseRefName: "main", headRefName: "feat-c" }),
    ];
    const cards = buildPrCards(raws);
    expect(cards[0]!.autoMergeEnabled).toBe(true);
    expect(cards[1]!.autoMergeEnabled).toBe(false);
    expect(cards[2]!.autoMergeEnabled).toBe(false);
  });
});

describe("buildStacks", () => {
  test("groups a linear stack and orders base-up", () => {
    const raws: RawPr[] = [
      mkRaw({ repo: "o/r", number: 1, baseRefName: "main", headRefName: "feat-a" }),
      mkRaw({
        repo: "o/r",
        number: 2,
        baseRefName: "feat-a",
        headRefName: "feat-b",
        associatedOnBase: [{ repo: "o/r", number: 1, state: "OPEN", headRefName: "feat-a" }],
      }),
      mkRaw({
        repo: "o/r",
        number: 3,
        baseRefName: "feat-b",
        headRefName: "feat-c",
        associatedOnBase: [{ repo: "o/r", number: 2, state: "OPEN", headRefName: "feat-b" }],
      }),
    ];
    const cards = buildPrCards(raws);
    const stacks = buildStacks(cards);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.prKeys).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
  });

  test("separate PRs land in separate stacks", () => {
    const raws: RawPr[] = [
      mkRaw({ repo: "o/r", number: 1, baseRefName: "main", headRefName: "f-a" }),
      mkRaw({ repo: "o/r", number: 2, baseRefName: "main", headRefName: "f-b" }),
    ];
    const stacks = buildStacks(buildPrCards(raws));
    expect(stacks).toHaveLength(2);
    expect(stacks.every((s) => s.prKeys.length === 1)).toBe(true);
  });

  test("repeated calls on the same cards don't duplicate descendants (poller reuses cards between GitHub refreshes)", () => {
    const raws: RawPr[] = [
      mkRaw({ repo: "o/r", number: 1, baseRefName: "main", headRefName: "feat-a" }),
      mkRaw({
        repo: "o/r",
        number: 2,
        baseRefName: "feat-a",
        headRefName: "feat-b",
        associatedOnBase: [{ repo: "o/r", number: 1, state: "OPEN", headRefName: "feat-a" }],
      }),
      mkRaw({
        repo: "o/r",
        number: 3,
        baseRefName: "feat-b",
        headRefName: "feat-c",
        associatedOnBase: [{ repo: "o/r", number: 2, state: "OPEN", headRefName: "feat-b" }],
      }),
    ];
    const cards = buildPrCards(raws);
    buildStacks(cards);
    buildStacks(cards);
    const stacks = buildStacks(cards);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.prKeys).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
  });

  test("ignores parent when parent isn't in the visible PR set", () => {
    const raws: RawPr[] = [
      mkRaw({
        repo: "o/r",
        number: 2,
        baseRefName: "feat-a",
        headRefName: "feat-b",
        associatedOnBase: [{ repo: "o/r", number: 99, state: "MERGED", headRefName: "feat-a" }],
      }),
    ];
    const stacks = buildStacks(buildPrCards(raws));
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.prKeys).toEqual(["o/r#2"]);
  });
});

describe("parseRepoMetaNode", () => {
  test("extracts canonical name and totals from a populated node", () => {
    const meta = parseRepoMetaNode(
      {
        nameWithOwner: "owner/canonical",
        openIssues: { totalCount: 3 },
        openPrs: { totalCount: 7 },
      },
      "input/alias",
    );
    expect(meta).toEqual({ canonical: "owner/canonical", openIssues: 3, openPrs: 7 });
  });

  test("falls back to the input repo when the node is null", () => {
    expect(parseRepoMetaNode(null, "a/b")).toEqual({ canonical: "a/b", openIssues: 0, openPrs: 0 });
  });

  test("treats missing totalCount as 0", () => {
    const meta = parseRepoMetaNode({ nameWithOwner: "a/b" }, "a/b");
    expect(meta).toEqual({ canonical: "a/b", openIssues: 0, openPrs: 0 });
  });
});

describe("parseStatItemNode", () => {
  test("extracts repo, number, title, url, and timestamps from a search node", () => {
    const item = parseStatItemNode({
      number: 42,
      title: "Fix the thing",
      url: "https://github.com/o/r/issues/42",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-22T00:00:00Z",
      repository: { nameWithOwner: "o/r" },
    });
    expect(item).toEqual({
      repo: "o/r",
      number: 42,
      title: "Fix the thing",
      url: "https://github.com/o/r/issues/42",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-22T00:00:00Z",
    });
  });

  test("returns undefined when the node is missing repo or number (likely a non-Issue/PR result)", () => {
    expect(parseStatItemNode({ number: 1 })).toBeUndefined();
    expect(parseStatItemNode({ repository: { nameWithOwner: "o/r" } })).toBeUndefined();
    expect(parseStatItemNode(null)).toBeUndefined();
  });
});

describe("parseReviewRequestNode", () => {
  test("captures User reviewer logins in reviewerLogins", () => {
    const item = parseReviewRequestNode({
      number: 5,
      title: "Add the feature",
      url: "https://github.com/o/r/pull/5",
      createdAt: "2026-05-19T00:00:00Z",
      updatedAt: "2026-05-21T00:00:00Z",
      repository: { nameWithOwner: "o/r" },
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "User", login: "alice" } },
          { requestedReviewer: { __typename: "User", login: "bob" } },
        ],
      },
    });
    expect(item?.reviewerLogins).toEqual(["alice", "bob"]);
  });

  test("ignores Team reviewers (no login on team nodes)", () => {
    const item = parseReviewRequestNode({
      number: 5,
      title: "Add the feature",
      url: "https://github.com/o/r/pull/5",
      createdAt: "2026-05-19T00:00:00Z",
      updatedAt: "2026-05-21T00:00:00Z",
      repository: { nameWithOwner: "o/r" },
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "Team", name: "platform" } },
        ],
      },
    });
    expect(item?.reviewerLogins).toEqual([]);
  });

  test("handles missing reviewRequests gracefully", () => {
    const item = parseReviewRequestNode({
      number: 5,
      title: "x",
      url: "u",
      createdAt: "c",
      updatedAt: "u",
      repository: { nameWithOwner: "o/r" },
    });
    expect(item?.reviewerLogins).toEqual([]);
  });
});
