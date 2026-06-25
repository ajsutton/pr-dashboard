import { describe, expect, test } from "bun:test";
import { scanCircleWorkflows, type CircleConfigFile, buildCircleProjectWorkflows, buildActionsProjectWorkflows } from "./project-workflows.ts";

describe("scanCircleWorkflows", () => {
  test("unions workflow names across files, excludes version, dedupes", () => {
    const files: CircleConfigFile[] = [
      { path: ".circleci/config.yml", content: "version: 2.1\nworkflows:\n  build:\n    jobs: [a]\n" },
      { path: ".circleci/continue/main.yml", content: "workflows:\n  build:\n    jobs: [a]\n  deploy:\n    jobs: [b]\n" },
    ];
    const got = scanCircleWorkflows(files).map((w) => w.name).sort();
    expect(got).toEqual(["build", "deploy"]);
  });

  test("skips files that fail to parse or have no workflows map", () => {
    const files: CircleConfigFile[] = [
      { path: "a.yml", content: ": : not valid yaml : :" },
      { path: "b.yml", content: "jobs:\n  only-jobs:\n    steps: []\n" },
      { path: "c.yml", content: "workflows:\n  real:\n    jobs: [x]\n" },
    ];
    expect(scanCircleWorkflows(files).map((w) => w.name)).toEqual(["real"]);
  });

  test("flags legacy cron trigger as scheduled", () => {
    const content = "workflows:\n  nightly:\n    triggers:\n      - schedule:\n          cron: \"0 0 * * *\"\n          filters: {}\n    jobs: [a]\n";
    const got = scanCircleWorkflows([{ path: "x.yml", content }]);
    expect(got).toEqual([{ name: "nightly", scheduled: true }]);
  });

  test("flags when-condition referencing pipeline.schedule as scheduled", () => {
    const content = "workflows:\n  wf:\n    when: << pipeline.schedule.name >>\n    jobs: [a]\n";
    expect(scanCircleWorkflows([{ path: "x.yml", content }])[0]!.scheduled).toBe(true);
  });

  test("flags when-condition referencing a schedule-named parameter", () => {
    const content = "workflows:\n  wf:\n    when:\n      or:\n        - equal: [true, << pipeline.parameters.run_scheduled_weekly_tests >>]\n    jobs: [a]\n";
    expect(scanCircleWorkflows([{ path: "x.yml", content }])[0]!.scheduled).toBe(true);
  });

  test("plain PR-triggered workflow is not scheduled", () => {
    const content = "workflows:\n  pr:\n    jobs: [a]\n";
    expect(scanCircleWorkflows([{ path: "x.yml", content }])[0]!.scheduled).toBe(false);
  });
});

describe("buildCircleProjectWorkflows", () => {
  const base = { repo: "o/r", org: "o" };

  test("maps last run from newest insights item", () => {
    const out = buildCircleProjectWorkflows({
      ...base,
      defined: [{ name: "main", scheduled: false }],
      ranWorkflowNames: new Set(["main"]),
      runsByName: {
        main: [
          { status: "success", created_at: "2026-06-20T00:00:00Z", stopped_at: "2026-06-20T00:05:00Z" },
          { status: "failed", created_at: "2026-06-10T00:00:00Z", stopped_at: "2026-06-10T00:05:00Z" },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.lastRun).toEqual({
      found: true,
      status: "success",
      at: "2026-06-20T00:05:00Z",
      url: "https://app.circleci.com/pipelines/github/o/r",
    });
  });

  test("defined workflow that never ran → found:false, no per-workflow data needed", () => {
    const out = buildCircleProjectWorkflows({
      ...base,
      defined: [{ name: "weekly", scheduled: true }],
      ranWorkflowNames: new Set(),
      runsByName: {},
    });
    expect(out[0]!).toMatchObject({ name: "weekly", scheduled: true, provider: "circleci", lastRun: { found: false } });
  });

  test("workflow that ran but is not in defined set is still included", () => {
    const out = buildCircleProjectWorkflows({
      ...base,
      defined: [],
      ranWorkflowNames: new Set(["setup"]),
      runsByName: { setup: [{ status: "success", created_at: "2026-06-20T00:00:00Z", stopped_at: "2026-06-20T00:01:00Z" }] },
    });
    expect(out.map((w) => w.name)).toEqual(["setup"]);
    expect(out[0]!.lastRun.found).toBe(true);
  });
});

describe("buildActionsProjectWorkflows", () => {
  test("maps latest run conclusion + time + url", () => {
    const out = buildActionsProjectWorkflows("o/r", [
      {
        workflow: { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
        fileContent: "on:\n  push:\n",
        latestRun: { status: "completed", conclusion: "success", updated_at: "2026-06-20T00:05:00Z", html_url: "https://x/run/1" },
      },
    ]);
    expect(out[0]!).toMatchObject({
      repo: "o/r",
      provider: "github",
      name: "CI",
      scheduled: false,
      lastRun: { found: true, status: "success", at: "2026-06-20T00:05:00Z", url: "https://x/run/1" },
    });
  });

  test("on: schedule in the file marks it scheduled", () => {
    const out = buildActionsProjectWorkflows("o/r", [
      {
        workflow: { id: 2, name: "Nightly", path: ".github/workflows/nightly.yml", state: "active" },
        fileContent: "on:\n  schedule:\n    - cron: '0 0 * * *'\n",
        latestRun: undefined,
      },
    ]);
    expect(out[0]!).toMatchObject({ name: "Nightly", scheduled: true, lastRun: { found: false } });
  });

  test("carries disabled state", () => {
    const out = buildActionsProjectWorkflows("o/r", [
      { workflow: { id: 3, name: "Old", path: ".github/workflows/old.yml", state: "disabled_inactivity" }, latestRun: undefined },
    ]);
    expect(out[0]!.disabledState).toBe("disabled_inactivity");
  });

  test("mapActionsStatus: completed + various conclusions → correct status", () => {
    const cases: Array<[status: string, conclusion: string | null | undefined, expected: string]> = [
      ["completed", "failure", "failed"],
      ["completed", "timed_out", "failed"],
      ["completed", "startup_failure", "failed"],
      ["completed", "action_required", "failed"],
      ["completed", "cancelled", "canceled"],
      ["completed", "stale", "blocked"],
      ["completed", "neutral", "success"],
      ["completed", "skipped", "success"],
      ["completed", "weird", "unknown"],
      ["completed", null, "unknown"],
    ];
    for (const [status, conclusion, expected] of cases) {
      const out = buildActionsProjectWorkflows("o/r", [
        {
          workflow: { id: 1, name: "Test", path: ".github/workflows/test.yml", state: "active" },
          latestRun: { status, conclusion, updated_at: "2026-06-20T00:00:00Z", html_url: "https://x" },
        },
      ]);
      expect(out[0]!.lastRun.status).toBe(expected);
    }
  });

  test("mapActionsStatus: in_progress and queued statuses → correct status", () => {
    const cases: Array<[status: string, expected: string]> = [
      ["in_progress", "running"],
      ["queued", "queued"],
      ["pending", "queued"],
      ["waiting", "queued"],
      ["requested", "queued"],
      ["unknown_status", "unknown"],
    ];
    for (const [status, expected] of cases) {
      const out = buildActionsProjectWorkflows("o/r", [
        {
          workflow: { id: 1, name: "Test", path: ".github/workflows/test.yml", state: "active" },
          latestRun: { status, conclusion: null, updated_at: "2026-06-20T00:00:00Z", html_url: "https://x" },
        },
      ]);
      expect(out[0]!.lastRun.status).toBe(expected);
    }
  });
});
