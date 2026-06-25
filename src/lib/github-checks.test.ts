import { describe, expect, test } from "bun:test";
import { JobDurationStats, type RawPipeline as CircleRawPipeline, type RawWorkflow as CircleRawWorkflow } from "./circleci.ts";
import type { RawCheckContext, RawWorkflowRun } from "./dashboard-github.ts";
import { buildChecksPipelineStatus, buildCircleDefaultBranchJobs, buildDefaultBranchJobs, type CircleWorkflowRecord } from "./github-checks.ts";

describe("buildChecksPipelineStatus", () => {
  const now = Date.parse("2026-05-22T12:00:00Z");

  function mkCheck(name: string, conclusion: string, startedAgoMs: number, workflowName = "ci"): RawCheckContext {
    return {
      __typename: "CheckRun",
      name,
      status: "COMPLETED",
      conclusion,
      startedAt: new Date(now - startedAgoMs).toISOString(),
      completedAt: new Date(now - (startedAgoMs - 60_000)).toISOString(),
      detailsUrl: `https://github.com/o/r/runs/${name}`,
      workflowName,
    };
  }

  test("dedupes reran checks by name within a workflow, keeping the latest run", () => {
    const out = buildChecksPipelineStatus({
      repo: "o/r",
      commit: "abc",
      branch: "main",
      checks: [
        mkCheck("test", "FAILURE", 7_200_000),
        mkCheck("test", "SUCCESS", 600_000),
      ],
      durationStats: new JobDurationStats(),
      now,
    });
    expect(out).toBeDefined();
    expect(out!.workflows.length).toBe(1);
    expect(out!.workflows[0]!.jobs.length).toBe(1);
    expect(out!.workflows[0]!.jobs[0]!.status).toBe("success");
    expect(out!.rolledUp).toBe("success");
  });

  test("dedupes orphaned in_progress reruns with newer terminal checks", () => {
    const checks: RawCheckContext[] = [
      {
        __typename: "CheckRun",
        name: "main",
        status: "IN_PROGRESS",
        conclusion: undefined,
        startedAt: new Date(now - 90_000_000).toISOString(),
        workflowName: "ci",
        detailsUrl: "https://github.com/o/r/runs/old",
      },
      mkCheck("main", "SUCCESS", 600_000),
    ];
    const out = buildChecksPipelineStatus({
      repo: "o/r",
      commit: "abc",
      checks,
      durationStats: new JobDurationStats(),
      now,
    });
    expect(out!.rolledUp).toBe("success");
  });
});

describe("buildDefaultBranchJobs", () => {
  const now = Date.parse("2026-05-22T12:00:00Z");
  const HOUR = 3_600_000;

  function mkRun(overrides: Partial<RawWorkflowRun>): RawWorkflowRun {
    return {
      workflowId: 1,
      workflowName: "CI",
      event: "push",
      status: "completed",
      conclusion: "success",
      createdAt: new Date(now - HOUR).toISOString(),
      startedAt: new Date(now - HOUR).toISOString(),
      updatedAt: new Date(now - HOUR / 2).toISOString(),
      headSha: "abc",
      url: "https://github.com/o/r/actions/runs/1",
      runId: 1,
      ...overrides,
    };
  }

  test("one DefaultBranchJob per workflow id", () => {
    const out = buildDefaultBranchJobs({
      repo: "o/r",
      branch: "main",
      runs: [
        mkRun({ workflowId: 1, workflowName: "CI", runId: 1, url: "u-ci-1" }),
        mkRun({ workflowId: 1, workflowName: "CI", runId: 2, url: "u-ci-2", createdAt: new Date(now - 2 * HOUR).toISOString() }),
        mkRun({ workflowId: 2, workflowName: "TODO Issue Watchdog", runId: 3, url: "u-w" }),
      ],
      durationStats: new JobDurationStats(),
      now,
      windowMs: 72 * HOUR,
    });
    expect(out.length).toBe(2);
    const ci = out.find((j) => j.name === "CI")!;
    expect(ci.key).toBe("o/r::wf-1");
    // builder always sets latest when it pushes a job
    expect(ci.latest!.url).toBe("u-ci-1");
    const watchdog = out.find((j) => j.name === "TODO Issue Watchdog")!;
    expect(watchdog.key).toBe("o/r::wf-2");
  });

  test("running latest with previous completed exposes both runs", () => {
    const out = buildDefaultBranchJobs({
      repo: "o/r",
      branch: "main",
      runs: [
        mkRun({ runId: 1, createdAt: new Date(now - 3 * HOUR).toISOString(), conclusion: "success", url: "completed-url" }),
        mkRun({ runId: 2, createdAt: new Date(now - 0.2 * HOUR).toISOString(), status: "in_progress", conclusion: undefined, url: "running-url" }),
      ],
      durationStats: new JobDurationStats(),
      now,
      windowMs: 72 * HOUR,
    });
    expect(out.length).toBe(1);
    const job = out[0]!;
    expect(job.latest!.status).toBe("running");
    expect(job.latest!.url).toBe("running-url");
    expect(job.lastCompleted!.status).toBe("success");
    expect(job.lastCompleted!.url).toBe("completed-url");
  });

  test("drops workflows whose latest run started before the window", () => {
    const out = buildDefaultBranchJobs({
      repo: "o/r",
      branch: "main",
      runs: [
        mkRun({ createdAt: new Date(now - 100 * HOUR).toISOString(), startedAt: new Date(now - 100 * HOUR).toISOString() }),
      ],
      durationStats: new JobDurationStats(),
      now,
      windowMs: 72 * HOUR,
    });
    expect(out.length).toBe(0);
  });

  test("running latest with no prior completed run has undefined lastCompleted", () => {
    const out = buildDefaultBranchJobs({
      repo: "o/r",
      branch: "main",
      runs: [
        mkRun({ status: "in_progress", conclusion: undefined, createdAt: new Date(now - 0.1 * HOUR).toISOString() }),
      ],
      durationStats: new JobDurationStats(),
      now,
      windowMs: 72 * HOUR,
    });
    expect(out.length).toBe(1);
    expect(out[0]!.latest!.status).toBe("running");
    expect(out[0]!.lastCompleted).toBeUndefined();
  });
});

