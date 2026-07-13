/**
 * GitHub GraphQL queries for the PR dashboard. Independent from the
 * existing todo-refresh batcher so we can request exactly what the
 * dashboard cares about in as few round-trips as possible.
 */

import type { PrCard, MergeQueueEntry } from "../types.ts";
import { debugLog, summarizeQuery, truncateBody } from "./debug.ts";
import type { CircleConfigFile, RawActionsWorkflow, RawActionsRun } from "./project-workflows.ts";
import { isCodeDefinedWorkflowPath } from "./project-workflows.ts";

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
  /** Paths changed by the PR, used to evaluate file-scoped review rulesets. */
  changedFiles: string[];
  /** Active/inactive rulesets returned with the PR's repository node. */
  rulesets: RawRuleset[];
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
  listCircleConfigFiles(repo: string): Promise<CircleConfigFile[]>;
  fetchTextFile(repo: string, path: string): Promise<string | undefined>;
  fetchActionsWorkflows(repo: string): Promise<RawActionsWorkflow[]>;
  fetchLatestWorkflowRun(repo: string, workflowId: number): Promise<RawActionsRun | undefined>;
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
  const started = Date.now();
  debugLog("github", `REST request GET ${path}`);
  const res = await githubFetch(`${GITHUB_API}${path}`, { headers: ghHeaders() });
  if (!res) {
    debugLog("github", `REST GET ${path} → no response (network error)`);
    return undefined;
  }
  const text = await res.text().catch(() => "");
  debugLog("github", `REST GET ${path} → HTTP ${res.status} in ${Date.now() - started}ms: ${truncateBody(text)}`);
  if (!res.ok) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Exported for unit tests. */
export async function ghGraphql(query: string, vars: Record<string, unknown> = {}): Promise<Record<string, unknown> | undefined> {
  const started = Date.now();
  debugLog("github", `GraphQL request ${summarizeQuery(query)} vars=${JSON.stringify(vars)}`);
  const res = await githubFetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: vars }),
  });
  if (!res) {
    debugLog("github", "GraphQL request → no response (network error)");
    return undefined;
  }
  const text = await res.text().catch(() => "");
  debugLog("github", `GraphQL response HTTP ${res.status} in ${Date.now() - started}ms: ${truncateBody(text)}`);
  if (!res.ok) return undefined;
  try {
    const parsed = JSON.parse(text) as { data?: Record<string, unknown>; errors?: unknown };
    // GitHub answers partial failures with HTTP 200 + a populated `errors`
    // array (cost limit, field-level timeout, missing scope). The data we'd
    // otherwise return has null holes, so surface the errors under debug —
    // this is the usual cause of a "0 PRs / blank board" run.
    if (parsed.errors && (Array.isArray(parsed.errors) ? parsed.errors.length > 0 : true)) {
      debugLog("github", `GraphQL errors: ${JSON.stringify(parsed.errors)}`);
    }
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
 * Every PR-node field the dashboard needs except the check rollup. Shared by
 * the combined and split workload queries, and by both the `viewer` and the
 * repo-scoped `search` PR sources, so the parser (`normalizePr`) sees the same
 * shape regardless of how the PRs were fetched.
 */
const PR_CORE_FIELDS = `
  repository {
    nameWithOwner
    isArchived
    defaultBranchRef { name }
    rulesets(first: 100, includeParents: true, targets: [BRANCH]) {
      nodes {
        target
        enforcement
        conditions {
          ref_name: refName { include exclude }
        }
        rules(first: 100, type: PULL_REQUEST) {
          nodes {
            type
            parameters {
              ... on PullRequestParameters {
                required_approving_review_count: requiredApprovingReviewCount
                required_reviewers: requiredReviewers {
                  minimum_approvals: minimumApprovals
                  file_patterns: filePatterns
                }
              }
            }
          }
        }
      }
    }
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
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
  }
  files(first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes { path }
  }
  baseRef {
    associatedPullRequests(first: 20, states: [OPEN, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number state headRefName repository { nameWithOwner } }
    }
  }
`;

export interface RawRepositoryRule {
  type?: string;
  parameters?: {
    required_approving_review_count?: number;
    required_reviewers?: Array<{
      minimum_approvals?: number;
      file_patterns?: string[];
    }>;
  };
}

export interface RawRuleset {
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: { nodes?: RawRepositoryRule[] };
}

/** GitHub ruleset globs use pathname semantics: * does not cross a slash. */
function matchesRulesetGlob(value: string, glob: string): boolean {
  let pattern = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` can span zero or more directories; a bare `**` spans any
        // characters. This distinction matters for patterns such as
        // `packages/contracts-bedrock/**/*.md`, which also excludes a markdown
        // file directly under contracts-bedrock.
        if (glob[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 2;
        } else {
          pattern += ".*";
          i++;
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (ch === "?") {
      pattern += "[^/]";
    } else {
      pattern += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`).test(value);
}

