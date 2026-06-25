/**
 * Dashboard polling orchestrator.
 *
 * Cadence:
 *   - GitHub: open PRs + merge queues every 60s. Cheap (one GraphQL call).
 *   - CircleCI: for each tracked head SHA + default branch, poll workflow/job
 *     state every 12s while any workflow is running, else every 60s.
 *
 * The snapshot is rebuilt and broadcast over WebSocket whenever it changes.
 */

import {
  RealDashboardGitHubClient,
  buildPrCards,
  buildStacks,
  type DashboardGitHubClient,
  type RawCheckContext,
  type RawMergeQueueEntry,
  type RawPr,
  type RawReviewRequestItem,
  type RawStatItem,
  type RawWorkflowRun,
  type RepoMeta,
} from "./dashboard-github.ts";
import {
  RealCircleCiClient,
  JobDurationStats,
  buildPipelineStatus,
  isCircleCiUrl,
  parseCircleCiUrl,
  type CircleCiClient,
  type RawJob,
  type RawPipeline as CircleRawPipeline,
  type RawWorkflow,
} from "./circleci.ts";
import { buildChecksPipelineStatus, buildCircleDefaultBranchJobs, buildDefaultBranchJobs, mergePipelines, type CircleWorkflowRecord } from "./github-checks.ts";
import {
  scanCircleWorkflows,
  buildCircleProjectWorkflows,
  buildActionsProjectWorkflows,
  mergeProjectWorkflows,
  type ProjectWorkflow,
  type ActionsWorkflowInput,
} from "./project-workflows.ts";
import type {
  CiPipelineStatus,
  DashboardSnapshot,
  DashboardStats,
  DefaultBranchJob,
  MergeQueueEntry,
  PrCard,
  RepoCount,
  ReviewRequestItem,
  StatItem,
} from "../types.ts";

const GITHUB_REFRESH_MS = 60_000;
const CI_FAST_MS = 12_000;
const CI_SLOW_MS = 60_000;
const PROJECT_WORKFLOWS_MS = Number(process.env.DASHBOARD_PROJECT_WORKFLOWS_MS) || 300_000;
const PROJECT_WORKFLOWS_ENABLED = process.env.DASHBOARD_PROJECT_WORKFLOWS !== "0";
/** Window for the default-branch / projects view. Workflows whose latest run is older than this are dropped. */
const DEFAULT_BRANCH_RUN_WINDOW_HOURS = 72;

export interface DashboardPollerOpts {
  github?: DashboardGitHubClient;
  circle?: CircleCiClient;
  onSnapshot: (snap: DashboardSnapshot) => void;
  logger?: (msg: string) => void;
  /**
   * Repos (owner/name) to always display, even when the viewer has no open
   * PRs against them. Shown in declared order ahead of PR-discovered repos.
   */
  pinnedRepos?: string[];
  /**
   * When non-empty, the viewer's PRs / assigned issues / review requests are
   * scoped to only these repos (server-side). Passed through to the GitHub
   * client. Ignored when a custom `github` client is supplied.
   */
  scopeRepos?: string[];
}

interface CiTarget {
  org: string;
  repo: string;
  /** Optional — when missing we look up by SHA via the branch listing. */
  pipelineNumber?: number | undefined;
  pipelineId?: string | undefined;
  workflowId?: string | undefined;
  commit: string;
  branch?: string | undefined;
}

export class DashboardPoller {
  private github: DashboardGitHubClient;
  private circle: CircleCiClient;
  private onSnapshot: (snap: DashboardSnapshot) => void;
  private log: (msg: string) => void;

  private viewerLogin = "";
  private prs: PrCard[] = [];
  private rawPrs: RawPr[] = [];
  private mergeQueues: { repo: string; entries: RawMergeQueueEntry[] }[] = [];
  private defaultBranchJobs: DefaultBranchJob[] = [];
  private defaultBranchByRepo: { repo: string; branch: string }[] = [];
  private repos: string[] = [];
  private pinnedRepos: string[] = [];
  private errors: string[] = [];
  private stats: DashboardStats = emptyStats();
  private ghOrigin = "https://github.com";

