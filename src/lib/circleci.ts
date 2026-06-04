/**
 * Minimal CircleCI v2 API client.
 *
 * Public projects (e.g. ethereum-optimism/optimism) do not require auth.
 * Provide $CITOKEN for private projects or to lift the per-IP rate limit.
 */

import type { CiJobStatus, CiPipelineStatus, CiWorkflowStatus } from "../types.ts";
import { debugLog, truncateBody } from "./debug.ts";

const BASE = "https://circleci.com/api/v2";

const CI_STATUS_MAP: Record<string, CiJobStatus["status"]> = {
  success: "success",
  running: "running",
  not_run: "unknown",
  failed: "failed",
  error: "failed",
  failing: "failed",
  on_hold: "blocked",
  blocked: "blocked",
  canceled: "canceled",
  cancelled: "canceled",
  unauthorized: "blocked",
  queued: "queued",
  not_running: "queued",
  retried: "running",
};

function mapStatus(raw: string | undefined): CiJobStatus["status"] {
  if (!raw) return "unknown";
  return CI_STATUS_MAP[raw] ?? "unknown";
}

function rollUp(statuses: CiJobStatus["status"][]): CiJobStatus["status"] {
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.some((s) => s === "queued")) return "queued";
  if (statuses.some((s) => s === "blocked")) return "blocked";
  if (statuses.length > 0 && statuses.every((s) => s === "success")) return "success";
  if (statuses.some((s) => s === "canceled")) return "canceled";
  return "unknown";
}

/**
 * Pull `(org, repo, pipelineNumber, workflowId)` out of a CircleCI URL like
 * `https://app.circleci.com/pipelines/github/ORG/REPO/12345/workflows/UUID/jobs/678`.
 */
export interface ParsedCircleCiUrl {
  org: string;
  repo: string;
  /** Pipeline number, if the URL is the new app.circleci.com form. */
  pipelineNumber?: number | undefined;
  workflowId?: string | undefined;
  /** Job number, present for legacy URLs (circleci.com/gh/.../<job>) and new ones (.../jobs/<job>). */
  jobNumber?: number | undefined;
}

export function parseCircleCiUrl(url: string | undefined): ParsedCircleCiUrl | undefined {
  if (!url) return undefined;
  // New: https://app.circleci.com/pipelines/github/ORG/REPO/PIPELINE[/workflows/UUID[/jobs/JOB]]
  const newMatch = url.match(/circleci\.com\/(?:pipelines|api\/v2\/pipeline)\/(?:github\/)?([^/?]+)\/([^/?]+)\/(\d+)(?:\/workflows\/([0-9a-f-]+))?(?:\/jobs\/(\d+))?/i);
  if (newMatch) {
    return {
      org: newMatch[1]!,
      repo: newMatch[2]!,
      pipelineNumber: parseInt(newMatch[3]!, 10),
      workflowId: newMatch[4],
      jobNumber: newMatch[5] ? parseInt(newMatch[5]!, 10) : undefined,
    };
  }
  // Legacy: https://circleci.com/gh/ORG/REPO/JOB_NUMBER
  const legacy = url.match(/circleci\.com\/gh\/([^/?]+)\/([^/?]+)\/(\d+)/i);
  if (legacy) {
    return {
      org: legacy[1]!,
      repo: legacy[2]!,
      jobNumber: parseInt(legacy[3]!, 10),
    };
  }
  return undefined;
}

/** True if the URL points at any CircleCI host. */
export function isCircleCiUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /\bcircleci\.com\b/i.test(url);
}

export interface CircleCiClient {
  getPipelineByNumber(org: string, repo: string, number: number): Promise<{ id: string } | undefined>;
  getPipelineForSha(org: string, repo: string, sha: string, branch?: string): Promise<{ id: string; number: number } | undefined>;
  getLatestPipelineForBranch(org: string, repo: string, branch: string): Promise<{ id: string; number: number; vcs: { revision: string; branch: string } } | undefined>;
  /**
   * Page through pipelines on the branch newest-first, stopping once we
   * either pass the time cutoff or run out of pages. Used by the default
   * branch view so jobs that ran on older commits within the window still
   * show up.
   */
  listPipelinesForBranchSince(org: string, repo: string, branch: string, sinceMs: number): Promise<RawPipeline[]>;
  getWorkflows(pipelineId: string): Promise<RawWorkflow[]>;
  getJobs(workflowId: string): Promise<RawJob[]>;
  getFailedTests(org: string, repo: string, jobNumber: number): Promise<string[]>;
}

