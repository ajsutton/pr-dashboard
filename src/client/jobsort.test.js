import { describe, expect, test } from "bun:test";
import { jobSortRank } from "./jobsort.js";

const mk = (latest, completed) => ({
  latest: { status: latest },
  lastCompleted: completed ? { status: completed } : undefined,
});

describe("jobSortRank", () => {
  test("failing last-completed ranks first", () => {
    expect(jobSortRank(mk("success", "failed"))).toBe(0);
    expect(jobSortRank(mk("running", "failed"))).toBe(0);
    expect(jobSortRank(mk("success", "blocked"))).toBe(0);
  });

  test("currently running with non-failed history ranks second", () => {
    expect(jobSortRank(mk("running", "success"))).toBe(1);
    expect(jobSortRank(mk("queued", undefined))).toBe(1);
  });

  test("cancelled last-completed ranks third (between in progress and passing)", () => {
    expect(jobSortRank(mk("canceled", "canceled"))).toBe(2);
  });

  test("passing last-completed (and not running) ranks fourth", () => {
    expect(jobSortRank(mk("success", "success"))).toBe(3);
  });

  test("unknown falls through to the catch-all", () => {
    expect(jobSortRank(mk("unknown", undefined))).toBe(4);
  });

  test("full ordering: failing, in progress, cancelled, passing", () => {
    const failing = mk("running", "failed");
    const inProgress = mk("running", "success");
    const cancelled = mk("canceled", "canceled");
    const passing = mk("success", "success");
    const sorted = [passing, cancelled, inProgress, failing].sort(
      (a, b) => jobSortRank(a) - jobSortRank(b),
    );
    expect(sorted).toEqual([failing, inProgress, cancelled, passing]);
  });

  test("re-run of a cancelled job is bucketed as in-progress, not cancelled", () => {
    expect(jobSortRank(mk("running", "canceled"))).toBe(1);
  });
});

import { projectJobCompare } from "./jobsort.js";

describe("projectJobCompare", () => {
  const repoOrder = new Map([["o/r", 0]]);
  const mk = (over) => ({ repo: "o/r", branch: "", name: "n", ...over });

  test("scheduled sorts before non-scheduled", () => {
    const sched = mk({ name: "weekly", scheduled: true, lastRun: { found: false } });
    const plain = mk({ name: "ci", latest: { status: "success", progressPct: 100 } });
    expect(projectJobCompare(sched, plain, repoOrder)).toBeLessThan(0);
  });

  test("within scheduled, never-run/oldest sorts first", () => {
    const never = mk({ name: "a", scheduled: true, lastRun: { found: false } });
    const recent = mk({ name: "b", scheduled: true, lastRun: { found: true, at: "2026-06-26T00:00:00Z" } });
    expect(projectJobCompare(never, recent, repoOrder)).toBeLessThan(0);
  });

  test("older last-run sorts before newer", () => {
    const old = mk({ name: "a", scheduled: true, lastRun: { found: true, at: "2026-06-01T00:00:00Z" } });
    const fresh = mk({ name: "b", scheduled: true, lastRun: { found: true, at: "2026-06-25T00:00:00Z" } });
    expect(projectJobCompare(old, fresh, repoOrder)).toBeLessThan(0);
  });
});
