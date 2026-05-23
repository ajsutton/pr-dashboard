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

export interface DashboardGitHubClient {
  fetchViewer(): Promise<{ login: string }>;
  fetchMyOpenPrs(): Promise<RawPr[]>;
  /**
   * Resolve each `owner/name` through GitHub to its current canonical
   * `nameWithOwner`. Transferred/renamed repos resolve to their new name; the
   * map is keyed by the input and is the caller's responsibility to apply.
   * Repos GitHub can't find (deleted, no access) map back to themselves.
   */
  resolveCanonicalRepoNames(repos: string[]): Promise<Map<string, string>>;
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

async function ghRest(path: string): Promise<unknown> {
  const proc = Bun.spawn(["gh", "api", path]);
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

async function ghGraphql(query: string, vars: Record<string, unknown> = {}): Promise<Record<string, unknown> | undefined> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    args.push("-f", `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  const proc = Bun.spawn(["gh", ...args]);
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) return undefined;
  try {
    const parsed = JSON.parse(out) as { data?: Record<string, unknown> };
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

  async resolveCanonicalRepoNames(repos: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (repos.length === 0) return out;
    // Batch into a single GraphQL request using aliased `repository(...)`
    // selections. Cheaper than N round-trips through `gh api`.
    const fields: string[] = [];
    const inputs: { alias: string; repo: string; owner: string; name: string }[] = [];
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i]!;
      const slash = repo.indexOf("/");
      if (slash <= 0 || slash === repo.length - 1) {
        out.set(repo, repo);
        continue;
      }
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);
      const alias = `r${i}`;
      // GraphQL string-literal escape — repo names contain only alnum/-/_/. but
      // be safe in case GitHub ever broadens that.
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      fields.push(`${alias}: repository(owner: "${esc(owner)}", name: "${esc(name)}") { nameWithOwner }`);
      inputs.push({ alias, repo, owner, name });
    }
    if (fields.length === 0) return out;
    const query = `query { ${fields.join(" ")} }`;
    const data = await ghGraphql(query);
    for (const { alias, repo } of inputs) {
      const node = data?.[alias] as { nameWithOwner?: string } | null | undefined;
      out.set(repo, node?.nameWithOwner ?? repo);
    }
    return out;
  }

  async fetchMyOpenPrs(): Promise<RawPr[]> {
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
      }
    `;
    const data = await ghGraphql(query);
    const viewer = data?.["viewer"] as Record<string, unknown> | undefined;
    const prs = viewer?.["pullRequests"] as Record<string, unknown> | undefined;
    const nodes = (prs?.["nodes"] as Array<Record<string, unknown>>) ?? [];

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
    return raws;
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
    const parent = pr.associatedOnBase.find(
      (a) => a.headRefName === pr.baseRefName && a.number !== pr.number,
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