function filePatternsMatch(patterns: string[], paths: string[]): boolean {
  if (patterns.length === 0) return true;
  const positive = patterns.filter((p) => !p.startsWith("!"));
  const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  return paths.some(
    (path) =>
      (positive.length === 0 || positive.some((p) => matchesRulesetGlob(path, p))) &&
      !negative.some((p) => matchesRulesetGlob(path, p)),
  );
}

function refPatternMatches(pattern: string, pr: RawPr): boolean {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") return pr.baseRefName === pr.defaultBranch;
  return matchesRulesetGlob(`refs/heads/${pr.baseRefName}`, pattern);
}

function rulesetTargetsPr(ruleset: RawRuleset, pr: RawPr): boolean {
  if (ruleset.target !== "BRANCH" || ruleset.enforcement !== "ACTIVE") return false;
  const refs = ruleset.conditions?.ref_name;
  const includes = refs?.include ?? ["~ALL"];
  const excludes = refs?.exclude ?? [];
  return includes.some((pattern) => refPatternMatches(pattern, pr)) &&
    !excludes.some((pattern) => refPatternMatches(pattern, pr));
}

/**
 * GitHub's PullRequest.reviewDecision can be null for the newer ruleset
 * `required_reviewers` rule, even while that rule is blocking the PR. Fill in
 * REVIEW_REQUIRED when GitHub's evaluated rules for the PR's base branch
 * include an applicable review requirement. A non-empty GitHub decision
 * always remains authoritative.
 */
export function applyRulesetReviewRequirements(prs: RawPr[]): void {
  for (const pr of prs) {
    if (pr.reviewDecision) continue;
    const requiresReview = pr.rulesets.some((ruleset) => {
      if (!rulesetTargetsPr(ruleset, pr)) return false;
      return (ruleset.rules?.nodes ?? []).some((rule) => {
        if (rule.type !== "PULL_REQUEST") return false;
        const params = rule.parameters;
        if ((params?.required_approving_review_count ?? 0) > 0) return true;
        return (params?.required_reviewers ?? []).some(
          (reviewer) =>
            (reviewer.minimum_approvals ?? 0) > 0 &&
            filePatternsMatch(reviewer.file_patterns ?? [], pr.changedFiles),
        );
      });
    });
    if (requiresReview) pr.reviewDecision = "REVIEW_REQUIRED";
  }
}

/**
 * The check-rollup sub-selection. Inlined into the combined query (one
 * round-trip); fetched separately per commit in split mode, where it's the
 * expensive part that pushes the combined query past GitHub's execution limit.
 */