describe("buildCircleDefaultBranchJobs", () => {
  const now = Date.parse("2026-05-22T12:00:00Z");
  const HOUR = 3_600_000;

  function mkRecord(
    name: string,
    status: string,
    createdAgoMs: number,
    pipelineNumber = 1,
  ): CircleWorkflowRecord {
    const pipeline: CircleRawPipeline = {
      id: `pid-${pipelineNumber}`,
      number: pipelineNumber,
      createdAt: new Date(now - createdAgoMs - 1000).toISOString(),
      commit: `sha${pipelineNumber}`,
      branch: "main",
    };
    const workflow: CircleRawWorkflow = {
      id: `wf-${pipelineNumber}-${name}`,
      name,
      status,
      created_at: new Date(now - createdAgoMs).toISOString(),
      stopped_at: status === "success" || status === "failed" || status === "canceled"
        ? new Date(now - createdAgoMs + 600_000).toISOString()
        : undefined,
    };
    return { workflow, pipeline };
  }

  test("one job per CircleCI workflow name across multiple pipelines", () => {
    const out = buildCircleDefaultBranchJobs({
      repo: "ethereum-optimism/optimism",
      org: "ethereum-optimism",
      branch: "main",
      records: [
        mkRecord("build", "success", 2 * HOUR, 100),
        mkRecord("test", "failed", 2 * HOUR, 100),
        mkRecord("build", "running", 0.2 * HOUR, 101),
        mkRecord("test", "success", 0.2 * HOUR, 101),
      ],
      durationStats: new JobDurationStats(),
      now,
      windowMs: 24 * HOUR,
    });
    const byName = new Map(out.map((j) => [j.name, j]));
    expect(byName.size).toBe(2);
    expect(byName.get("build")!.latest!.status).toBe("running");
    expect(byName.get("build")!.lastCompleted!.status).toBe("success");
    expect(byName.get("test")!.latest!.status).toBe("success");
    expect(byName.get("test")!.lastCompleted!.status).toBe("success");
  });

  test("drops workflows whose latest run is past the window", () => {
    const out = buildCircleDefaultBranchJobs({
      repo: "ethereum-optimism/optimism",
      org: "ethereum-optimism",
      branch: "main",
      records: [mkRecord("nightly", "success", 30 * HOUR)],
      durationStats: new JobDurationStats(),
      now,
      windowMs: 24 * HOUR,
    });
    expect(out.length).toBe(0);
  });

  test("builds app.circleci.com workflow URL with pipeline number + workflow id", () => {
    const out = buildCircleDefaultBranchJobs({
      repo: "ethereum-optimism/optimism",
      org: "ethereum-optimism",
      branch: "main",
      records: [mkRecord("build", "success", HOUR, 4242)],
      durationStats: new JobDurationStats(),
      now,
      windowMs: 24 * HOUR,
    });
    expect(out[0]!.latest!.url).toContain("ethereum-optimism/optimism/4242/workflows/wf-4242-build");
  });
});
