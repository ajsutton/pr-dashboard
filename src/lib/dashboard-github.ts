/**
 * GitHub GraphQL queries for the PR dashboard. Independent from the
 * existing todo-refresh batcher so we can request exactly what the
 * dashboard cares about in as few round-trips as possible.
 */

import type { PrCard, MergeQueueEntry } from "../types.ts";

export interface RawCheckContext {
  __typename: "CheckRun" | "StatusContext" | string;
  name?: string | undefined;
  context?: string | undefined;
  status?: string | undefined;
  conclusion?: string | undefined;
  state?: string | undefined;
  detailsUrl?: string | undefined;
  targetUrl?: string | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  workflowName?: string | undefined;
}

export interface RawPr {
  repo: string;
  defaultBranch: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: string;
  reviewDecision: string;
  mergeable: string;
  mergeStateStatus: string;
  isInMergeQueue: boolean;
  autoMergeEnabled: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  reviews: { login: string; state: string; submittedAt: string }[];
  reviewRequested: string[];
  associatedOnBase: { repo: string; number: number; state: string; headRefName: string }[];
  checks: RawCheckContext[];
}

export interface RawMergeQueueEntry extends MergeQueueEntry {
  /** Head merge commit being tested — used to attach CircleCI/GH-Actions status. */
  headSha: string;
  headChecks: RawCheckContext[];
}

/**
 * GitHub Actions workflow run not attached to a specific push commit —
 * scheduled or manually-dispatched runs on the default branch. These never
 * appear in `statusCheckRollup`, so we pull them via the REST runs endpoint.
 */
export interface RawWorkflowRun {
  workflowId: number;
  workflowName: string;
  event: string;
  status: string;
  conclusion: string | undefined;
  createdAt: string;
  startedAt: string | undefined;
  updatedAt: string;
  headSha: string;
  url: string;
  runId: number;
}

/**
 * Per-repo metadata fetched alongside canonical-name resolution. Open issue +
 * PR counts are surfaced in the dashboard's totals cards.
 */
export interface RepoMeta {
  /** Canonical `owner/name` GitHub currently reports for this repo. */
  canonical: string;
  openIssues: number;
  openPrs: number;
}

/**
 * What the viewer query returns. PRs the viewer authored, plus the two
 * workload search results (issues assigned to the viewer + PRs where the
 * viewer or one of their teams is a requested reviewer).
 *
 * `*TotalCount` come from `search.issueCount` and reflect the true total —
 * `nodes` is capped at 100 by the GraphQL API, so the count on the stats
 * cards must use these rather than `nodes.length`.
 */
export interface ViewerWorkload {
  prs: RawPr[];
  assignedIssues: RawStatItem[];
  assignedIssuesTotalCount: number;
  reviewRequestedPrs: RawReviewRequestItem[];
  reviewRequestedPrsTotalCount: number;
  /**
   * Items from a `user-review-requested:@me` search — only PRs where the
   * viewer's own login is requested, not any team they belong to. Capped
   * at 100 by the GraphQL search-node limit; the true count is in
   * `personalReviewRequestsTotalCount`.
   */
  personalReviewRequestedPrs: RawStatItem[];
  personalReviewRequestsTotalCount: number;
}

export interface RawStatItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface RawReviewRequestItem extends RawStatItem {
  /** Logins of requested User reviewers. Used to derive isPersonal. */
  reviewerLogins: string[];
}

export interface DashboardGitHubClient {
  fetchViewer(): Promise<{ login: string }>;
  /**
   * One GraphQL request that returns PRs the viewer authored plus the two
   * search-based workload feeds (assigned issues + review-requested PRs).
   * Folding all three into a single round-trip keeps refresh latency tight.
   */
  fetchViewerWorkload(): Promise<ViewerWorkload>;
  /**
   * Resolve each `owner/name` through GitHub to its current canonical
   * `nameWithOwner`, plus per-repo open issue / PR counts used by the
   * dashboard's totals cards. Transferred/renamed repos resolve to their new
   * name; the map is keyed by the input. Repos GitHub can't find (deleted,
   * no access) map back to `{ canonical: input, openIssues: 0, openPrs: 0 }`.
   */
  resolveRepoMeta(repos: string[]): Promise<Map<string, RepoMeta>>;
  fetchMergeQueue(repo: string): Promise<RawMergeQueueEntry[]>;
  fetchDefaultBranchHead(repo: string): Promise<{ branch: string; sha: string; checks: RawCheckContext[] } | undefined>;
  /**
   * Every GitHub Actions run against the branch in the last `windowHours`,
   * across every trigger event (push, schedule, workflow_dispatch, …). Not
   * deduped — the caller picks both the latest and the latest-completed per
   * workflow so cards can show progress + last-result colour.
   */
  fetchDefaultBranchRecentRuns(repo: string, branch: string, windowHours: number): Promise<RawWorkflowRun[]>;
}

