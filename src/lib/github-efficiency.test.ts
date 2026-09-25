import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ghGraphql, ghRest, githubUsage, resetGitHubTransport } from "./github-transport.ts";
import { RealDashboardGitHubClient } from "./dashboard-github.ts";

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realToken = process.env.GH_TOKEN;
const realReserve = process.env.DASHBOARD_GITHUB_RESERVE;
let now: number;
let calls: { url: string; query: string; vars: any; headers: Headers }[];
let respond: (call: typeof calls[number]) => Response | Promise<Response>;
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  now = Date.parse("2026-09-25T12:05:00Z");
  Date.now = () => now;
  process.env.GH_TOKEN = "test-token";
  process.env.DASHBOARD_GITHUB_RESERVE = "1000";
  resetGitHubTransport();
  calls = [];
  respond = () => { throw new Error("Unexpected request"); };
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call = { url: String(url), query: body.query ?? "", vars: body.variables ?? {}, headers: new Headers(init?.headers) };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  if (realToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = realToken;
  if (realReserve === undefined) delete process.env.DASHBOARD_GITHUB_RESERVE; else process.env.DASHBOARD_GITHUB_RESERVE = realReserve;
  resetGitHubTransport();
});

describe("shared GitHub transport", () => {
  test("conditional reads reuse 304 bodies and keep credentials out of usage diagnostics", async () => {
    respond = () => calls.length === 1 ? json({ runs: [1] }, { etag: '"v1"' }) : new Response(null, { status: 304 });
    expect(await ghRest("/repos/o/r/actions/runs")).toEqual({ runs: [1] });
    expect(await ghRest("/repos/o/r/actions/runs")).toEqual({ runs: [1] });
    expect(calls[1]!.headers.get("if-none-match")).toBe('"v1"');
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer test-token");
    expect(githubUsage().operations["rest.runs"]).toEqual({ requests: 2, notModified: 1, errors: 0, points: 1 });
    expect(JSON.stringify(githubUsage())).not.toContain("test-token");
  });

  test("changing credentials invalidates cached representations", async () => {
    respond = () => json({ value: process.env.GH_TOKEN }, { etag: '"v1"' });
    await ghRest("/x");
    process.env.GH_TOKEN = "different-token";
    await ghRest("/x");
    expect(calls[1]!.headers.has("if-none-match")).toBe(false);
  });

  test("successful responses crossing the reserve pause only that primary budget until reset", async () => {
    respond = call => call.query
      ? json({ data: { ok: true, rateLimit: { cost: 3 } } })
      : json({ ok: true }, { "x-ratelimit-remaining": "999", "x-ratelimit-reset": String(now / 1000 + 120), "x-ratelimit-limit": "5000" });
    await ghRest("/first");
    await expect(ghRest("/second")).rejects.toThrow("paused until");
    expect(await ghGraphql("query { viewer { login } }", {}, "graphql.viewer")).toMatchObject({ ok: true });
    expect(githubUsage().operations["graphql.viewer"]?.points).toBe(3);
    expect(calls).toHaveLength(2);
    now += 121_000;
    await ghRest("/second");
    expect(calls).toHaveLength(3);
  });

  test("HTTP-200 GraphQL exhaustion blocks already queued GraphQL requests, but not REST", async () => {
    respond = call => call.query
      ? json({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 3600) })
      : json({ ok: true });
    const results = await Promise.allSettled([ghGraphql("query { x }"), ghGraphql("query { y }"), ghRest("/x")]);
    expect(results.map(r => r.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(calls).toHaveLength(2);
    expect(githubUsage().budgets.graphql.pausedUntil).toBe(now + 3_600_000);
  });

  test("secondary limits pause both APIs and back off across subsequent failures", async () => {
    respond = () => json({ errors: [{ message: "You have exceeded a secondary rate limit" }] });
    await expect(ghGraphql("query { x }")).rejects.toThrow("rate limited");
    await expect(ghRest("/x")).rejects.toThrow("paused until");
    now += 60_000;
    await expect(ghGraphql("query { x }")).rejects.toThrow("rate limited");
    expect(githubUsage().secondaryUntil).toBe(now + 120_000);
    expect(calls).toHaveLength(2);
  });

  test("requests are serialized through response parsing", async () => {
    let active = 0;
    let peak = 0;
    respond = async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return json({});
    };
    await Promise.all(Array.from({ length: 10 }, (_, i) => ghRest(`/x/${i}`)));
    expect(peak).toBe(1);
  });

  test("404s are negatively cached, expire, and do not swallow server failures", async () => {
    respond = () => json({}, {}, 404);
    await ghRest("/missing");
    await ghRest("/missing");
    expect(calls).toHaveLength(1);
    now += 30 * 60_000;
    respond = () => json({}, {}, 503);
    await expect(ghRest("/missing")).rejects.toThrow("HTTP 503");
    respond = () => json({ found: true });
    expect(await ghRest("/missing")).toEqual({ found: true });
  });
});

