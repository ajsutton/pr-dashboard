export interface CiJobStatus {
  name: string;
  status: "running" | "success" | "failed" | "blocked" | "canceled" | "queued" | "unknown";
  startedAt?: string | undefined;
  stoppedAt?: string | undefined;
  durationMs?: number | undefined;
  estimatedDurationMs?: number | undefined;
  url?: string | undefined;
  failedTests?: string[] | undefined;
}

export interface CiWorkflowStatus {
  id: string;
  name: string;
  status: "running" | "success" | "failed" | "blocked" | "canceled" | "queued" | "unknown";
  createdAt: string;
  stoppedAt?: string | undefined;
  jobs: CiJobStatus[];
  estimatedTotalMs?: number | undefined;
  elapsedMs: number;
  progressPct: number;
  url: string;
}

export interface CiPipelineStatus {
  provider: "circleci" | "github" | "unknown";
  pipelineId?: string | undefined;
  pipelineNumber?: number | undefined;
  commit: string;
  branch?: string | undefined;
  workflows: CiWorkflowStatus[];
  rolledUp: "running" | "success" | "failed" | "blocked" | "canceled" | "queued" | "unknown";
  progressPct: number;
  elapsedMs: number;
  estimatedTotalMs?: number | undefined;
  url?: string | undefined;
}

export interface PrCard {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision: "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "" | string;
  mergeable: string;
  isInMergeQueue: boolean;
  autoMergeEnabled: boolean;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  reviews: { login: string; state: string; submittedAt: string }[];
  reviewRequested: string[];
  parentPr?: { repo: string; number: number; state: string } | undefined;
  childPrs: { repo: string; number: number; state: string }[];
  ci?: CiPipelineStatus | undefined;
}

export interface MergeQueueEntry {
  repo: string;
  position: number;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  author: string;
  state: "QUEUED" | "MERGEABLE" | "UNMERGEABLE" | "LOCKED" | string;
  enqueuedAt: string;
  /** True if the queue entry belongs to the dashboard user. */
  mine: boolean;
  ci?: CiPipelineStatus | undefined;
}

export type CiJobStatusValue = "running" | "success" | "failed" | "blocked" | "canceled" | "queued" | "unknown";

export interface DefaultBranchJobRun {
  status: CiJobStatusValue;
  url: string;
  headSha: string;
  startedAt: string;
  stoppedAt?: string | undefined;
  elapsedMs: number;
  estimatedDurationMs?: number | undefined;
  progressPct: number;
}

export interface DefaultBranchJob {
  /** Stable identity for view-transition / DOM diffing. */
  key: string;
  repo: string;
  branch: string;
  /** Workflow name (GitHub Actions workflow or CircleCI workflow). */
  name: string;
  /** Most recent run — drives the progress / top portion of the card. */
  latest: DefaultBranchJobRun;
  /** Most recent *completed* run — drives the bottom colour. Undefined until at least one run finishes within the window. */
  lastCompleted?: DefaultBranchJobRun | undefined;
}

export interface StatItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRequestItem extends StatItem {
  /** True if the viewer's own login is in the PR's reviewRequests list. */
  isPersonal: boolean;
}

export interface RepoCount {
  repo: string;
  count: number;
  /** GitHub URL for the open list (issues or PRs). */
  url: string;
}

export interface DashboardStats {
  assignedIssues: StatItem[];
  /**
   * True total of assigned issues — `assignedIssues.length` is capped at 100
   * by the GraphQL search node limit, so cards should display this count.
   */
  assignedIssuesTotalCount: number;
  reviewRequests: ReviewRequestItem[];
  /** True total of review-requested PRs (personal + team). */
  reviewRequestsTotalCount: number;
  /**
   * PRs where the viewer's own login is requested (not via a team). Capped
   * at 100 nodes; use `personalReviewRequestsTotalCount` for the real total.
   */
  personalReviewRequests: StatItem[];
  /** True total of PRs where the viewer specifically (not a team) is requested. */
  personalReviewRequestsTotalCount: number;
  totalIssuesByRepo: RepoCount[];
  totalPrsByRepo: RepoCount[];
}

export interface DashboardSnapshot {
  generatedAt: string;
  user: string;
  prs: PrCard[];
  /** Connected components keyed by stack root, ordered base-up. */
  stacks: { rootKey: string; prKeys: string[] }[];
  mergeQueues: { repo: string; entries: MergeQueueEntry[] }[];
  /** One entry per workflow/job that ran against the default branch in the last 24h. */
  defaultBranchJobs: DefaultBranchJob[];
  /** Repo -> default branch name. Lets the client render the ship card without a job. */
  defaultBranchByRepo: { repo: string; branch: string }[];
  /**
   * Ordered list of repos to display. Pinned repos (from DASHBOARD_REPOS)
   * come first in declared order; PR-discovered repos follow alphabetically.
   */
  repos: string[];
  /** Viewer workload + per-repo totals. */
  stats: DashboardStats;
  errors: string[];
}

export type WsMessage =
  | { type: "dashboard-snapshot"; data: DashboardSnapshot }
  | { type: "reload" }
  | { type: "pong" };