const GITHUB_API = "https://api.github.com";

/**
 * Headers for every GitHub call. Auth comes from `$GH_TOKEN` (the same env var
 * the `gh` CLI reads), so the host setup is unchanged — only the transport
 * moved from spawning `gh` to native `fetch`, which lets the Docker image drop
 * the gh CLI entirely. Only github.com is supported (no GHE).
 */
function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "pr-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GH_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** Follow-up attempts after the first request when GitHub rate-limits us. */
const MAX_RETRIES = 3;
/**
 * Never block a single request longer than this waiting out a rate limit. The
 * poller refreshes GitHub every 60s, so if the reset is further off than this
 * it's cheaper to give up and let the next cycle retry than to stall the whole
 * refresh behind one request.
 */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

/**
 * If `res` indicates a GitHub rate limit (primary or secondary), return how
 * long to wait before retrying in ms; otherwise null. Also returns null when
 * the wait would exceed MAX_RATE_LIMIT_WAIT_MS — caller should give up rather
 * than stall. Exported for unit tests.
 *
 * Signals, in priority order:
 *  - `Retry-After: <seconds>` — sent for secondary (abuse) limits.
 *  - `X-RateLimit-Reset: <epoch seconds>` when `X-RateLimit-Remaining: 0` —
 *    primary limit exhausted; wait until the window resets.
 *  - 429/403 with neither hint — brief fixed pause.
 */
export function rateLimitDelayMs(res: { status: number; headers: Headers }, now: number): number | null {
  const retryAfter = res.headers.get("retry-after");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  const limited = res.status === 429 || (res.status === 403 && (remaining === "0" || retryAfter !== null));
  if (!limited) return null;

  let waitMs: number;
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
    waitMs = parseInt(retryAfter, 10) * 1000;
  } else if (reset !== null && /^\d+$/.test(reset.trim())) {
    waitMs = parseInt(reset, 10) * 1000 - now;
  } else {
    waitMs = 1000;
  }
  waitMs = Math.max(0, waitMs);
  return waitMs > MAX_RATE_LIMIT_WAIT_MS ? null : waitMs;
}

/**
 * fetch() wrapper that transparently waits out and retries GitHub rate limits.
 * Returns the final Response (success or otherwise) so callers handle non-2xx
 * uniformly, or undefined if the request itself threw.
 */
async function githubFetch(url: string, init?: RequestInit): Promise<Response | undefined> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      return undefined;
    }
    if (res.ok || attempt >= MAX_RETRIES) return res;
    const delay = rateLimitDelayMs(res, Date.now());
    if (delay === null) return res;
    await Bun.sleep(delay);
  }
}

/** Exported for unit tests. */
export async function ghRest(path: string): Promise<unknown> {
  const res = await githubFetch(`${GITHUB_API}${path}`, { headers: ghHeaders() });
  if (!res?.ok) return undefined;
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Exported for unit tests. */
export async function ghGraphql(query: string, vars: Record<string, unknown> = {}): Promise<Record<string, unknown> | undefined> {
  const res = await githubFetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: vars }),
  });
  if (!res?.ok) return undefined;
  try {
    const parsed = (await res.json()) as { data?: Record<string, unknown> };
    return parsed.data;
  } catch {
    return undefined;
  }
}

const CONTEXTS_PAGE_SIZE = 100;

const CONTEXT_NODE_FIELDS = `
  __typename
  ... on CheckRun {
    name
    status
    conclusion
    detailsUrl
    startedAt
    completedAt
    checkSuite { workflowRun { workflow { name } } }
  }
  ... on StatusContext { context state targetUrl }
`;

/**
 * Page through `statusCheckRollup.contexts` for a specific commit, starting
 * after the cursor returned by an earlier query. Busy repos (eg.
 * ethereum-optimism/optimism) routinely exceed 100 contexts per commit, so
 * without this we'd silently drop the tail of the workflow list.
 */