const searches = {
  assignedIssues: { issueCount: 0, nodes: [] },
  reviewRequestedPrs: { issueCount: 0, nodes: [] },
  personalReviewRequests: { issueCount: 0, nodes: [] },
};
function pr(number: number, base = "base-a") {
  return {
    repository: { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } },
    number, headRefOid: "head-a", baseRefOid: base, baseRefName: "main", headRefName: `pr-${number}`,
  };
}
const rules = [{ target: "BRANCH", enforcement: "ACTIVE", rules: { nodes: [{ type: "PULL_REQUEST", parameters: { required_reviewers: [{ minimum_approvals: 1, file_patterns: ["src/**"] }] } }] } }];

describe("repository and PR caches", () => {
  test("two PRs share rulesets; searches expire slowly; file paths invalidate on base changes", async () => {
    let base = "base-a";
    respond = call => {
      if (call.query.includes("rulesets(")) return json({ data: { repository: { rulesets: { nodes: rules } } } });
      if (call.query.includes("files(first:")) return json({ data: { repository: { pullRequest: { files: { nodes: [{ path: "src/a.ts" }], pageInfo: { hasNextPage: false } } } } } });
      return json({ data: { viewer: { pullRequests: { nodes: [pr(1, base), pr(2)] } }, ...searches } });
    };
    const client = new RealDashboardGitHubClient();
    await client.fetchViewerWorkload();
    await client.fetchViewerWorkload();
    expect(calls.filter(c => c.query.includes("rulesets("))).toHaveLength(1);
    expect(calls.filter(c => c.query.includes("files(first:"))).toHaveLength(2);
    expect(calls.filter(c => c.query.includes("assignedIssues:"))).toHaveLength(1);
    expect(calls.filter(c => c.query.includes("viewer {")).every(c => !c.query.includes("rulesets("))).toBe(true);
    base = "base-b";
    await client.fetchViewerWorkload();
    expect(calls.filter(c => c.query.includes("files(first:"))).toHaveLength(3);
    now += 5 * 60_000;
    await client.fetchViewerWorkload();
    expect(calls.filter(c => c.query.includes("assignedIssues:"))).toHaveLength(2);
    now += 25 * 60_000;
    await client.fetchViewerWorkload();
    expect(calls.filter(c => c.query.includes("rulesets("))).toHaveLength(2);
  });

  test("changed files paginate and are not refetched for unchanged head/base", async () => {
    respond = call => {
      if (call.query.includes("rulesets(")) return json({ data: { repository: { rulesets: { nodes: rules } } } });
      if (call.query.includes("files(first:")) return json({ data: { repository: { pullRequest: { files: {
        nodes: [{ path: call.vars.after ? "src/b.ts" : "src/a.ts" }],
        pageInfo: { hasNextPage: !call.vars.after, endCursor: "next" },
      } } } } });
      return json({ data: { viewer: { pullRequests: { nodes: [pr(1)] } }, ...searches } });
    };
    const client = new RealDashboardGitHubClient();
    expect((await client.fetchViewerWorkload()).prs[0]!.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    await client.fetchViewerWorkload();
    expect(calls.filter(c => c.query.includes("files(first:"))).toHaveLength(2);
  });

  test("repository metadata is deduplicated and cached for five minutes", async () => {
    respond = () => json({ data: { r0: { nameWithOwner: "o/r", openIssues: { totalCount: 2 }, openPrs: { totalCount: 3 } } } });
    const client = new RealDashboardGitHubClient();
    expect((await client.resolveRepoMeta(["o/r", "o/r"])).get("o/r")?.openPrs).toBe(3);
    expect(calls[0]!.query).not.toContain("r1:");
    await client.resolveRepoMeta(["o/r"]);
    expect(calls).toHaveLength(1);
    now += 300_000;
    await client.resolveRepoMeta(["o/r"]);
    expect(calls).toHaveLength(2);
  });

  test("repository activity batches queues and heads, but keeps checks live at unchanged SHA", async () => {
    let status = "IN_PROGRESS";
    const node = () => ({ mergeQueue: { entries: { nodes: [] } }, defaultBranchRef: { name: "main", target: {
      oid: "unchanged", statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "test", status }], pageInfo: { hasNextPage: false } } },
    } } });
    respond = () => json({ data: { r0: node(), r1: node() } });
    const client = new RealDashboardGitHubClient();
    const first = await client.fetchRepositoryActivity(["o/r", "o/s"], ["o/r", "o/s"]);
    expect(first.heads).toHaveLength(2);
    expect(calls).toHaveLength(1);
    status = "COMPLETED";
    const second = await client.fetchRepositoryActivity(["o/r", "o/s"], ["o/r"]);
    expect(second.heads).toHaveLength(1);
    expect(second.heads[0]!.checks[0]!.status).toBe("COMPLETED");
  });

  test("CircleCI and Actions discovery share immutable head trees and file contents", async () => {
    respond = call => {
      if (call.query) return json({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "sha" } } } } });
      if (call.url.includes("/git/trees/")) return json({ tree: [{ type: "blob", path: ".circleci/config.yml" }, { type: "blob", path: ".github/workflows/ci.yml" }] });
      if (call.url.includes("/contents/")) return json({ content: Buffer.from("on: push").toString("base64"), encoding: "base64" });
      return json({ workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] });
    };
    const client = new RealDashboardGitHubClient();
    await client.listCircleConfigFiles("o/r");
    await client.fetchActionsWorkflows("o/r");
    await client.fetchActionsWorkflows("o/r");
    await client.fetchTextFile("o/r", ".circleci/config.yml", "sha");
    expect(calls.filter(c => c.query)).toHaveLength(1);
    expect(calls.filter(c => c.url.includes("/git/trees/"))).toHaveLength(1);
    expect(calls.filter(c => c.url.includes("/contents/"))).toHaveLength(1);
    expect(calls.filter(c => c.url.includes("/actions/workflows"))).toHaveLength(1);
  });
});

