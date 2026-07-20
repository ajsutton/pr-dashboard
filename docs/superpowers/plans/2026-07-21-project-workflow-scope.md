# Default-Branch Project Workflow Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exclude pull-request and merge-queue-only GitHub Actions workflows from Projects and ensure every Projects status comes from the repository default branch.

**Architecture:** A pure workflow-trigger classifier filters expected GitHub Actions definitions before run lookups. The existing per-workflow latest-run API gains a required branch argument, and the poller supplies the branch from its existing default-branch seed. Recent 72-hour runs are already branch-scoped and remain unchanged.

**Tech Stack:** Bun, TypeScript, Bun test, GitHub REST API

## Global Constraints

- Exclude only workflows whose non-empty trigger set contains no events other than `pull_request`, `pull_request_target`, and `merge_group`.
- Keep mixed-trigger workflows.
- Keep workflows whose trigger declaration cannot be classified.
- Use no pull-request or merge-queue run as Projects status.
- Preserve CircleCI behavior and the existing 72-hour recent-run window.

---

### Task 1: Classify pull-request and merge-queue-only workflows

**Files:**
- Modify: `src/lib/project-workflows.ts:197-231`
- Test: `src/lib/project-workflows.test.ts:1-186`

**Interfaces:**
- Consumes: GitHub Actions workflow file content as `string | undefined`.
- Produces: `isPullRequestOnlyActionsWorkflow(fileContent: string | undefined): boolean` for poller-side filtering.

- [ ] **Step 1: Write the failing classifier tests**

Add the export to the import list in `src/lib/project-workflows.test.ts` and add:

```ts
describe("isPullRequestOnlyActionsWorkflow", () => {
  test("excludes scalar PR-only triggers", () => {
    expect(isPullRequestOnlyActionsWorkflow("on: pull_request\n")).toBe(true);
  });

  test("excludes PR, PR-target, and merge-group-only mappings", () => {
    const content = [
      "on:",
      "  pull_request:",
      "  pull_request_target:",
      "  merge_group:",
    ].join("\n");
    expect(isPullRequestOnlyActionsWorkflow(content)).toBe(true);
  });

  test("excludes PR and merge-group-only sequences", () => {
    expect(isPullRequestOnlyActionsWorkflow("on: [pull_request, merge_group]\n")).toBe(true);
  });

  test("keeps workflows with any non-PR trigger", () => {
    expect(isPullRequestOnlyActionsWorkflow("on: [pull_request, push]\n")).toBe(false);
  });

  test("keeps missing, malformed, or unsupported trigger declarations", () => {
    expect(isPullRequestOnlyActionsWorkflow(undefined)).toBe(false);
    expect(isPullRequestOnlyActionsWorkflow("on: [\n")).toBe(false);
    expect(isPullRequestOnlyActionsWorkflow("on: 123\n")).toBe(false);
    expect(isPullRequestOnlyActionsWorkflow("name: no-triggers\n")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the classifier tests and verify failure**

Run: `bun test src/lib/project-workflows.test.ts`

Expected: FAIL because `isPullRequestOnlyActionsWorkflow` is not exported.

- [ ] **Step 3: Implement the classifier**

Add near the existing GitHub Actions helpers in `src/lib/project-workflows.ts`:

```ts
const PULL_REQUEST_ONLY_EVENTS = new Set(["pull_request", "pull_request_target", "merge_group"]);

function actionsWorkflowEvents(fileContent: string | undefined): Set<string> | undefined {
  if (!fileContent) return undefined;
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(fileContent);
  } catch {
    return undefined;
  }
  const on = (doc as Record<string, unknown> | null)?.["on"];
  if (typeof on === "string") return new Set([on]);
  if (Array.isArray(on)) {
    if (!on.every((event) => typeof event === "string")) return undefined;
    return new Set(on);
  }
  if (on && typeof on === "object") return new Set(Object.keys(on));
  return undefined;
}

export function isPullRequestOnlyActionsWorkflow(fileContent: string | undefined): boolean {
  const events = actionsWorkflowEvents(fileContent);
  return !!events?.size && [...events].every((event) => PULL_REQUEST_ONLY_EVENTS.has(event));
}
```

- [ ] **Step 4: Run the classifier tests and verify success**

Run: `bun test src/lib/project-workflows.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit the classifier**

```bash
git add src/lib/project-workflows.ts src/lib/project-workflows.test.ts
git commit -m "fix: classify PR-only project workflows"
```

---

### Task 2: Scope per-workflow latest runs to the default branch

**Files:**
- Modify: `src/lib/dashboard-github.ts:145-159,1171-1186`
- Test: `src/lib/dashboard-github.test.ts:261-358`

**Interfaces:**
- Consumes: repository name, workflow ID, and repository default branch.
- Produces: `fetchLatestWorkflowRun(repo: string, workflowId: number, branch: string): Promise<RawActionsRun | undefined>`.

- [ ] **Step 1: Write the failing branch-query test**

Inside the existing `ghRest / ghGraphql` describe block in `src/lib/dashboard-github.test.ts`, add:

```ts
test("fetchLatestWorkflowRun filters and encodes the default branch", async () => {
  stubFetch({
    body: {
      workflow_runs: [
        {
          status: "completed",
          conclusion: "success",
          created_at: "2026-07-21T00:00:00Z",
          updated_at: "2026-07-21T00:01:00Z",
          html_url: "https://github.com/o/r/actions/runs/1",
        },
      ],
    },
  });

  const client = new RealDashboardGitHubClient();
  const run = await client.fetchLatestWorkflowRun("o/r", 42, "release/v1");

  expect(calls[0]!.url).toBe(
    "https://api.github.com/repos/o/r/actions/workflows/42/runs?branch=release%2Fv1&per_page=1",
  );
  expect(run).toMatchObject({ status: "completed", conclusion: "success" });
});
```

