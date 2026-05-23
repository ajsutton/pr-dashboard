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
  type RawWorkflowRun,
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
import type {
  CiPipelineStatus,
  DashboardSnapshot,
  DefaultBranchJob,
  MergeQueueEntry,
  PrCard,
} from "../types.ts";

const GITHUB_REFRESH_MS = 60_000;
const CI_FAST_MS = 12_000;
const CI_SLOW_MS = 60_000;
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

  private ciByCommit = new Map<string, CiPipelineStatus>();
  private durationStats = new JobDurationStats();

  private stopped = false;
  private githubTimer: ReturnType<typeof setTimeout> | null = null;
  private ciTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DashboardPollerOpts) {
    this.github = opts.github ?? new RealDashboardGitHubClient();
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
    this.log("start: complete");
  }

  stop(): void {
    this.stopped = true;
    if (this.githubTimer) clearTimeout(this.githubTimer);
    if (this.ciTimer) clearTimeout(this.ciTimer);
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
      this.rawPrs = await this.github.fetchMyOpenPrs();
      this.prs = buildPrCards(this.rawPrs);
      this.log(`fetched ${this.rawPrs.length} open PRs`);

      const prRepos = Array.from(new Set(this.rawPrs.map((p) => p.repo))).sort(
        (a, b) => a.localeCompare(b),
      );
      // Resolve pinned + PR repos through GitHub so a transferred repo's old
      // alias collapses onto its new name; otherwise the same repo shows up
      // twice (once via the env-var pin, once via the open PR).
      let canonical = new Map<string, string>();
      try {
        canonical = await this.github.resolveCanonicalRepoNames([...this.pinnedRepos, ...prRepos]);
      } catch (err) {
        this.errors.push(`canonical-repo-names: ${String(err)}`);
      }
      this.repos = dedupReposByCanonical(this.pinnedRepos, prRepos, canonical);
      const repos = this.repos;

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
 * Resolve pinned + PR-discovered repo names through `canonical` (a map from
 * input name to the `nameWithOwner` GitHub currently reports), then dedupe.
 * Pinned entries keep their declared order; PR-discovered entries follow.
 *
 * Why: a repo transfer leaves the old `owner/name` as a redirect alias.
 * GraphQL silently follows the redirect, so pinning the old alias while a PR
 * lives under the new owner would otherwise produce two cards (and two queue
 * rows) for the same underlying repo.
 */
export function dedupReposByCanonical(
  pinned: string[],
  prRepos: string[],
  canonical: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...pinned, ...prRepos]) {
    const c = canonical.get(r) ?? r;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}