export interface RawPipeline {
  id: string;
  number: number;
  createdAt: string;
  commit: string;
  branch: string;
}

export interface RawWorkflow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  stopped_at?: string | undefined;
}

export interface RawJob {
  id: string;
  name: string;
  status: string;
  job_number?: number | undefined;
  started_at?: string | undefined;
  stopped_at?: string | undefined;
  type?: string | undefined;
}

export class RealCircleCiClient implements CircleCiClient {
  private headers: Record<string, string>;

  constructor(token: string | undefined = process.env.CITOKEN) {
    this.headers = { "Accept": "application/json" };
    if (token) this.headers["Circle-Token"] = token;
  }

  private async get<T>(pathWithQuery: string): Promise<T | undefined> {
    const started = Date.now();
    const authed = this.headers["Circle-Token"] ? "authed" : "anon";
    debugLog("circleci", `request GET ${pathWithQuery} (${authed})`);
    try {
      const res = await fetch(`${BASE}${pathWithQuery}`, { headers: this.headers });
      const text = await res.text().catch(() => "");
      debugLog("circleci", `GET ${pathWithQuery} → HTTP ${res.status} in ${Date.now() - started}ms: ${truncateBody(text)}`);
      if (!res.ok) return undefined;
      return JSON.parse(text) as T;
    } catch (err) {
      debugLog("circleci", `GET ${pathWithQuery} → error: ${String(err)}`);
      return undefined;
    }
  }

  async getPipelineByNumber(org: string, repo: string, number: number): Promise<{ id: string } | undefined> {
    const data = await this.get<{ id?: string }>(`/project/gh/${org}/${repo}/pipeline/${number}`);
    if (!data?.id) return undefined;
    return { id: data.id };
  }

  async getPipelineForSha(org: string, repo: string, sha: string, branch?: string): Promise<{ id: string; number: number } | undefined> {
    const branchQuery = branch ? `?branch=${encodeURIComponent(branch)}` : "";
    const data = await this.get<{ items?: Array<{ id: string; number: number; vcs?: { revision?: string } }> }>(
      `/project/gh/${org}/${repo}/pipeline${branchQuery}`,
    );
    const match = (data?.items ?? []).find((p) => p.vcs?.revision === sha);
    if (!match) return undefined;
    return { id: match.id, number: match.number };
  }

  async listPipelinesForBranchSince(org: string, repo: string, branch: string, sinceMs: number): Promise<RawPipeline[]> {
    const out: RawPipeline[] = [];
    let pageToken: string | undefined = undefined;
    const MAX_PAGES = 10;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ branch });
      if (pageToken) params.set("page-token", pageToken);
      const data = await this.get<{
        items?: Array<{ id: string; number: number; created_at: string; vcs?: { revision?: string; branch?: string } }>;
        next_page_token?: string | null;
      }>(`/project/gh/${org}/${repo}/pipeline?${params.toString()}`);
      const items = data?.items ?? [];
      if (items.length === 0) break;
      let foundOld = false;
      for (const p of items) {
        const t = Date.parse(p.created_at);
        if (!Number.isFinite(t)) continue;
        if (t < sinceMs) { foundOld = true; continue; }
        out.push({
          id: p.id,
          number: p.number,
          createdAt: p.created_at,
          commit: p.vcs?.revision ?? "",
          branch: p.vcs?.branch ?? branch,
        });
      }
      if (foundOld) break;
      pageToken = data?.next_page_token ?? undefined;
      if (!pageToken) break;
    }
    return out;
  }

  async getLatestPipelineForBranch(org: string, repo: string, branch: string): Promise<{ id: string; number: number; vcs: { revision: string; branch: string } } | undefined> {
    const data = await this.get<{ items?: Array<{ id: string; number: number; vcs?: { revision?: string; branch?: string } }> }>(
      `/project/gh/${org}/${repo}/pipeline?branch=${encodeURIComponent(branch)}`,
    );
    const first = data?.items?.[0];
    if (!first) return undefined;
    return {
      id: first.id,
      number: first.number,
      vcs: { revision: first.vcs?.revision ?? "", branch: first.vcs?.branch ?? branch },
    };
  }

  async getWorkflows(pipelineId: string): Promise<RawWorkflow[]> {
    const data = await this.get<{ items?: RawWorkflow[] }>(`/pipeline/${pipelineId}/workflow`);
    return data?.items ?? [];
  }

  async getJobs(workflowId: string): Promise<RawJob[]> {
    const data = await this.get<{ items?: RawJob[] }>(`/workflow/${workflowId}/job`);
    return data?.items ?? [];
  }

  async getFailedTests(org: string, repo: string, jobNumber: number): Promise<string[]> {
    const data = await this.get<{ items?: Array<{ name: string; classname?: string; result: string }> }>(
      `/project/gh/${org}/${repo}/${jobNumber}/tests`,
    );
    const tests = data?.items ?? [];
    return tests
      .filter((t) => t.result === "failure" || t.result === "error")
      .map((t) => (t.classname ? `${t.classname}::${t.name}` : t.name));
  }
}