function run(id: number, hoursAgo = 0, status = "completed") {
  return { id, workflow_id: 1, name: "CI", path: ".github/workflows/ci.yml", event: "push", status,
    conclusion: status === "completed" ? "success" : null, head_sha: "same-sha",
    created_at: new Date(now - hoursAgo * 3_600_000).toISOString(), updated_at: new Date(now).toISOString() };
}

describe("incremental Actions history", () => {
  test("bootstrap pages once, stop at known history, refresh old active runs, then reconcile old reruns", async () => {
    const oldActive = run(500, 10, "in_progress");
    const history = Array.from({ length: 100 }, (_, i) => run(i + 1, i / 100));
    const older = run(501, 20);
    let phase = "bootstrap";
    respond = call => {
      if (call.url.endsWith("/actions/runs/500")) return json({ ...oldActive, status: "completed", conclusion: "failure" });
      const page = new URL(call.url).searchParams.get("page");
      if (phase === "bootstrap") return json({ workflow_runs: page === "1" ? history : [oldActive, older] });
      if (phase === "incremental") return json({ workflow_runs: [run(600), ...history.slice(0, 99)] });
      return json({ workflow_runs: page === "1" ? history : [{ ...older, status: "in_progress", conclusion: null }] });
    };
    const client = new RealDashboardGitHubClient();
    expect(await client.fetchDefaultBranchRecentRuns("o/r", "main", 72)).toHaveLength(102);
    expect(calls).toHaveLength(2);
    phase = "incremental"; now += 60_000;
    const updated = await client.fetchDefaultBranchRecentRuns("o/r", "main", 72);
    expect(calls).toHaveLength(4); // one discovery page + one old active run
    expect(updated.find(r => r.runId === 500)?.conclusion).toBe("failure");
    expect(updated.some(r => r.runId === 501)).toBe(true); // old terminal result retained
    expect(calls[2]!.url).not.toBe(calls[0]!.url); // short incremental window
    now += 60_000;
    await client.fetchDefaultBranchRecentRuns("o/r", "main", 72);
    expect(calls.at(-1)!.url).toBe(calls[2]!.url); // stable within bucket for ETags
    phase = "reconcile"; now += 30 * 60_000;
    const reconciled = await client.fetchDefaultBranchRecentRuns("o/r", "main", 72);
    expect(reconciled.find(r => r.runId === 501)?.status).toBe("in_progress");
  });

  test("does not request beyond GitHub's 1,000-result filtered-search cap", async () => {
    respond = call => {
      const page = Number(new URL(call.url).searchParams.get("page"));
      if (page > 10) throw new Error("Exceeded search cap");
      return json({ workflow_runs: Array.from({ length: 100 }, (_, i) => run(page * 100 + i)) });
    };
    const runs = await new RealDashboardGitHubClient().fetchDefaultBranchRecentRuns("o/r", "main", 72);
    expect(runs).toHaveLength(1000);
    expect(calls).toHaveLength(10);
  });

  test("failed refresh does not overwrite cached history or advance the reconciliation clock", async () => {
    respond = () => json({ workflow_runs: [run(1, 10)] });
    const client = new RealDashboardGitHubClient();
    await client.fetchDefaultBranchRecentRuns("o/r", "main", 72);
    now += 60_000;
    respond = () => json({}, {}, 502);
    await expect(client.fetchDefaultBranchRecentRuns("o/r", "main", 72)).rejects.toThrow();
    respond = () => json({ workflow_runs: [run(2)] });
    expect((await client.fetchDefaultBranchRecentRuns("o/r", "main", 72)).map(r => r.runId)).toEqual([1, 2]);
  });
});
