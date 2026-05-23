import { describe, expect, test } from "bun:test";
import {
  JobDurationStats,
  buildPipelineStatus,
  parseCircleCiUrl,
  type RawJob,
  type RawWorkflow,
} from "./circleci.ts";

describe("parseCircleCiUrl", () => {
  test("parses pipeline + workflow + job", () => {
    const out = parseCircleCiUrl(
      "https://app.circleci.com/pipelines/github/ethereum-optimism/optimism/118329/workflows/abc-def-123/jobs/4496768",
    );
    expect(out).toEqual({
      org: "ethereum-optimism",
      repo: "optimism",
      pipelineNumber: 118329,
      workflowId: "abc-def-123",
      jobNumber: 4496768,
    });
  });

  test("parses bare pipeline URL", () => {
    const out = parseCircleCiUrl(
      "https://app.circleci.com/pipelines/github/foo/bar/42",
    );
    expect(out?.pipelineNumber).toBe(42);
    expect(out?.workflowId).toBeUndefined();
    expect(out?.jobNumber).toBeUndefined();
  });

  test("returns undefined for non-circleci urls", () => {
    expect(parseCircleCiUrl("https://github.com/foo")).toBeUndefined();
    expect(parseCircleCiUrl(undefined)).toBeUndefined();
  });
});

describe("buildPipelineStatus", () => {
  const now = Date.parse("2026-05-21T12:00:00Z");

  function mkWf(status: string, createdAgoMs: number, stoppedAgoMs?: number): RawWorkflow {
    return {
      id: "wf",
      name: "ci",
      status,
      created_at: new Date(now - createdAgoMs).toISOString(),
      stopped_at: stoppedAgoMs != null ? new Date(now - stoppedAgoMs).toISOString() : undefined,
    };
  }

  function mkJob(name: string, status: string, startedAgoMs?: number, stoppedAgoMs?: number, jobNumber?: number): RawJob {
    return {
      id: name,
      name,
      status,
      job_number: jobNumber,
      started_at: startedAgoMs != null ? new Date(now - startedAgoMs).toISOString() : undefined,
      stopped_at: stoppedAgoMs != null ? new Date(now - stoppedAgoMs).toISOString() : undefined,
    };
  }

  test("rolls up to failed when any job failed", () => {
    const stats = new JobDurationStats();
    const out = buildPipelineStatus({
      org: "o",
      repo: "r",
      pipelineId: "pid",
      pipelineNumber: 1,
      commit: "abc",
      branch: "main",
      workflows: [{
        workflow: mkWf("running", 60_000),
        jobs: [
          mkJob("build", "success", 60_000, 30_000, 1),
          mkJob("test", "failed", 30_000, 10_000, 2),
        ],
      }],
      durationStats: stats,
      now,
    });
    expect(out.rolledUp).toBe("failed");
    expect(out.workflows[0]!.jobs[1]!.status).toBe("failed");
  });

  test("uses historical estimate to compute progress for a running job", () => {
    const stats = new JobDurationStats();
    // Pre-seed history for a job that typically takes 100s.
    stats.record("o/r::ci::test", 100_000);
    stats.record("o/r::ci::test", 100_000);

    const out = buildPipelineStatus({
      org: "o",
      repo: "r",
      pipelineId: "pid",
      pipelineNumber: 1,
      commit: "abc",
      branch: "main",
      workflows: [{
        workflow: mkWf("running", 50_000),
        jobs: [mkJob("test", "running", 50_000)],
      }],
      durationStats: stats,
      now,
    });
    expect(out.workflows[0]!.jobs[0]!.estimatedDurationMs).toBe(100_000);
    expect(out.progressPct).toBeGreaterThan(0);
    expect(out.progressPct).toBeLessThan(100);
  });

  test("reports 100% on a successful workflow", () => {
    const stats = new JobDurationStats();
    const out = buildPipelineStatus({
      org: "o",
      repo: "r",
      pipelineId: "pid",
      pipelineNumber: 1,
      commit: "abc",
      branch: "main",
      workflows: [{
        workflow: mkWf("success", 120_000, 0),
        jobs: [
          mkJob("build", "success", 120_000, 90_000),
          mkJob("test", "success", 90_000, 30_000),
        ],
      }],
      durationStats: stats,
      now,
    });
    expect(out.progressPct).toBe(100);
    expect(out.rolledUp).toBe("success");
  });

  test("dedupes reran workflows by name, keeping the latest run", () => {
    const stats = new JobDurationStats();
    const out = buildPipelineStatus({
      org: "o",
      repo: "r",
      pipelineId: "pid",
      pipelineNumber: 1,
      commit: "abc",
      branch: "main",
      workflows: [
        {
          workflow: { ...mkWf("failed", 7_200_000, 7_000_000), id: "old", name: "main" },
          jobs: [mkJob("build", "failed", 7_200_000, 7_000_000, 1)],
        },
        {
          workflow: { ...mkWf("success", 600_000, 60_000), id: "new", name: "main" },
          jobs: [mkJob("build", "success", 600_000, 60_000, 2)],
        },
      ],
      durationStats: stats,
      now,
    });
    expect(out.workflows.length).toBe(1);
    expect(out.workflows[0]!.id).toBe("new");
    expect(out.rolledUp).toBe("success");
  });

  test("dedupes canceled workflows superseded by a successful rerun", () => {
    const stats = new JobDurationStats();
    const out = buildPipelineStatus({
      org: "o",
      repo: "r",
      pipelineId: "pid",
      pipelineNumber: 1,
      commit: "abc",
      branch: "main",
      workflows: [
        {
          workflow: { ...mkWf("canceled", 25_200_000, 24_800_000), id: "old", name: "main" },
          jobs: [mkJob("build", "canceled", 25_200_000, 24_800_000, 1)],
        },
        {
          workflow: { ...mkWf("success", 3_500_000, 2_200_000), id: "new", name: "main" },
          jobs: [mkJob("build", "success", 3_500_000, 2_200_000, 2)],
        },
      ],
      durationStats: stats,
      now,
    });
    expect(out.workflows.length).toBe(1);
    expect(out.workflows[0]!.status).toBe("success");
    expect(out.rolledUp).toBe("success");
  });

  test("dedupes reran jobs by name within a workflow, keeping the latest run", () => {
    const stats = new JobDurationStats();
    const out = buildPipelineStatus({
      org: "o",
      repo: "r",
      pipelineId: "pid",
      pipelineNumber: 1,
      commit: "abc",
      branch: "main",
      workflows: [{
        workflow: mkWf("success", 600_000, 60_000),
        jobs: [
          mkJob("test", "failed", 600_000, 500_000, 1),
          mkJob("test", "success", 400_000, 60_000, 2),
        ],
      }],
      durationStats: stats,
      now,
    });
    expect(out.workflows[0]!.jobs.length).toBe(1);
    expect(out.workflows[0]!.jobs[0]!.status).toBe("success");
    expect(out.rolledUp).toBe("success");
  });

  test("attaches failed-test names to jobs", () => {
    const stats = new JobDurationStats();
    const out = buildPipelineStatus({
      org: "o",
      repo: "r",
      pipelineId: "pid",
      pipelineNumber: 1,
      commit: "abc",
      branch: "main",
      workflows: [{
        workflow: mkWf("running", 60_000),
        jobs: [mkJob("e2e", "failed", 60_000, 20_000, 9)],
        failedTestsByJob: { 9: ["TestFoo", "TestBar"] },
      }],
      durationStats: stats,
      now,
    });
    expect(out.workflows[0]!.jobs[0]!.failedTests).toEqual(["TestFoo", "TestBar"]);
  });
});