async function fetchRemainingCommitContexts(
  owner: string,
  name: string,
  oid: string,
  startCursor: string,
): Promise<RawCheckContext[]> {
  const query = `
    query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String!) {
      repository(owner: $owner, name: $name) {
        object(oid: $oid) {
          ... on Commit {
            statusCheckRollup {
              contexts(first: ${CONTEXTS_PAGE_SIZE}, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { ${CONTEXT_NODE_FIELDS} }
              }
            }
          }
        }
      }
    }
  `;
  const out: RawCheckContext[] = [];
  let after: string | undefined = startCursor;
  while (after) {
    const data = await ghGraphql(query, { owner, name, oid, after });
    const repoNode = data?.["repository"] as Record<string, unknown> | undefined;
    const commit = repoNode?.["object"] as Record<string, unknown> | undefined;
    const rollup = commit?.["statusCheckRollup"] as Record<string, unknown> | undefined;
    const contexts = rollup?.["contexts"] as Record<string, unknown> | undefined;
    if (!contexts) break;
    out.push(...parseContexts(contexts["nodes"]));
    const pageInfo = contexts["pageInfo"] as Record<string, unknown> | undefined;
    if (!pageInfo?.["hasNextPage"]) break;
    after = (pageInfo["endCursor"] as string) || undefined;
  }
  return out;
}

/**
 * Inspect the first-page contexts of a PR node and, when GitHub reports more
 * pages exist, return the parameters needed to fetch the rest via
 * `fetchRemainingCommitContexts`. Returns undefined when the first page is
 * complete.
 */
function extractContextsFollowup(
  prNode: Record<string, unknown>,
  repo: string,
  oid: string,
): { owner: string; name: string; oid: string; cursor: string } | undefined {
  const commits = prNode["statusCheckRollup"] as Record<string, unknown> | undefined;
  const commitNode = (commits?.["nodes"] as Array<Record<string, unknown>>)?.[0];
  const commit = commitNode?.["commit"] as Record<string, unknown> | undefined;
  const rollup = commit?.["statusCheckRollup"] as Record<string, unknown> | undefined;
  const contexts = rollup?.["contexts"] as Record<string, unknown> | undefined;
  const pageInfo = contexts?.["pageInfo"] as Record<string, unknown> | undefined;
  if (!pageInfo?.["hasNextPage"]) return undefined;
  const cursor = (pageInfo["endCursor"] as string) || "";
  const [owner, name] = repo.split("/");
  if (!owner || !name || !oid || !cursor) return undefined;
  return { owner, name, oid, cursor };
}

/**
 * Parse a single aliased `repository(...)` response node into a RepoMeta.
 * Null/missing nodes (deleted, no access) fall back to the input name with
 * zero counts. Exported for unit tests.
 */
export function parseRepoMetaNode(node: unknown, fallbackRepo: string): RepoMeta {
  if (!node || typeof node !== "object") {
    return { canonical: fallbackRepo, openIssues: 0, openPrs: 0 };
  }
  const o = node as Record<string, unknown>;
  const canonical = (o["nameWithOwner"] as string | undefined) ?? fallbackRepo;
  const oi = (o["openIssues"] as Record<string, unknown> | undefined)?.["totalCount"];
  const op = (o["openPrs"] as Record<string, unknown> | undefined)?.["totalCount"];
  return {
    canonical,
    openIssues: typeof oi === "number" ? oi : 0,
    openPrs: typeof op === "number" ? op : 0,
  };
}

/**
 * Parse one `search.nodes[*]` item under `... on Issue` into a RawStatItem.
 * Missing fields return empty strings / 0 so the caller can render `—`
 * rather than crashing.
 */
export function parseStatItemNode(node: unknown): RawStatItem | undefined {
  if (!node || typeof node !== "object") return undefined;
  const o = node as Record<string, unknown>;
  const repo = ((o["repository"] as Record<string, unknown> | undefined)?.["nameWithOwner"] as string) ?? "";
  const number = (o["number"] as number) ?? 0;
  if (!repo || !number) return undefined;
  return {
    repo,
    number,
    title: (o["title"] as string) ?? "",
    url: (o["url"] as string) ?? "",
    createdAt: (o["createdAt"] as string) ?? "",
    updatedAt: (o["updatedAt"] as string) ?? "",
  };
}

/**
 * Parse one `search.nodes[*]` item under `... on PullRequest` into a
 * RawReviewRequestItem. The reviewerLogins array captures every requested
 * `User`-typed reviewer; callers compare against the viewer's login to set
 * the personal flag.
 */
