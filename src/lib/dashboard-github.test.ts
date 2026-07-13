import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyRulesetReviewRequirements,
  buildPrCards,
  buildStacks,
  ghGraphql,
  ghRest,
  parseRepoMetaNode,
  parseReviewRequestNode,
  parseStatItemNode,
  rateLimitDelayMs,
  RealDashboardGitHubClient,
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
    changedFiles: [],
    rulesets: [],
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

describe("applyRulesetReviewRequirements", () => {
  const contractReviewRuleset = {
    target: "BRANCH",
    enforcement: "ACTIVE",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: {
      nodes: [{
        type: "PULL_REQUEST",
        parameters: {
          required_approving_review_count: 1,
          required_reviewers: [{
            minimum_approvals: 2,
            file_patterns: ["packages/contracts-bedrock/**", "!packages/contracts-bedrock/**/*.md"],
          }],
        },
      }],
    },
  };

  test("infers REVIEW_REQUIRED for optimism#21663's file-scoped required-reviewers rule", () => {
    const pr = mkRaw({
      repo: "ethereum-optimism/optimism",
      number: 21663,
      baseRefName: "develop",
      defaultBranch: "develop",
      headRefName: "aj/refactor/remove-cannon-kona-dev-feature",
      reviewDecision: "",
      changedFiles: ["packages/contracts-bedrock/src/libraries/DevFeatures.sol"],
      rulesets: [contractReviewRuleset],
    });

    applyRulesetReviewRequirements([pr]);

    expect(pr.reviewDecision).toBe("REVIEW_REQUIRED");
  });

  test("does not apply a file-scoped reviewer rule when only an excluded path changes", () => {
    const pr = mkRaw({
      repo: "o/r",
      number: 2,
      baseRefName: "main",
      headRefName: "docs",
      reviewDecision: "",
      changedFiles: ["packages/contracts-bedrock/README.md"],
    });
    const fileOnlyRuleset = structuredClone(contractReviewRuleset);
    fileOnlyRuleset.rules.nodes[0]!.parameters!.required_approving_review_count = 0;
    pr.rulesets = [fileOnlyRuleset];

    applyRulesetReviewRequirements([pr]);

    expect(pr.reviewDecision).toBe("");
  });

  test("keeps GitHub's non-empty review decision authoritative", () => {
    const pr = mkRaw({
      repo: "o/r",
      number: 3,
      baseRefName: "main",
      headRefName: "approved",
      reviewDecision: "APPROVED",
      changedFiles: ["packages/contracts-bedrock/src/Contract.sol"],
      rulesets: [contractReviewRuleset],
    });

    applyRulesetReviewRequirements([pr]);

    expect(pr.reviewDecision).toBe("APPROVED");
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

describe("ghRest / ghGraphql (direct GitHub REST/GraphQL over fetch)", () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.GH_TOKEN;
  let calls: { url: string; init: RequestInit | undefined }[];

  beforeEach(() => {
    calls = [];
    process.env.GH_TOKEN = "tok-123";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = realToken;
  });

  type FakeRes = { status?: number; body?: unknown; headers?: Record<string, string> };
  function mkRes(r: FakeRes): Response {
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.headers ?? {}),
      json: () => Promise.resolve(r.body ?? {}),
      text: () => Promise.resolve(JSON.stringify(r.body ?? {})),
    } as Response;
  }
  function stubFetch(r: FakeRes) {
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(mkRes(r));
    }) as typeof fetch;
  }
  // Replays responses in order; the last entry repeats once exhausted.
  function stubFetchSequence(rs: FakeRes[]) {
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(mkRes(rs[Math.min(calls.length - 1, rs.length - 1)]!));
    }) as typeof fetch;
  }

  test("ghRest hits api.github.com with the bearer token and returns parsed JSON", async () => {
    stubFetch({ body: { workflow_runs: [{ id: 1 }] } });
    const data = await ghRest("/repos/o/r/actions/runs?page=1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/actions/runs?page=1");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-123");
    expect(headers["Accept"]).toContain("github");
    expect(data).toEqual({ workflow_runs: [{ id: 1 }] });
  });

  test("ghRest returns undefined on a non-2xx response", async () => {
    stubFetch({ status: 404 });
    expect(await ghRest("/repos/o/r")).toBeUndefined();
  });

  test("ghGraphql POSTs query + variables to /graphql and unwraps the data field", async () => {
    stubFetch({ body: { data: { viewer: { login: "me" } } } });
    const data = await ghGraphql("query($a: String!) { x }", { a: "v" });
    expect(calls[0]!.url).toBe("https://api.github.com/graphql");
    expect(calls[0]!.init!.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toEqual({ query: "query($a: String!) { x }", variables: { a: "v" } });
    expect(data).toEqual({ viewer: { login: "me" } });
  });

  test("ghGraphql returns undefined on a non-2xx response", async () => {
    stubFetch({ status: 500 });
    expect(await ghGraphql("query { x }")).toBeUndefined();
  });

  test("omits the Authorization header when no token is set", async () => {
    delete process.env.GH_TOKEN;
    stubFetch({ body: {} });
    await ghRest("/x");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  test("retries after a rate-limit response, then returns the eventual success", async () => {
    stubFetchSequence([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 200, body: { workflow_runs: [] } },
    ]);
    const data = await ghRest("/repos/o/r/actions/runs");
    expect(calls).toHaveLength(2);
    expect(data).toEqual({ workflow_runs: [] });
  });

  test("gives up (returns undefined) after exhausting retries on persistent rate limiting", async () => {
    stubFetch({ status: 403, headers: { "retry-after": "0", "x-ratelimit-remaining": "0" } });
    const data = await ghRest("/repos/o/r");
    expect(data).toBeUndefined();
    // initial attempt + MAX_RETRIES (3) follow-ups
    expect(calls).toHaveLength(4);
  });
});