- [ ] **Step 2: Run the API test and verify failure**

Run: `bun test src/lib/dashboard-github.test.ts`

Expected: FAIL because the request URL does not contain the branch query.

- [ ] **Step 3: Require and encode the branch argument**

Update `DashboardGitHubClient` and `RealDashboardGitHubClient` to use this signature:

```ts
fetchLatestWorkflowRun(repo: string, workflowId: number, branch: string): Promise<RawActionsRun | undefined>;
```

Build the request as:

```ts
const data = (await ghRest(
  `/repos/${owner}/${name}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
)) as { workflow_runs?: Array<Record<string, unknown>> } | undefined;
```

Keep the existing response mapping unchanged.

- [ ] **Step 4: Run the API test and verify success**

Run: `bun test src/lib/dashboard-github.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit the branch-scoped client**

```bash
git add src/lib/dashboard-github.ts src/lib/dashboard-github.test.ts
git commit -m "fix: scope workflow status to default branch"
```

---

### Task 3: Filter expected workflows before status lookup

**Files:**
- Modify: `src/lib/dashboard-poller.ts:37-46,232-259`
- Test: `src/lib/dashboard-poller.test.ts:309-481`

**Interfaces:**
- Consumes: `isPullRequestOnlyActionsWorkflow(fileContent)` from Task 1 and `fetchLatestWorkflowRun(repo, workflowId, branch)` from Task 2.
- Produces: expected GitHub Actions records containing only project-eligible workflows, with statuses scoped to the default branch.

- [ ] **Step 1: Write the failing poller integration test**

Inside `DashboardPoller refreshProjectWorkflows` in `src/lib/dashboard-poller.test.ts`, add:

```ts
test("excludes PR-only workflows and requests status only for the default branch", async () => {
  const latestRunCalls: Array<{ repo: string; workflowId: number; branch: string }> = [];
  const github: DashboardGitHubClient = {
    ...makeGitHubWithWorkflows(),
    fetchActionsWorkflows: () =>
      Promise.resolve([
        { id: 1, name: "pr-title", path: ".github/workflows/pr-title.yml", state: "active" },
        { id: 2, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      ]),
    fetchTextFile: (_repo, path) =>
      Promise.resolve(path.endsWith("pr-title.yml") ? "on: pull_request\n" : "on: [pull_request, push]\n"),
    fetchLatestWorkflowRun: (repo, workflowId, branch) => {
      latestRunCalls.push({ repo, workflowId, branch });
      return Promise.resolve({
        status: "completed",
        conclusion: "success",
        updated_at: "2026-07-21T00:01:00Z",
        html_url: "https://github.com/o/r/actions/runs/2",
      });
    },
  };
  const snapshots: DashboardSnapshot[] = [];
  const poller = new DashboardPoller({
    pinnedRepos: ["o/r"],
    github,
    circle: makeCircleWithInsights(),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  await poller.refreshGitHub();
  await poller.refreshProjectWorkflows();

  const jobs = snapshots.at(-1)!.defaultBranchJobs;
  expect(jobs.some((job) => job.name === "pr-title")).toBe(false);
  expect(jobs.find((job) => job.name === "CI")?.lastRun).toMatchObject({ found: true, status: "success" });
  expect(latestRunCalls).toEqual([{ repo: "o/r", workflowId: 2, branch: "main" }]);
});
```

- [ ] **Step 2: Run the poller test and verify failure**

Run: `bun test src/lib/dashboard-poller.test.ts`

Expected: FAIL because `pr-title` remains present and the latest-run call receives no branch.

- [ ] **Step 3: Filter definitions before fetching runs**

Import `isPullRequestOnlyActionsWorkflow` from `project-workflows.ts`. In the GitHub Actions section of `refreshProjectWorkflows`, resolve the branch once:

```ts
const branch = this.defaultBranchSeed.find((item) => item.repo === repo)?.branch;
```

First fetch workflow contents using the existing cache logic. Then filter and fetch runs:

```ts
const definitions = await Promise.all(
  workflows.map(async (workflow) => {
    let fileContent: string | undefined;
    if (workflow.path) {
      const cachedContent = fileCache!.byPath.get(workflow.path);
      if (cachedContent !== undefined) {
        fileContent = cachedContent;
      } else {
        fileContent = await this.github.fetchTextFile(repo, workflow.path);
        if (sha && fileContent != null) fileCache!.byPath.set(workflow.path, fileContent);
      }
    }
    return { workflow, fileContent };
  }),
);
const inputs: ActionsWorkflowInput[] = await Promise.all(
  definitions
    .filter(({ fileContent }) => !isPullRequestOnlyActionsWorkflow(fileContent))
    .map(async ({ workflow, fileContent }) => ({
      workflow,
      fileContent,
      latestRun: branch ? await this.github.fetchLatestWorkflowRun(repo, workflow.id, branch) : undefined,
    })),
);
```

Pass `inputs` to `buildActionsProjectWorkflows` as before. When the default branch is unavailable, retain eligible definitions with `last run not found`; never fall back to an unfiltered run request.

- [ ] **Step 4: Run the poller test and verify success**

Run: `bun test src/lib/dashboard-poller.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Run focused server regression tests**

Run:

```bash
bun test src/lib/project-workflows.test.ts src/lib/dashboard-github.test.ts src/lib/dashboard-poller.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit the poller wiring**

```bash
git add src/lib/dashboard-poller.ts src/lib/dashboard-poller.test.ts
git commit -m "fix: exclude PR-only project workflows"
```