  private ciByCommit = new Map<string, CiPipelineStatus>();
  private durationStats = new JobDurationStats();

  private stopped = false;
  private githubTimer: ReturnType<typeof setTimeout> | null = null;
  private ciTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedByRepo = new Map<string, ProjectWorkflow[]>();
  private projectWorkflowsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DashboardPollerOpts) {
    this.github = opts.github ?? new RealDashboardGitHubClient({ scopeRepos: opts.scopeRepos ?? [] });
    this.circle = opts.circle ?? new RealCircleCiClient();
    this.onSnapshot = opts.onSnapshot;
    this.log = opts.logger ?? (() => {});
    this.pinnedRepos = opts.pinnedRepos ?? [];
  }

  async start(): Promise<void> {
    this.log("start: fetching viewer + open PRs…");
    await this.refreshGitHub();
    this.scheduleGitHub();
    await this.refreshCi();
    this.scheduleCi();
    if (PROJECT_WORKFLOWS_ENABLED && this.pinnedRepos.length > 0) {
      await this.refreshProjectWorkflows();
      this.scheduleProjectWorkflows();
    }
    this.log("start: complete");
  }

  stop(): void {
    this.stopped = true;
    if (this.githubTimer) clearTimeout(this.githubTimer);
    if (this.ciTimer) clearTimeout(this.ciTimer);
    if (this.projectWorkflowsTimer) clearTimeout(this.projectWorkflowsTimer);
  }

  private scheduleGitHub(): void {
    if (this.stopped) return;
    this.githubTimer = setTimeout(async () => {
      await this.refreshGitHub();
      this.scheduleGitHub();
    }, GITHUB_REFRESH_MS);
  }

  private scheduleCi(): void {
    if (this.stopped) return;
    const anyRunning = this.anyCiRunning();
    const delay = anyRunning ? CI_FAST_MS : CI_SLOW_MS;
    this.ciTimer = setTimeout(async () => {
      await this.refreshCi();
      this.scheduleCi();
    }, delay);
  }

  private scheduleProjectWorkflows(): void {
    if (this.stopped) return;
    this.projectWorkflowsTimer = setTimeout(async () => {
      await this.refreshProjectWorkflows();
      this.scheduleProjectWorkflows();
    }, PROJECT_WORKFLOWS_MS);
  }

  /**
   * Slow loop: for each pinned repo, build the expected workflow set from the
   * committed CircleCI config (∪ Insights actuals) plus the GitHub Actions
   * workflows list. Best-effort; folded into defaultBranchJobs on broadcast.
   */
  async refreshProjectWorkflows(): Promise<void> {
    const next = new Map<string, ProjectWorkflow[]>();
    await Promise.all(
      this.pinnedRepos.map(async (repo) => {
        const list: ProjectWorkflow[] = [];
        const [owner, name] = repo.split("/");
        if (!owner || !name) return;
        // CircleCI
        try {
          const files = await this.github.listCircleConfigFiles(repo);
          const defined = scanCircleWorkflows(files);
          const ranNames = await this.circle.getInsightsWorkflowNames(owner, name);
          const runsByName: Record<string, import("./project-workflows.ts").RawInsightsRun[]> = {};
          await Promise.all(
            ranNames.map(async (wf) => {
              runsByName[wf] = await this.circle.getInsightsWorkflowRuns(owner, name, wf);
            }),
          );
          list.push(
            ...buildCircleProjectWorkflows({
              repo, org: owner, defined, ranWorkflowNames: new Set(ranNames), runsByName,
            }),
          );
        } catch (err) {
          this.errors.push(`project-workflows circle ${repo}: ${String(err)}`);
        }
        // GitHub Actions
        try {
          const workflows = await this.github.fetchActionsWorkflows(repo);
          const inputs: ActionsWorkflowInput[] = await Promise.all(
            workflows.map(async (w) => ({
              workflow: w,
              fileContent: w.path ? await this.github.fetchTextFile(repo, w.path) : undefined,
              latestRun: await this.github.fetchLatestWorkflowRun(repo, w.id),
            })),
          );
          list.push(...buildActionsProjectWorkflows(repo, inputs));
        } catch (err) {
          this.errors.push(`project-workflows actions ${repo}: ${String(err)}`);
        }
        next.set(repo, list);
      }),
    );
    this.expectedByRepo = next;
    this.attachCiToCards();
    this.broadcast();
  }

  private anyCiRunning(): boolean {
    for (const ci of this.ciByCommit.values()) {
      if (ci.rolledUp === "running" || ci.rolledUp === "queued") return true;
    }
    return false;
  }

  async refreshGitHub(): Promise<void> {
    try {
      if (!this.viewerLogin) {
        const v = await this.github.fetchViewer();
        this.viewerLogin = v.login;
        this.log(`viewer = ${this.viewerLogin || "(empty)"}`);
      }
      const workload = await this.github.fetchViewerWorkload();
      this.rawPrs = workload.prs;
      this.prs = buildPrCards(this.rawPrs);
      this.log(
        `fetched ${this.rawPrs.length} open PRs, ${workload.assignedIssues.length} assigned issues, ${workload.reviewRequestedPrs.length} review-requested PRs`,
      );
      // Track the gh origin we're talking to (github.com vs GHE) so we can
      // build links for repos that have no PR to derive an origin from.
      this.ghOrigin = deriveGhOrigin(this.rawPrs, this.ghOrigin);

      const prRepos = Array.from(new Set(this.rawPrs.map((p) => p.repo))).sort(
        (a, b) => a.localeCompare(b),
      );
      // Resolve pinned + PR repos through GitHub so a transferred repo's old
      // alias collapses onto its new name; otherwise the same repo shows up
      // twice (once via the env-var pin, once via the open PR). The same
      // batched query also returns each repo's open issue + PR totals.
      let repoMeta = new Map<string, RepoMeta>();
      try {
        repoMeta = await this.github.resolveRepoMeta([...this.pinnedRepos, ...prRepos]);
      } catch (err) {
        this.errors.push(`repo-meta: ${String(err)}`);
      }
      this.repos = dedupReposByCanonical(this.pinnedRepos, prRepos, repoMeta);
      const repos = this.repos;

      // Build a canonical-keyed meta map so totals match the deduped repo list.
      const canonicalMeta = new Map<string, RepoMeta>();
      for (const m of repoMeta.values()) {
        canonicalMeta.set(m.canonical, m);
      }
      this.stats = buildStats({
        viewerLogin: this.viewerLogin,
        assignedIssues: workload.assignedIssues,
        assignedIssuesTotalCount: workload.assignedIssuesTotalCount,
        reviewRequestedPrs: workload.reviewRequestedPrs,
        reviewRequestedPrsTotalCount: workload.reviewRequestedPrsTotalCount,
        personalReviewRequestedPrs: workload.personalReviewRequestedPrs,
        personalReviewRequestsTotalCount: workload.personalReviewRequestsTotalCount,
        orderedRepos: this.repos,
        repoMeta: canonicalMeta,
        ghOrigin: this.ghOrigin,
      });

      const [mqResults, defaultBranchResults] = await Promise.all([
        Promise.all(
          repos.map(async (repo) => {
            try {
              const entries = await this.github.fetchMergeQueue(repo);
              for (const e of entries) e.mine = e.author === this.viewerLogin;
              return { repo, entries };
            } catch (err) {
              this.errors.push(`merge-queue ${repo}: ${String(err)}`);
              return { repo, entries: [] };
            }
          }),
        ),
        Promise.all(
          repos.map(async (repo) => {
            try {
              const head = await this.github.fetchDefaultBranchHead(repo);
              if (!head) return undefined;
              return { repo, branch: head.branch, sha: head.sha, checks: head.checks };
            } catch (err) {
              this.errors.push(`default-branch ${repo}: ${String(err)}`);
              return undefined;
            }
          }),
        ),
      ]);

      this.mergeQueues = mqResults.filter((m) => m.entries.length > 0);
      this.defaultBranchSeed = defaultBranchResults.filter((d): d is { repo: string; branch: string; sha: string; checks: RawCheckContext[] } => !!d);

      // Recent workflow runs on the default branch (any event, any commit in
      // the last window). One card per workflow id: we pick the newest run for
      // progress + the newest terminal run for the bottom strip.
      const recentRunResults = await Promise.all(
        this.defaultBranchSeed.map(async (d) => {
          try {
            const runs = await this.github.fetchDefaultBranchRecentRuns(d.repo, d.branch, DEFAULT_BRANCH_RUN_WINDOW_HOURS);
            return { repo: d.repo, runs };
          } catch (err) {
            this.errors.push(`recent-runs ${d.repo}: ${String(err)}`);
            return { repo: d.repo, runs: [] as RawWorkflowRun[] };
          }
        }),
      );
      this.recentRunsByRepo = new Map(recentRunResults.map((r) => [r.repo, r.runs]));
      this.defaultBranchByRepo = this.defaultBranchSeed.map((d) => ({ repo: d.repo, branch: d.branch }));

      // CircleCI workflows on the default branch. Only fetch for repos whose
      // latest HEAD already shows a CircleCI status context — otherwise we'd
      // hit a public-but-unrelated CircleCI org for every tracked repo.
      const circleResults = await Promise.all(
        this.defaultBranchSeed.map(async (d) => {
          if (!d.checks.some((c) => isCircleCiUrl(c.detailsUrl) || isCircleCiUrl(c.targetUrl))) {
            return { repo: d.repo, records: [] as CircleWorkflowRecord[] };
          }
          const [owner, name] = d.repo.split("/");
          if (!owner || !name) return { repo: d.repo, records: [] as CircleWorkflowRecord[] };
          try {
            const sinceMs = Date.now() - DEFAULT_BRANCH_RUN_WINDOW_HOURS * 3_600_000;
            const pipelines = await this.circle.listPipelinesForBranchSince(owner, name, d.branch, sinceMs);
            const records: CircleWorkflowRecord[] = [];
            await Promise.all(
              pipelines.map(async (p: CircleRawPipeline) => {
                const wfs = await this.circle.getWorkflows(p.id);
                for (const wf of wfs) records.push({ workflow: wf, pipeline: p });
              }),
            );
            return { repo: d.repo, records };
          } catch (err) {
            this.errors.push(`circle-default-branch ${d.repo}: ${String(err)}`);
            return { repo: d.repo, records: [] as CircleWorkflowRecord[] };
          }
        }),
      );
      this.circleRecordsByRepo = new Map(circleResults.map((r) => [r.repo, r.records]));

      this.errors = [];
      this.attachCiToCards();
      this.broadcast();
    } catch (err) {
      this.errors.push(`github: ${String(err)}`);
      this.broadcast();
    }
  }

  /**
   * Populate `pr.ci` and `this.defaultBranchJobs` using whatever data is
   * currently available — cached CircleCI pipelines + freshly synthesized
   * GitHub Actions pipelines from the raw checks on each PR/branch.
   * Safe to call after either a GitHub refresh or a CircleCI refresh.
   */
  private attachCiToCards(): void {
    const now = Date.now();
    for (const pr of this.prs) {
      const circle = this.ciByCommit.get(pr.headSha);
      const raw = this.rawPrs.find((r) => r.headRefOid === pr.headSha);
      const gh = raw
        ? buildChecksPipelineStatus({
            repo: pr.repo,
            commit: pr.headSha,
            branch: pr.headRefName,
            checks: raw.checks,
            durationStats: this.durationStats,
            now,
            skipCircleCi: true,
          })
        : undefined;
      pr.ci = mergePipelines(circle, gh);
    }
    const jobs: DefaultBranchJob[] = [];
    const windowMs = DEFAULT_BRANCH_RUN_WINDOW_HOURS * 3_600_000;
    for (const d of this.defaultBranchSeed) {
      const runs = this.recentRunsByRepo.get(d.repo) ?? [];
      jobs.push(
        ...buildDefaultBranchJobs({
          repo: d.repo,
          branch: d.branch,
          runs,
          durationStats: this.durationStats,
          now,
          windowMs,
        }),
      );
      const circleRecords = this.circleRecordsByRepo.get(d.repo) ?? [];
      if (circleRecords.length > 0) {
        const [owner] = d.repo.split("/");
        if (owner) {
          jobs.push(
            ...buildCircleDefaultBranchJobs({
              repo: d.repo,
              branch: d.branch,
              org: owner,
              records: circleRecords,
              durationStats: this.durationStats,
              now,
              windowMs,
            }),
          );
        }
      }
    }
    this.defaultBranchJobs = jobs;

    // Fold expected/scheduled workflows from the slow loop into the job list.
    const expected: ProjectWorkflow[] = [];
    for (const repo of this.pinnedRepos) {
      const e = this.expectedByRepo.get(repo);
      if (e) expected.push(...e);
    }
    if (expected.length > 0) {
      this.defaultBranchJobs = mergeProjectWorkflows(this.defaultBranchJobs, expected);
    }

    // Attach CI to each merge queue entry using its head merge commit.
    for (const q of this.mergeQueues) {
      for (const e of q.entries) {
        if (!e.headSha) { e.ci = undefined; continue; }
        const circle = this.ciByCommit.get(e.headSha);
        const gh = buildChecksPipelineStatus({
          repo: q.repo,
          commit: e.headSha,
          checks: e.headChecks,
          durationStats: this.durationStats,
          now,
          skipCircleCi: true,
        });
        e.ci = mergePipelines(circle, gh);
      }
    }
  }

  private defaultBranchSeed: { repo: string; branch: string; sha: string; checks: RawCheckContext[] }[] = [];
  private recentRunsByRepo: Map<string, RawWorkflowRun[]> = new Map();
  private circleRecordsByRepo: Map<string, CircleWorkflowRecord[]> = new Map();

  async refreshCi(): Promise<void> {
    const targets = this.collectCiTargets();
    this.log(`refreshCi: ${targets.length} target(s) from ${this.rawPrs.length} PRs + ${this.defaultBranchSeed.length} branches`);
    const newByCommit = new Map<string, CiPipelineStatus>();

    if (targets.length > 0) {
      await Promise.all(
        targets.map(async (t) => {
          try {
            const ci = await this.fetchPipeline(t);
            if (ci) newByCommit.set(t.commit, ci);
            else this.log(`no CircleCI pipeline for ${t.org}/${t.repo}@${t.commit.slice(0, 8)}`);
          } catch (err) {
            this.errors.push(`circleci ${t.org}/${t.repo}@${t.commit.slice(0, 8)}: ${String(err)}`);
          }
        }),
      );
    }

    this.ciByCommit = newByCommit;
    this.log(`refreshCi: resolved ${newByCommit.size}/${targets.length} CircleCI pipelines`);

    this.attachCiToCards();
    this.broadcast();
  }

  private collectCiTargets(): CiTarget[] {
    const seen = new Map<string, CiTarget>();

    const addFromChecks = (
      repo: string,
      commit: string,
      branch: string | undefined,
      checks: RawCheckContext[],
    ) => {
      if (!commit) return;
      const [owner, name] = repo.split("/");
      if (!owner || !name) return;

      // First pass: anything we can parse to a concrete pipeline number wins.
      let added = false;
      for (const c of checks) {
        const url = c.detailsUrl ?? c.targetUrl;
        const parsed = parseCircleCiUrl(url);
        if (!parsed || parsed.pipelineNumber == null) continue;
        const key = `${parsed.org}/${parsed.repo}#${parsed.pipelineNumber}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          org: parsed.org,
          repo: parsed.repo,
          pipelineNumber: parsed.pipelineNumber,
          workflowId: parsed.workflowId,
          commit,
          branch,
        });
        added = true;
      }
      if (added) return;

      // Fallback: any circleci URL means we should look up the pipeline by SHA.
      const hasCircleCheck = checks.some((c) => isCircleCiUrl(c.detailsUrl) || isCircleCiUrl(c.targetUrl));
      if (!hasCircleCheck) return;
      const key = `${owner}/${name}@${commit}`;
      if (seen.has(key)) return;
      seen.set(key, { org: owner, repo: name, commit, branch });
    };

    for (const pr of this.rawPrs) {
      addFromChecks(pr.repo, pr.headRefOid, pr.headRefName, pr.checks);
    }
    for (const d of this.defaultBranchSeed) {
      addFromChecks(d.repo, d.sha, d.branch, d.checks);
    }
    for (const q of this.mergeQueues) {
      for (const e of q.entries) {
        addFromChecks(q.repo, e.headSha, undefined, e.headChecks);
      }
    }

    return Array.from(seen.values());
  }

  private async fetchPipeline(t: CiTarget): Promise<CiPipelineStatus | undefined> {
    const pipeline = await this.resolvePipeline(t);
    if (!pipeline) return undefined;
    const pipelineId = pipeline.id;
    const pipelineNumber = pipeline.number;

    const workflows = await this.circle.getWorkflows(pipelineId);
    if (workflows.length === 0) return undefined;

    const workflowJobs = await Promise.all(
      workflows.map(async (wf) => {
        const jobs = await this.circle.getJobs(wf.id);
        // For failed jobs, fetch failed test names (best-effort).
        const failedTestsByJob: Record<number, string[]> = {};
        const failedBuildJobs = jobs.filter(
          (j) => j.status === "failed" && j.job_number != null && (j.type === "build" || !j.type),
        );
        await Promise.all(
          failedBuildJobs.map(async (j) => {
            try {
              const tests = await this.circle.getFailedTests(t.org, t.repo, j.job_number!);
              if (tests.length > 0) failedTestsByJob[j.job_number!] = tests.slice(0, 20);
            } catch {
              /* ignore */
            }
          }),
        );
        return { workflow: wf, jobs, failedTestsByJob };
      }),
    );

    return buildPipelineStatus({
      org: t.org,
      repo: t.repo,
      pipelineId,
      pipelineNumber,
      commit: t.commit,
      branch: t.branch,
      workflows: workflowJobs,
      durationStats: this.durationStats,
      now: Date.now(),
    });
  }

  private pipelineCache = new Map<string, { id: string; number: number }>();

  private async resolvePipeline(t: CiTarget): Promise<{ id: string; number: number } | undefined> {
    if (t.pipelineNumber != null) {
      const cacheKey = `${t.org}/${t.repo}#${t.pipelineNumber}`;
      const cached = this.pipelineCache.get(cacheKey);
      if (cached) return cached;
      const pipe = await this.circle.getPipelineByNumber(t.org, t.repo, t.pipelineNumber);
      if (pipe) {
        const resolved = { id: pipe.id, number: t.pipelineNumber };
        this.pipelineCache.set(cacheKey, resolved);
        return resolved;
      }
      return undefined;
    }
    const cacheKey = `${t.org}/${t.repo}@${t.commit}`;
    const cached = this.pipelineCache.get(cacheKey);
    if (cached) return cached;
    const pipe = await this.circle.getPipelineForSha(t.org, t.repo, t.commit, t.branch);
    if (pipe) {
      this.pipelineCache.set(cacheKey, pipe);
      return pipe;
    }
    return undefined;
  }

  /** Drop the internal `headChecks` field before sending entries over the wire. */
  private publicMergeQueues(): { repo: string; entries: MergeQueueEntry[] }[] {
    return this.mergeQueues.map(({ repo, entries }) => ({
      repo,
      entries: entries.map((e) => {
        const { headChecks: _omit, ...rest } = e;
        return rest;
      }),
    }));
  }

  private snapshot(): DashboardSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      user: this.viewerLogin,
      prs: this.prs,
      stacks: buildStacks(this.prs),
      mergeQueues: this.publicMergeQueues(),
      defaultBranchJobs: this.defaultBranchJobs,
      defaultBranchByRepo: this.defaultBranchByRepo,
      repos: this.repos,
      stats: this.stats,
      errors: [...this.errors],
    };
  }

  private broadcast(): void {
    this.onSnapshot(this.snapshot());
  }

  getSnapshot(): DashboardSnapshot {
    return this.snapshot();
  }
}