export function parseReviewRequestNode(node: unknown): RawReviewRequestItem | undefined {
  const base = parseStatItemNode(node);
  if (!base) return undefined;
  const o = node as Record<string, unknown>;
  const reqs = (o["reviewRequests"] as Record<string, unknown> | undefined)?.["nodes"];
  const reviewerLogins: string[] = [];
  if (Array.isArray(reqs)) {
    for (const r of reqs) {
      const rev = (r as Record<string, unknown>)?.["requestedReviewer"] as Record<string, unknown> | undefined;
      if (!rev) continue;
      if (rev["__typename"] === "User") {
        const login = rev["login"] as string | undefined;
        if (login) reviewerLogins.push(login);
      }
    }
  }
  return { ...base, reviewerLogins };
}

function parseContexts(nodes: unknown): RawCheckContext[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((n) => {
    const o = n as Record<string, unknown>;
    const checkSuite = o["checkSuite"] as Record<string, unknown> | undefined;
    const workflowRun = checkSuite?.["workflowRun"] as Record<string, unknown> | undefined;
    const workflow = workflowRun?.["workflow"] as Record<string, unknown> | undefined;
    return {
      __typename: (o["__typename"] as string) ?? "",
      name: o["name"] as string | undefined,
      context: o["context"] as string | undefined,
      status: o["status"] as string | undefined,
      conclusion: o["conclusion"] as string | undefined,
      state: o["state"] as string | undefined,
      detailsUrl: o["detailsUrl"] as string | undefined,
      targetUrl: o["targetUrl"] as string | undefined,
      startedAt: o["startedAt"] as string | undefined,
      completedAt: o["completedAt"] as string | undefined,
      workflowName: workflow?.["name"] as string | undefined,
    };
  });
}

export class RealDashboardGitHubClient implements DashboardGitHubClient {
  async fetchViewer(): Promise<{ login: string }> {
    const data = await ghGraphql(`query { viewer { login } }`);
    const login = ((data?.["viewer"] as Record<string, unknown> | undefined)?.["login"] as string) ?? "";
    return { login };
  }