describe("RealDashboardGitHubClient.fetchViewerWorkload (failure handling)", () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.GH_TOKEN;

  beforeEach(() => {
    process.env.GH_TOKEN = "tok-123";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = realToken;
  });

  function stubResponse(status: number, body: unknown) {
    globalThis.fetch = ((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response)) as typeof fetch;
  }

  // GitHub answers HTTP 200 with `{ data: { viewer: null, ... }, errors: [...] }`
  // on a partial failure (e.g. a timeout resolving a busy repo's
  // statusCheckRollup). Treating that null viewer as "0 open PRs" wipes the
  // board, so it must throw and let the poller keep the last good snapshot.
  test("throws on a partial GraphQL error with a null viewer", async () => {
    stubResponse(200, {
      data: { viewer: null, assignedIssues: null, reviewRequestedPrs: null, personalReviewRequests: null },
      errors: [{ message: "Something went wrong while executing your query." }],
    });
    const client = new RealDashboardGitHubClient();
    await expect(client.fetchViewerWorkload()).rejects.toThrow();
  });

  // A network/HTTP-level failure leaves ghGraphql with no data at all.
  test("throws when the request fails at the HTTP level", async () => {
    stubResponse(502, {});
    const client = new RealDashboardGitHubClient();
    await expect(client.fetchViewerWorkload()).rejects.toThrow();
  });

  // A genuinely empty account (viewer present, no open PRs) must NOT throw —
  // an empty board is the correct render here, not a stale one.
  test("returns an empty workload when the viewer has no open PRs", async () => {
    stubResponse(200, {
      data: {
        viewer: { pullRequests: { nodes: [] } },
        assignedIssues: { issueCount: 0, nodes: [] },
        reviewRequestedPrs: { issueCount: 0, nodes: [] },
        personalReviewRequests: { issueCount: 0, nodes: [] },
      },
    });
    const client = new RealDashboardGitHubClient();
    const workload = await client.fetchViewerWorkload();
    expect(workload.prs).toEqual([]);
    expect(workload.assignedIssues).toEqual([]);
    expect(workload.reviewRequestedPrs).toEqual([]);
  });
});