const PR_ROLLUP_FIELD = `
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
 * Fetch check rollups for a batch of commits in a single request using aliased
 * `repository(...).object(oid)` selections, then page out any commit with more
 * than one context page. Used by split-mode workload fetching, where the
 * rollups are pulled separately from the (cheap) PR-list query. Returns a map
 * keyed by commit oid.
 */
async function fetchContextsForCommits(
  commits: { owner: string; name: string; oid: string }[],
): Promise<Map<string, RawCheckContext[]>> {
  const out = new Map<string, RawCheckContext[]>();
  if (commits.length === 0) return out;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const fields = commits.map(
    (c, i) => `c${i}: repository(owner: "${esc(c.owner)}", name: "${esc(c.name)}") {
      object(oid: "${esc(c.oid)}") {
        ... on Commit {
          statusCheckRollup {
            contexts(first: ${CONTEXTS_PAGE_SIZE}) {
              pageInfo { hasNextPage endCursor }
              nodes { ${CONTEXT_NODE_FIELDS} }
            }
          }
        }
      }
    }`,
  );
  const data = await ghGraphql(`query { ${fields.join(" ")} }`);
  const followups: Array<{ owner: string; name: string; oid: string; cursor: string; into: RawCheckContext[] }> = [];
  commits.forEach((c, i) => {
    const repoNode = data?.[`c${i}`] as Record<string, unknown> | undefined;
    const commit = repoNode?.["object"] as Record<string, unknown> | undefined;
    const rollup = commit?.["statusCheckRollup"] as Record<string, unknown> | undefined;
    const contexts = rollup?.["contexts"] as Record<string, unknown> | undefined;
    const arr = parseContexts(contexts?.["nodes"]);
    out.set(c.oid, arr);
    const pageInfo = contexts?.["pageInfo"] as Record<string, unknown> | undefined;
    if (pageInfo?.["hasNextPage"]) {
      const cursor = (pageInfo["endCursor"] as string) || "";
      if (cursor) followups.push({ owner: c.owner, name: c.name, oid: c.oid, cursor, into: arr });
    }
  });
  await Promise.all(
    followups.map(async (f) => {
      const more = await fetchRemainingCommitContexts(f.owner, f.name, f.oid, f.cursor);
      f.into.push(...more);
    }),
  );
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
  /**
   * When non-empty, the workload feeds are filtered to these repos after
   * fetching (client-side — see `scopeWorkload`). Filtering happens client-side
   * rather than via `repo:` search qualifiers because those return nothing for
   * fine-grained PATs that weren't granted the target repo.
   */
  private readonly scopeRepos: string[];

  /**
   * Flipped on once the single combined workload query times out (GitHub's
   * ~10s GraphQL budget). Stays set for the process lifetime so subsequent
   * refreshes go straight to the cheaper split requests; a restart resets it,
   * retrying the combined query in case the workload has since shrunk.
   */
  private splitWorkload = false;

  constructor(opts: { scopeRepos?: string[] } = {}) {
    this.scopeRepos = opts.scopeRepos ?? [];
  }

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
    return this.scopeWorkload(await this.fetchWorkloadRaw());
  }

  private async fetchWorkloadRaw(): Promise<ViewerWorkload> {
    if (!this.splitWorkload) {
      const combined = await this.fetchWorkloadCombined();
      if (combined) return combined;
      this.splitWorkload = true;
      debugLog(
        "github",
        "combined workload query returned no PR list (likely over GitHub's GraphQL budget); using split requests for the rest of this process",
      );
    }
    return this.fetchWorkloadSplit();
  }

  /**
   * The viewer's open PRs. Always unscoped: a repo-scoped `search(repo:…)` would
   * return nothing for fine-grained PATs that weren't granted the target repo
   * (even public ones), whereas `viewer.pullRequests` works for every token
   * type. Repo scoping is applied client-side afterwards (`scopeWorkload`).
   */
  private prListBlock(withRollup: boolean): string {
    const rollup = withRollup ? PR_ROLLUP_FIELD : "";
    return `viewer {
      pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { ${PR_CORE_FIELDS} ${rollup} }
      }
    }`;
  }

  /** The three workload-search feeds. Unscoped for the same fine-grained-PAT reason as `prListBlock`. */
  private searchesBlock(): string {
    return `
      assignedIssues: search(query: "assignee:@me is:issue is:open archived:false", first: 100, type: ISSUE) {
        issueCount
        nodes { ... on Issue { number title url createdAt updatedAt repository { nameWithOwner } } }
      }
      reviewRequestedPrs: search(query: "review-requested:@me is:pr is:open archived:false", first: 100, type: ISSUE) {
        issueCount
        nodes {
          ... on PullRequest {
            number title url createdAt updatedAt repository { nameWithOwner }
            reviewRequests(first: 20) {
              nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
            }
          }
        }
      }
      personalReviewRequests: search(query: "user-review-requested:@me is:pr is:open archived:false", first: 100, type: ISSUE) {
        issueCount
        nodes { ... on PullRequest { number title url createdAt updatedAt repository { nameWithOwner } } }
      }
    `;
  }

  /**
   * Pull the PR nodes out of a workload response. Returns undefined when the PR
   * container itself is missing/null — the signal that the query failed (HTTP
   * error, empty body, or a partial GraphQL timeout) rather than legitimately
   * returning zero PRs (which is an empty `nodes` array).
   */
  private extractPrNodes(data: Record<string, unknown> | undefined): Array<Record<string, unknown>> | undefined {
    if (!data) return undefined;
    const viewer = data["viewer"] as Record<string, unknown> | undefined;
    if (!viewer) return undefined;
    const prsNode = viewer["pullRequests"] as Record<string, unknown> | undefined;
    if (!prsNode) return undefined;
    return (prsNode["nodes"] as Array<Record<string, unknown>>) ?? [];
  }

  /**
   * Drop everything outside `scopeRepos`. No-op when scoping is off. Counts are
   * recomputed from the filtered sets so the stats cards match what's shown.
   */
  private scopeWorkload(wl: ViewerWorkload): ViewerWorkload {
    if (this.scopeRepos.length === 0) return wl;
    const inScope = new Set(this.scopeRepos);
    const prs = wl.prs.filter((p) => inScope.has(p.repo));
    const assignedIssues = wl.assignedIssues.filter((i) => inScope.has(i.repo));
    const reviewRequestedPrs = wl.reviewRequestedPrs.filter((p) => inScope.has(p.repo));
    const personalReviewRequestedPrs = wl.personalReviewRequestedPrs.filter((p) => inScope.has(p.repo));
    return {
      prs,
      assignedIssues,
      assignedIssuesTotalCount: assignedIssues.length,
      reviewRequestedPrs,
      reviewRequestedPrsTotalCount: reviewRequestedPrs.length,
      personalReviewRequestedPrs,
      personalReviewRequestsTotalCount: personalReviewRequestedPrs.length,
    };
  }

  /**
   * One round-trip: PR list (with inline check rollups) plus the three search
   * feeds. Returns undefined — rather than throwing — when the PR container is
   * missing, so the caller can fall back to the split requests.
   */
  private async fetchWorkloadCombined(): Promise<ViewerWorkload | undefined> {
    const data = await ghGraphql(`query { ${this.prListBlock(true)} ${this.searchesBlock()} }`);
    const nodes = this.extractPrNodes(data);
    if (!nodes) return undefined;

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
    applyRulesetReviewRequirements(raws);
    return this.assembleWorkload(raws, data!);
  }

  /**
   * Cheaper fallback: the PR list (no rollups) and the searches run as two
   * parallel requests — each well under GitHub's budget — then the check
   * rollups are batched into one more request. Throws when the PR list itself
   * fails so the poller keeps its last good snapshot.
   */
  private async fetchWorkloadSplit(): Promise<ViewerWorkload> {
    const [prData, searchData] = await Promise.all([
      ghGraphql(`query { ${this.prListBlock(false)} }`),
      ghGraphql(`query { ${this.searchesBlock()} }`),
    ]);
    const nodes = this.extractPrNodes(prData);
    if (!nodes) {
      throw new Error("fetchViewerWorkload(split): GitHub returned no PR list (HTTP or GraphQL error)");
    }
    const raws: RawPr[] = [];
    for (const n of nodes) {
      const repoNode = n["repository"] as Record<string, unknown> | undefined;
      if (repoNode?.["isArchived"]) continue;
      raws.push(normalizePr(n));
    }
    await this.attachChecks(raws);
    applyRulesetReviewRequirements(raws);
    return this.assembleWorkload(raws, searchData ?? {});
  }

  /** Fetch + attach check rollups for each PR's head commit (split mode). */
  private async attachChecks(raws: RawPr[]): Promise<void> {
    const commits = raws
      .filter((r) => r.headRefOid && r.repo.includes("/"))
      .map((r) => {
        const [owner, name] = r.repo.split("/");
        return { owner: owner!, name: name!, oid: r.headRefOid };
      });
    if (commits.length === 0) return;
    const byOid = await fetchContextsForCommits(commits);
    for (const r of raws) {
      const checks = byOid.get(r.headRefOid);
      if (checks) r.checks.push(...checks);
    }
  }

  /** Assemble the ViewerWorkload from parsed PRs + the raw search response. */
  private assembleWorkload(raws: RawPr[], data: Record<string, unknown>): ViewerWorkload {
    const assignedIssuesNode = (data["assignedIssues"] as Record<string, unknown> | undefined) ?? {};
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

    const reviewReqNode = (data["reviewRequestedPrs"] as Record<string, unknown> | undefined) ?? {};
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

    const personalReviewNode = (data["personalReviewRequests"] as Record<string, unknown> | undefined) ?? {};
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

  async listCircleConfigFiles(repo: string): Promise<CircleConfigFile[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return [];
    const head = await this.fetchDefaultBranchHead(repo);
    if (!head) return [];
    const tree = (await ghRest(
      `/repos/${owner}/${name}/git/trees/${head.sha}?recursive=1`,
    )) as { tree?: Array<{ path?: string; type?: string }> } | undefined;
    const paths = (tree?.tree ?? [])
      .filter((t) => t.type === "blob" && typeof t.path === "string"
        && t.path.startsWith(".circleci/") && /\.ya?ml$/i.test(t.path))
      .map((t) => t.path as string);
    const files: CircleConfigFile[] = [];
    for (const path of paths) {
      const content = await this.fetchTextFile(repo, path);
      if (content != null) files.push({ path, content });
    }
    return files;
  }

  async fetchTextFile(repo: string, path: string): Promise<string | undefined> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;
    const data = (await ghRest(
      `/repos/${owner}/${name}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    )) as { content?: string; encoding?: string } | undefined;
    if (!data?.content) return undefined;
    if (data.encoding === "base64") return Buffer.from(data.content, "base64").toString("utf8");
    return data.content;
  }

  async fetchActionsWorkflows(repo: string): Promise<RawActionsWorkflow[]> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return [];
    // The Actions API lists DELETED workflows as `state: "active"` with their
    // old `.github/workflows/` path, so it can't be trusted as "what's in the
    // repo". Intersect it with the workflow files that actually exist on the
    // default-branch tree.
    const head = await this.fetchDefaultBranchHead(repo);
    if (!head) return [];
    const tree = (await ghRest(`/repos/${owner}/${name}/git/trees/${head.sha}?recursive=1`)) as
      | { tree?: Array<{ path?: string; type?: string }> }
      | undefined;
    const realPaths = new Set(
      (tree?.tree ?? [])
        .filter((t) => t.type === "blob" && isCodeDefinedWorkflowPath(t.path))
        .map((t) => t.path as string),
    );
    if (realPaths.size === 0) return [];
    const data = (await ghRest(`/repos/${owner}/${name}/actions/workflows?per_page=100`)) as
      | { workflows?: Array<{ id?: number; name?: string; path?: string; state?: string }> }
      | undefined;
    return (data?.workflows ?? [])
      .filter((w) => typeof w.id === "number" && typeof w.path === "string" && realPaths.has(w.path))
      .map((w) => ({ id: w.id as number, name: w.name ?? "", path: w.path ?? "", state: w.state ?? "active" }));
  }

  async fetchLatestWorkflowRun(repo: string, workflowId: number): Promise<RawActionsRun | undefined> {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;
    const data = (await ghRest(
      `/repos/${owner}/${name}/actions/workflows/${workflowId}/runs?per_page=1`,
    )) as { workflow_runs?: Array<Record<string, unknown>> } | undefined;
    const r = data?.workflow_runs?.[0];
    if (!r) return undefined;
    return {
      status: (r["status"] as string) ?? "",
      conclusion: (r["conclusion"] as string | null) ?? undefined,
      created_at: (r["created_at"] as string) ?? undefined,
      updated_at: (r["updated_at"] as string) ?? undefined,
      html_url: (r["html_url"] as string) ?? undefined,
    };
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
        // Skip GitHub-managed dynamic workflows (Dependabot, CodeQL default
        // setup, Copilot, …); the Projects board shows code-defined workflows.
        if (!isCodeDefinedWorkflowPath(r["path"] as string | undefined)) continue;
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
  const repository = n["repository"] as Record<string, unknown> | undefined;
  const repo = (repository?.["nameWithOwner"] as string) ?? "";
  const defaultBranch = ((repository?.["defaultBranchRef"] as Record<string, unknown> | undefined)?.["name"] as string) ?? "";
  const rulesets = (((repository?.["rulesets"] as Record<string, unknown> | undefined)?.["nodes"] as RawRuleset[]) ?? []);

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

  const fileNodes = ((n["files"] as Record<string, unknown> | undefined)?.["nodes"] as Array<Record<string, unknown>>) ?? [];
  const changedFiles = fileNodes
    .map((file) => (file["path"] as string) ?? "")
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
    // Top-level `headRefOid` is always present; the rollup commit oid is only
    // available in combined mode. Prefer the field so split mode (no inline
    // rollup) still gets the head SHA.
    headRefOid: (n["headRefOid"] as string) || (commit?.["oid"] as string) || "",
    author: ((n["author"] as Record<string, unknown> | undefined)?.["login"] as string) ?? "",
    createdAt: (n["createdAt"] as string) ?? "",
    updatedAt: (n["updatedAt"] as string) ?? "",
    reviews,
    reviewRequested,
    changedFiles,
    rulesets,
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