/**
 * Historical typical durations (in ms) for jobs we've seen. Used to estimate progress
 * for running jobs. Lives in-memory; warms up over the server's lifetime.
 */
export class JobDurationStats {
  private samples = new Map<string, number[]>();
  private readonly maxSamples = 20;

  record(jobKey: string, durationMs: number): void {
    if (durationMs <= 0 || !Number.isFinite(durationMs)) return;
    const arr = this.samples.get(jobKey) ?? [];
    arr.push(durationMs);
    if (arr.length > this.maxSamples) arr.shift();
    this.samples.set(jobKey, arr);
  }

  estimate(jobKey: string): number | undefined {
    const arr = this.samples.get(jobKey);
    if (!arr || arr.length === 0) return undefined;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}

function dedupeByName<T>(items: T[], nameOf: (t: T) => string, timeOf: (t: T) => number): T[] {
  const latest = new Map<string, T>();
  for (const item of items) {
    const name = nameOf(item);
    const existing = latest.get(name);
    if (!existing || timeOf(item) >= timeOf(existing)) latest.set(name, item);
  }
  return [...latest.values()];
}

/**
 * Combine workflow + jobs + duration stats into a CiPipelineStatus.
 */
export function buildPipelineStatus(opts: {
  org: string;
  repo: string;
  pipelineId: string;
  pipelineNumber: number;
  commit: string;
  branch: string | undefined;
  workflows: { workflow: RawWorkflow; jobs: RawJob[]; failedTestsByJob?: Record<number, string[]> | undefined }[];
  durationStats: JobDurationStats;
  now: number;
}): CiPipelineStatus {
  // Reran workflows (eg. "Rerun from failed") show up as multiple entries with
  // the same name on the same pipeline. Keep only the latest run per name so
  // a stale failure from before the rerun doesn't get rolled up into the
  // pipeline status. Same for jobs reran within a workflow.
  const dedupedWorkflows = dedupeByName(
    opts.workflows,
    (w) => w.workflow.name,
    (w) => Date.parse(w.workflow.created_at) || 0,
  );

  const wfStatuses: CiWorkflowStatus[] = dedupedWorkflows.map(({ workflow, jobs, failedTestsByJob }) => {
    const dedupedJobs = dedupeByName(
      jobs,
      (j) => j.name,
      (j) => (j.started_at ? Date.parse(j.started_at) : 0),
    );
    const jobItems: CiJobStatus[] = dedupedJobs.map((j) => {
      const status = mapStatus(j.status);
      const startedAt = j.started_at;
      const stoppedAt = j.stopped_at;
      const startedMs = startedAt ? Date.parse(startedAt) : undefined;
      const stoppedMs = stoppedAt ? Date.parse(stoppedAt) : undefined;
      const finishedMs = stoppedMs ?? (status === "running" && startedMs ? opts.now : undefined);
      const durationMs = startedMs && finishedMs ? finishedMs - startedMs : undefined;
      const jobKey = `${opts.org}/${opts.repo}::${workflow.name}::${j.name}`;
      if (status === "success" && durationMs) opts.durationStats.record(jobKey, durationMs);
      const estimatedDurationMs = opts.durationStats.estimate(jobKey);
      const failed = j.job_number != null && failedTestsByJob ? failedTestsByJob[j.job_number] : undefined;
      const out: CiJobStatus = {
        name: j.name,
        status,
        startedAt,
        stoppedAt,
        durationMs,
        estimatedDurationMs,
        url: j.job_number
          ? `https://app.circleci.com/pipelines/github/${opts.org}/${opts.repo}/${opts.pipelineNumber}/workflows/${workflow.id}/jobs/${j.job_number}`
          : undefined,
        failedTests: failed,
      };
      return out;
    });

    // Workflow status from CircleCI may still report "running" while a job has failed.
    // Per the dashboard's design, surface the failure immediately by rolling job
    // statuses into the workflow rollup.
    const rawWfStatus = mapStatus(workflow.status);
    const jobRollup = rollUp(jobItems.map((j) => j.status));
    const wfStatus = jobRollup === "failed" ? "failed" : rawWfStatus;
    const createdMs = Date.parse(workflow.created_at);
    const stoppedMs = workflow.stopped_at ? Date.parse(workflow.stopped_at) : undefined;
    const elapsedMs = (stoppedMs ?? opts.now) - createdMs;

    const estimatedTotalMs = estimateWorkflowDuration(jobItems);
    const progressPct = computeProgress(jobItems, wfStatus, elapsedMs, estimatedTotalMs);

    return {
      id: workflow.id,
      name: workflow.name,
      status: wfStatus,
      createdAt: workflow.created_at,
      stoppedAt: workflow.stopped_at,
      jobs: jobItems,
      estimatedTotalMs,
      elapsedMs,
      progressPct,
      url: `https://app.circleci.com/pipelines/github/${opts.org}/${opts.repo}/${opts.pipelineNumber}/workflows/${workflow.id}`,
    };
  });

  const rolledUp = rollUp(wfStatuses.map((w) => w.status));
  const elapsedMs = Math.max(...wfStatuses.map((w) => w.elapsedMs), 0);
  const estimates = wfStatuses.map((w) => w.estimatedTotalMs).filter((n): n is number => typeof n === "number");
  const estimatedTotalMs = estimates.length > 0 ? Math.max(...estimates) : undefined;
  const progressPct = computeAggregateProgress(wfStatuses, rolledUp);

  return {
    provider: "circleci",
    pipelineId: opts.pipelineId,
    pipelineNumber: opts.pipelineNumber,
    commit: opts.commit,
    branch: opts.branch,
    workflows: wfStatuses,
    rolledUp,
    progressPct,
    elapsedMs,
    estimatedTotalMs,
    url: `https://app.circleci.com/pipelines/github/${opts.org}/${opts.repo}/${opts.pipelineNumber}`,
  };
}

function estimateWorkflowDuration(jobs: CiJobStatus[]): number | undefined {
  const ests = jobs.map((j) => j.estimatedDurationMs).filter((n): n is number => typeof n === "number");
  if (ests.length === 0) return undefined;
  // Workflow is the longest path; without DAG info, take max as a proxy.
  return Math.max(...ests);
}

function computeProgress(
  jobs: CiJobStatus[],
  wfStatus: CiJobStatus["status"],
  elapsedMs: number,
  estimatedTotalMs: number | undefined,
): number {
  if (wfStatus === "success") return 100;
  if (wfStatus === "failed" || wfStatus === "canceled") return 100;
  if (jobs.length === 0) return 0;
  const done = jobs.filter((j) => j.status === "success" || j.status === "failed" || j.status === "canceled").length;
  const completionByJobCount = done / jobs.length;
  if (!estimatedTotalMs || estimatedTotalMs <= 0) {
    return Math.round(completionByJobCount * 100);
  }
  const elapsedFraction = Math.min(elapsedMs / estimatedTotalMs, 0.99);
  // Blend job-count completion (50%) with elapsed-time estimate (50%).
  const blended = 0.5 * completionByJobCount + 0.5 * elapsedFraction;
  return Math.max(0, Math.min(99, Math.round(blended * 100)));
}

function computeAggregateProgress(wfs: CiWorkflowStatus[], rolledUp: CiJobStatus["status"]): number {
  if (wfs.length === 0) return 0;
  if (rolledUp === "success" || rolledUp === "failed" || rolledUp === "canceled") return 100;
  const avg = wfs.reduce((acc, w) => acc + w.progressPct, 0) / wfs.length;
  return Math.max(0, Math.min(99, Math.round(avg)));
}
