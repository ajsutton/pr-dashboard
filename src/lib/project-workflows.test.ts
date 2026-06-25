import { describe, expect, test } from "bun:test";
import { scanCircleWorkflows, type CircleConfigFile } from "./project-workflows.ts";

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