  async resolveRepoMeta(repos: string[]): Promise<Map<string, RepoMeta>> {
    const out = new Map<string, RepoMeta>();
    if (repos.length === 0) return out;
    // Batch into a single GraphQL request using aliased `repository(...)`
    // selections. Cheaper than N round-trips through `gh api`. Each selection
    // also pulls the open-issue + open-PR count so the totals cards don't
    // need separate searches.
    const fields: string[] = [];
    const inputs: { alias: string; repo: string; owner: string; name: string }[] = [];
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i]!;
      const slash = repo.indexOf("/");
      if (slash <= 0 || slash === repo.length - 1) {
        out.set(repo, { canonical: repo, openIssues: 0, openPrs: 0 });
        continue;
      }
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);
      const alias = `r${i}`;
      // GraphQL string-literal escape — repo names contain only alnum/-/_/. but
      // be safe in case GitHub ever broadens that.
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      fields.push(
        `${alias}: repository(owner: "${esc(owner)}", name: "${esc(name)}") {
          nameWithOwner
          openIssues: issues(states: OPEN) { totalCount }
          openPrs: pullRequests(states: OPEN) { totalCount }
        }`,
      );
      inputs.push({ alias, repo, owner, name });
    }
    if (fields.length === 0) return out;
    const query = `query { ${fields.join(" ")} }`;
    const data = await ghGraphql(query);
    for (const { alias, repo } of inputs) {
      out.set(repo, parseRepoMetaNode(data?.[alias], repo));
    }
    return out;
  }

  async fetchViewerWorkload(): Promise<ViewerWorkload> {
    const query = `
      query {
        viewer {
          pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              repository {
                nameWithOwner
                isArchived
                defaultBranchRef { name }
              }
              number
              title
              url
              isDraft
              state
              reviewDecision
              mergeable
              mergeStateStatus
              mergeQueueEntry { id }
              autoMergeRequest { enabledAt }
              baseRefName
              headRefName
              headRefOid
              author { login }
              createdAt
              updatedAt
              reviews(last: 50) { nodes { author { login } state submittedAt } }
              reviewRequests(first: 20) {
                nodes {
                  requestedReviewer {
                    __typename
                    ... on User { login }
                    ... on Team { name }
                  }
                }
              }
              baseRef {
                associatedPullRequests(first: 20, states: [OPEN, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
                  nodes { number state headRefName repository { nameWithOwner } }
                }
              }
              statusCheckRollup: commits(last: 1) {
                nodes {
                  commit {
                    oid
                    statusCheckRollup {
                      contexts(first: ${CONTEXTS_PAGE_SIZE}) {
                        pageInfo { hasNextPage endCursor }
                        nodes { ${CONTEXT_NODE_FIELDS} }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        assignedIssues: search(query: "assignee:@me is:issue is:open archived:false", first: 100, type: ISSUE) {
          issueCount
          nodes {
            ... on Issue {
              number
              title
              url
              createdAt
              updatedAt
              repository { nameWithOwner }
            }
          }
        }
        reviewRequestedPrs: search(query: "review-requested:@me is:pr is:open archived:false", first: 100, type: ISSUE) {
          issueCount
          nodes {
            ... on PullRequest {
              number
              title
              url
              createdAt
              updatedAt
              repository { nameWithOwner }
              reviewRequests(first: 20) {
                nodes {
                  requestedReviewer {
                    __typename
                    ... on User { login }
                    ... on Team { name }
                  }
                }
              }
            }
          }
        }
        personalReviewRequests: search(query: "user-review-requested:@me is:pr is:open archived:false", first: 100, type: ISSUE) {
          issueCount
          nodes {
            ... on PullRequest {
              number
              title
              url
              createdAt
              updatedAt
              repository { nameWithOwner }
            }
          }
        }
      }
    `;
    const data = await ghGraphql(query);
    const viewer = data?.["viewer"] as Record<string, unknown> | undefined;
    const prsNode = viewer?.["pullRequests"] as Record<string, unknown> | undefined;
    const nodes = (prsNode?.["nodes"] as Array<Record<string, unknown>>) ?? [];

    const raws: RawPr[] = [];
    const followups: Array<{ raw: RawPr; owner: string; name: string; oid: string; cursor: string }> = [];
    for (const n of nodes) {
      const repoNode = n["repository"] as Record<string, unknown> | undefined;
      if (repoNode?.["isArchived"]) continue;
      const raw = normalizePr(n);
      raws.push(raw);
      const followup = extractContextsFollowup(n, raw.repo, raw.headRefOid);
      if (followup) followups.push({ raw, ...followup });
    }
    await Promise.all(
      followups.map(async (f) => {
        const more = await fetchRemainingCommitContexts(f.owner, f.name, f.oid, f.cursor);
        f.raw.checks.push(...more);
      }),
    );

    const assignedIssuesNode = (data?.["assignedIssues"] as Record<string, unknown> | undefined) ?? {};
    const assignedIssues: RawStatItem[] = [];
    const issueNodes = assignedIssuesNode["nodes"];
    if (Array.isArray(issueNodes)) {
      for (const n of issueNodes) {
        const parsed = parseStatItemNode(n);
        if (parsed) assignedIssues.push(parsed);
      }
    }
    const assignedIssuesTotalCount =
      typeof assignedIssuesNode["issueCount"] === "number" ? (assignedIssuesNode["issueCount"] as number) : assignedIssues.length;

    const reviewReqNode = (data?.["reviewRequestedPrs"] as Record<string, unknown> | undefined) ?? {};
    const reviewRequestedPrs: RawReviewRequestItem[] = [];
    const reqNodes = reviewReqNode["nodes"];
    if (Array.isArray(reqNodes)) {
      for (const n of reqNodes) {
        const parsed = parseReviewRequestNode(n);
        if (parsed) reviewRequestedPrs.push(parsed);
      }
    }
    const reviewRequestedPrsTotalCount =
      typeof reviewReqNode["issueCount"] === "number" ? (reviewReqNode["issueCount"] as number) : reviewRequestedPrs.length;

    const personalReviewNode = (data?.["personalReviewRequests"] as Record<string, unknown> | undefined) ?? {};
    const personalReviewRequestedPrs: RawStatItem[] = [];
    const personalNodes = personalReviewNode["nodes"];
    if (Array.isArray(personalNodes)) {
      for (const n of personalNodes) {
        const parsed = parseStatItemNode(n);
        if (parsed) personalReviewRequestedPrs.push(parsed);
      }
    }
    const personalReviewRequestsTotalCount =
      typeof personalReviewNode["issueCount"] === "number"
        ? (personalReviewNode["issueCount"] as number)
        : personalReviewRequestedPrs.length;

    return {
      prs: raws,
      assignedIssues,
      assignedIssuesTotalCount,
      reviewRequestedPrs,
      reviewRequestedPrsTotalCount,
      personalReviewRequestedPrs,
      personalReviewRequestsTotalCount,
    };
  }

  async fetchMergeQueue(repo: string): Promise<RawMergeQueueEntry[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return [];
    const query = `
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          mergeQueue {
            entries(first: 50) {
              nodes {
                position
                enqueuedAt
                state
                pullRequest {
                  number
                  title
                  url
                  isDraft
                  author { login }
                  headRefOid
                }
                headCommit {
                  oid
                  statusCheckRollup {
                    contexts(first: ${CONTEXTS_PAGE_SIZE}) {
                      pageInfo { hasNextPage endCursor }
                      nodes { ${CONTEXT_NODE_FIELDS} }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const data = await ghGraphql(query, { owner, name });
    const repoNode = data?.["repository"] as Record<string, unknown> | undefined;
    const mq = repoNode?.["mergeQueue"] as Record<string, unknown> | undefined;
    const entries = mq?.["entries"] as Record<string, unknown> | undefined;
    const nodes = (entries?.["nodes"] as Array<Record<string, unknown>>) ?? [];

    const entriesOut: RawMergeQueueEntry[] = [];
    const followups: Array<{ entry: RawMergeQueueEntry; cursor: string }> = [];
    for (const n of nodes) {
      const pr = (n["pullRequest"] as Record<string, unknown>) ?? {};
      const author = (pr["author"] as Record<string, unknown> | undefined)?.["login"] as string | undefined;
      const headCommit = n["headCommit"] as Record<string, unknown> | undefined;
      const headSha = (headCommit?.["oid"] as string) ?? "";
      const rollup = headCommit?.["statusCheckRollup"] as Record<string, unknown> | undefined;
      const contexts = rollup?.["contexts"] as Record<string, unknown> | undefined;
      const headChecks = parseContexts(contexts?.["nodes"]);
      const entry: RawMergeQueueEntry = {
        repo,
        position: (n["position"] as number) ?? 0,
        prNumber: (pr["number"] as number) ?? 0,
        prTitle: (pr["title"] as string) ?? "",
        prUrl: (pr["url"] as string) ?? "",
        author: author ?? "",
        state: (n["state"] as string) ?? "QUEUED",
        enqueuedAt: (n["enqueuedAt"] as string) ?? "",
        mine: false,
        headSha,
        headChecks,
      };
      entriesOut.push(entry);
      const pageInfo = contexts?.["pageInfo"] as Record<string, unknown> | undefined;
      if (headSha && pageInfo?.["hasNextPage"]) {
        const cursor = (pageInfo["endCursor"] as string) || "";
        if (cursor) followups.push({ entry, cursor });
      }
    }
    await Promise.all(
      followups.map(async (f) => {
        const more = await fetchRemainingCommitContexts(owner, name, f.entry.headSha, f.cursor);
        f.entry.headChecks.push(...more);
      }),
    );
    return entriesOut;
  }

  async fetchDefaultBranchHead(repo: string): Promise<{ branch: string; sha: string; checks: RawCheckContext[] } | undefined> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;
    const query = `
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            name
            target {
              ... on Commit {
                oid
                statusCheckRollup {
                  contexts(first: ${CONTEXTS_PAGE_SIZE}) {
                    pageInfo { hasNextPage endCursor }
                    nodes { ${CONTEXT_NODE_FIELDS} }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const data = await ghGraphql(query, { owner, name });
    const repoNode = data?.["repository"] as Record<string, unknown> | undefined;
    const branchRef = repoNode?.["defaultBranchRef"] as Record<string, unknown> | undefined;
    if (!branchRef) return undefined;
    const branch = (branchRef["name"] as string) ?? "";
    const target = branchRef["target"] as Record<string, unknown> | undefined;
    const sha = (target?.["oid"] as string) ?? "";
    const rollup = target?.["statusCheckRollup"] as Record<string, unknown> | undefined;
    const contexts = rollup?.["contexts"] as Record<string, unknown> | undefined;
    const checks = parseContexts(contexts?.["nodes"]);
    const pageInfo = contexts?.["pageInfo"] as Record<string, unknown> | undefined;
    if (sha && pageInfo?.["hasNextPage"]) {
      const cursor = (pageInfo["endCursor"] as string) || "";
      if (cursor) {
        checks.push(...(await fetchRemainingCommitContexts(owner, name, sha, cursor)));
      }
    }
    return { branch, sha, checks };
  }

  /**
   * GitHub Actions runs on the default branch. Returns every trigger event
   * (push, schedule, workflow_dispatch, …) within the window. Paginates the
   * runs endpoint because busy repos (ethereum-optimism/optimism, …) push
   * past the 100-per-page cap inside a single 24h window — without paging,
   * the older runs get dropped and their workflows vanish from the board.
   */
  async fetchDefaultBranchRecentRuns(repo: string, branch: string, windowHours: number): Promise<RawWorkflowRun[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name || !branch) return [];
    const sinceMs = Date.now() - windowHours * 3_600_000;
    const sinceIso = new Date(sinceMs).toISOString().replace(/\.\d+Z$/, "Z");
    const out: RawWorkflowRun[] = [];
    const PER_PAGE = 100;
    const MAX_PAGES = 20;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/repos/${owner}/${name}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${PER_PAGE}&page=${page}&created=%3E%3D${encodeURIComponent(sinceIso)}`;
      const data = (await ghRest(path)) as Record<string, unknown> | undefined;
      const runs = (data?.["workflow_runs"] as Array<Record<string, unknown>>) ?? [];
      if (runs.length === 0) break;
      for (const r of runs) {
        const workflowId = (r["workflow_id"] as number) ?? 0;
        if (!workflowId) continue;
        out.push({
          workflowId,
          workflowName: (r["name"] as string) ?? "",
          event: (r["event"] as string) ?? "",
          status: (r["status"] as string) ?? "",
          conclusion: (r["conclusion"] as string | null) ?? undefined,
          createdAt: (r["created_at"] as string) ?? "",
          startedAt: (r["run_started_at"] as string | null) ?? undefined,
          updatedAt: (r["updated_at"] as string) ?? "",
          headSha: (r["head_sha"] as string) ?? "",
          url: (r["html_url"] as string) ?? "",
          runId: (r["id"] as number) ?? 0,
        });
      }
      if (runs.length < PER_PAGE) break;
    }
    return out;
  }
}

function normalizePr(n: Record<string, unknown>): RawPr {
  const repo = ((n["repository"] as Record<string, unknown>)?.["nameWithOwner"] as string) ?? "";
  const defaultBranch = (((n["repository"] as Record<string, unknown>)?.["defaultBranchRef"] as Record<string, unknown> | undefined)?.["name"] as string) ?? "";

  const baseRef = n["baseRef"] as Record<string, unknown> | undefined;
  const assoc = baseRef?.["associatedPullRequests"] as Record<string, unknown> | undefined;
  const assocNodes = (assoc?.["nodes"] as Array<Record<string, unknown>>) ?? [];
  const associatedOnBase = assocNodes.map((a) => ({
    repo: ((a["repository"] as Record<string, unknown> | undefined)?.["nameWithOwner"] as string) ?? repo,
    number: (a["number"] as number) ?? 0,
    state: (a["state"] as string) ?? "",
    headRefName: (a["headRefName"] as string) ?? "",
  }));

  const reviewNodes = ((n["reviews"] as Record<string, unknown> | undefined)?.["nodes"] as Array<Record<string, unknown>>) ?? [];
  const reviews = reviewNodes.map((r) => ({
    login: ((r["author"] as Record<string, unknown> | undefined)?.["login"] as string) ?? "",
    state: (r["state"] as string) ?? "",
    submittedAt: (r["submittedAt"] as string) ?? "",
  }));

  const reqNodes = ((n["reviewRequests"] as Record<string, unknown> | undefined)?.["nodes"] as Array<Record<string, unknown>>) ?? [];
  const reviewRequested = reqNodes
    .map((rq) => {
      const reviewer = rq["requestedReviewer"] as Record<string, unknown> | undefined;
      if (!reviewer) return "";
      return (reviewer["login"] as string) ?? (reviewer["name"] as string) ?? "";
    })
    .filter(Boolean);

  const commits = n["statusCheckRollup"] as Record<string, unknown> | undefined;
  const commitNodes = (commits?.["nodes"] as Array<Record<string, unknown>>) ?? [];
  const commit = (commitNodes[0]?.["commit"] as Record<string, unknown> | undefined) ?? undefined;
  const rollup = commit?.["statusCheckRollup"] as Record<string, unknown> | undefined;
  const contexts = rollup?.["contexts"] as Record<string, unknown> | undefined;
  const checks = parseContexts(contexts?.["nodes"]);

  return {
    repo,
    defaultBranch,
    number: (n["number"] as number) ?? 0,
    title: (n["title"] as string) ?? "",
    url: (n["url"] as string) ?? "",
    isDraft: (n["isDraft"] as boolean) ?? false,
    state: (n["state"] as string) ?? "OPEN",
    reviewDecision: (n["reviewDecision"] as string) ?? "",
    mergeable: (n["mergeable"] as string) ?? "",
    mergeStateStatus: (n["mergeStateStatus"] as string) ?? "",
    isInMergeQueue: n["mergeQueueEntry"] != null,
    autoMergeEnabled: n["autoMergeRequest"] != null,
    baseRefName: (n["baseRefName"] as string) ?? "",
    headRefName: (n["headRefName"] as string) ?? "",
    headRefOid: (commit?.["oid"] as string) ?? "",
    author: ((n["author"] as Record<string, unknown> | undefined)?.["login"] as string) ?? "",
    createdAt: (n["createdAt"] as string) ?? "",
    updatedAt: (n["updatedAt"] as string) ?? "",
    reviews,
    reviewRequested,
    associatedOnBase,
    checks,
  };
}

export function buildPrCards(raws: RawPr[]): PrCard[] {
  // Index by `repo#number` so we can resolve parent/children.
  const byKey = new Map<string, RawPr>();
  for (const pr of raws) byKey.set(`${pr.repo}#${pr.number}`, pr);

  const cards: PrCard[] = raws.map((pr) => {
    // A PR targeting its repo's default branch is a stack root by definition —
    // any matching candidate is either a fork (different repo) or a "merge
    // default-branch into X" sync PR (same repo, but head=default branch).
    // Also: same-repo only, since GitHub's associatedPullRequests can return
    // fork PRs whose head-ref name collides with our base ref.
    const parent = pr.baseRefName === pr.defaultBranch
      ? undefined
      : pr.associatedOnBase.find(
          (a) => a.repo === pr.repo && a.headRefName === pr.baseRefName && a.number !== pr.number,
        );
    const card: PrCard = {
      key: `${pr.repo}#${pr.number}`,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      isDraft: pr.isDraft,
      state: (pr.state as PrCard["state"]) ?? "OPEN",
      reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable,
      isInMergeQueue: pr.isInMergeQueue,
      autoMergeEnabled: pr.autoMergeEnabled,
      headRefName: pr.headRefName,
      headSha: pr.headRefOid,
      baseRefName: pr.baseRefName,
      defaultBranch: pr.defaultBranch,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      reviews: pr.reviews,
      reviewRequested: pr.reviewRequested,
      parentPr: parent
        ? { repo: parent.repo, number: parent.number, state: parent.state }
        : undefined,
      childPrs: [],
    };
    return card;
  });

  const cardByKey = new Map(cards.map((c) => [c.key, c]));
  for (const c of cards) {
    if (!c.parentPr) continue;
    const parent = cardByKey.get(`${c.parentPr.repo}#${c.parentPr.number}`);
    if (parent) {
      parent.childPrs.push({ repo: c.repo, number: c.number, state: c.state });
    }
  }
  return cards;
}

/**
 * Group PRs into stacks. Each stack is a connected component where edges
 * link a PR to its parent PR via baseRef==parent.headRef. Returned ordered
 * base-up (root first). Pure: does not mutate the input cards (the poller
 * calls this on every snapshot, including CI-only refreshes where `cards`
 * is reused between GitHub polls).
 */
export function buildStacks(cards: PrCard[]): { rootKey: string; prKeys: string[] }[] {
  const byKey = new Map(cards.map((c) => [c.key, c]));

  // Build a local children map rather than mutating cards.
  const childrenByKey = new Map<string, string[]>();
  for (const c of cards) {
    if (!c.parentPr) continue;
    const parentKey = `${c.parentPr.repo}#${c.parentPr.number}`;
    if (!byKey.has(parentKey)) continue;
    const arr = childrenByKey.get(parentKey) ?? [];
    arr.push(c.key);
    childrenByKey.set(parentKey, arr);
  }

  // Roots: PRs whose parent isn't in the set.
  const roots = cards.filter((c) => !c.parentPr || !byKey.has(`${c.parentPr.repo}#${c.parentPr.number}`));

  const stacks: { rootKey: string; prKeys: string[] }[] = [];
  for (const root of roots) {
    const ordered: string[] = [];
    const visit = (key: string) => {
      ordered.push(key);
      for (const childKey of childrenByKey.get(key) ?? []) {
        visit(childKey);
      }
    };
    visit(root.key);
    stacks.push({ rootKey: root.key, prKeys: ordered });
  }
  return stacks;
}