/**
 * Resolve pinned + PR-discovered repo names through `repoMeta` (a map from
 * input name to RepoMeta whose `.canonical` is the `nameWithOwner` GitHub
 * currently reports), then dedupe. Pinned entries keep their declared order;
 * PR-discovered entries follow.
 *
 * Why: a repo transfer leaves the old `owner/name` as a redirect alias.
 * GraphQL silently follows the redirect, so pinning the old alias while a PR
 * lives under the new owner would otherwise produce two cards (and two queue
 * rows) for the same underlying repo.
 */
export function dedupReposByCanonical(
  pinned: string[],
  prRepos: string[],
  repoMeta: Map<string, RepoMeta>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...pinned, ...prRepos]) {
    const c = repoMeta.get(r)?.canonical ?? r;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

export function emptyStats(): DashboardStats {
  return {
    assignedIssues: [],
    assignedIssuesTotalCount: 0,
    reviewRequests: [],
    reviewRequestsTotalCount: 0,
    personalReviewRequests: [],
    personalReviewRequestsTotalCount: 0,
    totalIssuesByRepo: [],
    totalPrsByRepo: [],
  };
}

/**
 * Pick the GitHub origin (github.com vs an enterprise host) from any PR URL
 * we've already seen. Falls back to the prior origin so we don't oscillate
 * between refreshes that produce zero PRs.
 */
export function deriveGhOrigin(prs: { url: string }[], fallback: string): string {
  for (const p of prs) {
    try {
      return new URL(p.url).origin;
    } catch {
      /* skip */
    }
  }
  return fallback;
}

/**
 * Build the per-repo totals card data. The URL points at the repo's
 * filtered issue / PR list on GitHub so the user can drill in.
 */
export function buildTotalsByRepo(
  orderedRepos: string[],
  repoMeta: Map<string, RepoMeta>,
  kind: "issues" | "prs",
  ghOrigin: string,
): RepoCount[] {
  return orderedRepos.map((repo) => {
    const m = repoMeta.get(repo);
    const count = kind === "issues" ? (m?.openIssues ?? 0) : (m?.openPrs ?? 0);
    const path = kind === "issues" ? "issues?q=is%3Aissue+is%3Aopen" : "pulls?q=is%3Apr+is%3Aopen";
    return { repo, count, url: `${ghOrigin}/${repo}/${path}` };
  });
}

interface BuildStatsArgs {
  viewerLogin: string;
  assignedIssues: RawStatItem[];
  assignedIssuesTotalCount: number;
  reviewRequestedPrs: RawReviewRequestItem[];
  reviewRequestedPrsTotalCount: number;
  personalReviewRequestedPrs: RawStatItem[];
  personalReviewRequestsTotalCount: number;
  orderedRepos: string[];
  repoMeta: Map<string, RepoMeta>;
  ghOrigin: string;
}

/** Pure: assemble the DashboardStats from raw inputs. */
export function buildStats(args: BuildStatsArgs): DashboardStats {
  const assignedIssues: StatItem[] = args.assignedIssues.map((i) => ({
    repo: i.repo,
    number: i.number,
    title: i.title,
    url: i.url,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  }));
  const reviewRequests: ReviewRequestItem[] = args.reviewRequestedPrs.map((p) => ({
    repo: p.repo,
    number: p.number,
    title: p.title,
    url: p.url,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    isPersonal: !!args.viewerLogin && p.reviewerLogins.includes(args.viewerLogin),
  }));
  const personalReviewRequests: StatItem[] = args.personalReviewRequestedPrs.map((p) => ({
    repo: p.repo,
    number: p.number,
    title: p.title,
    url: p.url,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
  return {
    assignedIssues,
    assignedIssuesTotalCount: args.assignedIssuesTotalCount,
    reviewRequests,
    reviewRequestsTotalCount: args.reviewRequestedPrsTotalCount,
    personalReviewRequests,
    personalReviewRequestsTotalCount: args.personalReviewRequestsTotalCount,
    totalIssuesByRepo: buildTotalsByRepo(args.orderedRepos, args.repoMeta, "issues", args.ghOrigin),
    totalPrsByRepo: buildTotalsByRepo(args.orderedRepos, args.repoMeta, "prs", args.ghOrigin),
  };
}
