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