describe("fetchViewerWorkload (adaptive combined→split + repo scoping)", () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.GH_TOKEN;
  let queries: string[] = [];

  beforeEach(() => {
    process.env.GH_TOKEN = "tok-123";
    queries = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = realToken;
  });

  const samplePrNode = {
    repository: { nameWithOwner: "org/a", isArchived: false, defaultBranchRef: { name: "main" } },
    number: 1,
    title: "T",
    url: "https://github.com/org/a/pull/1",
    isDraft: false,
    state: "OPEN",
    reviewDecision: "",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "main",
    headRefName: "feat",
    headRefOid: "abc123",
    author: { login: "me" },
    createdAt: "",
    updatedAt: "",
  };
  const emptySearches = {
    assignedIssues: { issueCount: 0, nodes: [] },
    reviewRequestedPrs: { issueCount: 0, nodes: [] },
    personalReviewRequests: { issueCount: 0, nodes: [] },
  };

  // Route each GraphQL request to a response based on its query text.
  function stubByQuery(handler: (q: string) => { status?: number; body?: unknown; emptyBody?: boolean }) {
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const q = (JSON.parse(String(init?.body ?? "{}")) as { query?: string }).query ?? "";
      queries.push(q);
      const r = handler(q);
      const status = r.status ?? 200;
      const text = r.emptyBody ? "" : JSON.stringify(r.body ?? {});
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: () => Promise.resolve(r.body ?? {}),
        text: () => Promise.resolve(text),
      } as Response);
    }) as typeof fetch;
  }

  test("falls back to split requests when the combined query times out, and stays split", async () => {
    stubByQuery((q) => {
      const hasSearch = q.includes("assignedIssues");
      const hasPr = q.includes("pullRequests") || q.includes("prs: search");
      if (hasSearch && hasPr) return { emptyBody: true }; // combined → server-side timeout
      if (q.includes("object(oid:")) {
        return { body: { data: { c0: { object: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [] } } } } } } };
      }
      if (hasSearch) return { body: { data: emptySearches } };
      return { body: { data: { viewer: { pullRequests: { nodes: [samplePrNode] } } } } };
    });

    const client = new RealDashboardGitHubClient();
    const wl = await client.fetchViewerWorkload();
    expect(wl.prs.map((p) => p.number)).toEqual([1]);
    // First request was the combined one (PRs + rollup + searches together).
    expect(queries[0]).toContain("statusCheckRollup");
    expect(queries[0]).toContain("assignedIssues");

    // A second refresh skips the combined query entirely.
    queries = [];
    const wl2 = await client.fetchViewerWorkload();
    expect(wl2.prs.map((p) => p.number)).toEqual([1]);
    const triedCombinedAgain = queries.some((q) => q.includes("statusCheckRollup") && q.includes("assignedIssues"));
    expect(triedCombinedAgain).toBe(false);
  });

  test("filters results to the configured repos client-side, leaving the queries unscoped", async () => {
    const inScope = { ...samplePrNode, number: 1, repository: { ...samplePrNode.repository, nameWithOwner: "org/a" } };
    const outScope = { ...samplePrNode, number: 2, repository: { ...samplePrNode.repository, nameWithOwner: "org/other" } };
    const issue = (n: number, repo: string) => ({ number: n, title: "i", url: "", createdAt: "", updatedAt: "", repository: { nameWithOwner: repo } });
    stubByQuery(() => ({
      body: {
        data: {
          viewer: { pullRequests: { nodes: [inScope, outScope] } },
          assignedIssues: { issueCount: 9, nodes: [issue(10, "org/a"), issue(11, "org/other")] },
          reviewRequestedPrs: { issueCount: 0, nodes: [] },
          personalReviewRequests: { issueCount: 0, nodes: [] },
        },
      },
    }));

    const client = new RealDashboardGitHubClient({ scopeRepos: ["org/a"] });
    const wl = await client.fetchViewerWorkload();

    expect(wl.prs.map((p) => `${p.repo}#${p.number}`)).toEqual(["org/a#1"]);
    expect(wl.assignedIssues.map((i) => i.repo)).toEqual(["org/a"]);
    // Counts are recomputed from the filtered set, not GitHub's unscoped total.
    expect(wl.assignedIssuesTotalCount).toBe(1);
    // The query itself is unscoped (works for fine-grained PATs); no repo: qualifier.
    expect(queries[0]).not.toContain("repo:org/a");
    expect(queries[0]).toContain("pullRequests(first: 50");
    expect(queries[0]).toContain("rulesets(first: 100");
    // Rulesets are bundled into the PR GraphQL selection; no body-less REST
    // request is made after the workload query.
    expect(queries.every(Boolean)).toBe(true);
  });
});

describe("rateLimitDelayMs", () => {
  const reset = (secsFromNow: number, now: number) => String(Math.floor(now / 1000) + secsFromNow);

  test("returns null for non-rate-limit responses", () => {
    expect(rateLimitDelayMs({ status: 200, headers: new Headers() }, 0)).toBeNull();
    expect(rateLimitDelayMs({ status: 404, headers: new Headers() }, 0)).toBeNull();
    // A 403 that isn't a rate limit (e.g. plain forbidden) shouldn't trigger retries.
    expect(rateLimitDelayMs({ status: 403, headers: new Headers() }, 0)).toBeNull();
  });

  test("honours Retry-After (seconds) on a 429", () => {
    expect(rateLimitDelayMs({ status: 429, headers: new Headers({ "retry-after": "2" }) }, 0)).toBe(2000);
  });

  test("waits until X-RateLimit-Reset when the primary limit is exhausted (403 + remaining 0)", () => {
    const now = 1_000_000_000_000;
    const delay = rateLimitDelayMs(
      { status: 403, headers: new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset(5, now) }) },
      now,
    );
    expect(delay).toBe(5000);
  });

  test("falls back to a brief pause when rate-limited with no timing hint", () => {
    expect(rateLimitDelayMs({ status: 429, headers: new Headers() }, 0)).toBe(1000);
  });

  test("gives up (null) when the required wait exceeds the cap — don't stall the poll cycle", () => {
    const now = 1_000_000_000_000;
    expect(
      rateLimitDelayMs(
        { status: 403, headers: new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset(3600, now) }) },
        now,
      ),
    ).toBeNull();
  });

  test("clamps a past reset to 0 rather than returning a negative delay", () => {
    const now = 1_000_000_000_000;
    expect(
      rateLimitDelayMs(
        { status: 403, headers: new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset(-10, now) }) },
        now,
      ),
    ).toBe(0);
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
