import { describe, expect, test } from "bun:test";
import { jobCategory, projectJobCompare } from "./jobsort.js";

describe("jobCategory", () => {
  // Recent-run job (in-window): has latest + lastCompleted.
  const recent = (latest, completed, over = {}) => ({
    latest: { status: latest },
    lastCompleted: completed ? { status: completed } : undefined,
    ...over,
  });
  // Expected-only job (from config/Insights): only a lastRun, no latest.
  const expected = (lastRun, over = {}) => ({ lastRun, ...over });

  test("failed last result ranks first (0)", () => {
    expect(jobCategory(recent("success", "failed"))).toBe(0);
    expect(jobCategory(recent("success", "blocked"))).toBe(0);
    // an expected workflow whose last (even old) run failed is also "failed"
    expect(jobCategory(expected({ found: true, status: "failed", at: "2026-05-01T00:00:00Z" }))).toBe(0);
  });

  test("a job that last failed stays failed while re-running", () => {
    expect(jobCategory(recent("running", "failed"))).toBe(0);
  });

  test("cancelled last result ranks second (1)", () => {
    expect(jobCategory(recent("canceled", "canceled"))).toBe(1);
    expect(jobCategory(expected({ found: true, status: "canceled", at: "2026-05-01T00:00:00Z" }))).toBe(1);
  });

  test("currently running/queued with non-failed history is in progress (2)", () => {
    expect(jobCategory(recent("running", "success"))).toBe(2);
    expect(jobCategory(recent("queued", undefined))).toBe(2);
  });

  test("scheduled but never run stays high at rank 3", () => {
    expect(jobCategory(expected({ found: false }, { scheduled: true }))).toBe(3);
  });

  test("passing last result ranks 4", () => {
    expect(jobCategory(recent("success", "success"))).toBe(4);
    expect(jobCategory(expected({ found: true, status: "success", at: "2026-06-01T00:00:00Z" }))).toBe(4);
  });

  test("ran with an unknown status falls through to other (5)", () => {
    expect(jobCategory(expected({ found: true, status: "unknown", at: "2026-06-01T00:00:00Z" }))).toBe(5);
  });

  test("never run (not scheduled) drops to the very end (6)", () => {
    expect(jobCategory(expected({ found: false }, { scheduled: false }))).toBe(6);
  });

  test("full category ordering", () => {
    const failed = recent("running", "failed");
    const cancelled = recent("canceled", "canceled");
    const inProgress = recent("running", "success");
    const schedNever = expected({ found: false }, { scheduled: true });
    const passing = recent("success", "success");
    const neverRun = expected({ found: false }, { scheduled: false });
    const shuffled = [neverRun, passing, schedNever, inProgress, cancelled, failed];
    const sorted = [...shuffled].sort((a, b) => jobCategory(a) - jobCategory(b));
    expect(sorted).toEqual([failed, cancelled, inProgress, schedNever, passing, neverRun]);
  });
});

describe("projectJobCompare", () => {
  const repoOrder = new Map([["o/r", 0], ["o/s", 1]]);
  const mk = (over) => ({ repo: "o/r", branch: "", name: "n", ...over });

  test("category dominates: a failing job sorts before a scheduled-never-run job", () => {
    const failing = mk({ name: "boom", lastCompleted: { status: "failed" }, latest: { status: "failed" } });
    const schedNever = mk({ name: "weekly", scheduled: true, lastRun: { found: false } });
    expect(projectJobCompare(failing, schedNever, repoOrder)).toBeLessThan(0);
  });

  test("within a category, most recent run sorts first", () => {
    const newer = mk({ name: "a", latest: { status: "success", startedAt: "2026-06-25T00:00:00Z" }, lastCompleted: { status: "success" } });
    const older = mk({ name: "b", latest: { status: "success", startedAt: "2026-06-01T00:00:00Z" }, lastCompleted: { status: "success" } });
    expect(projectJobCompare(newer, older, repoOrder)).toBeLessThan(0);
    expect(projectJobCompare(older, newer, repoOrder)).toBeGreaterThan(0);
  });

  test("scheduled-never-run sorts before non-scheduled never-run", () => {
    const sched = mk({ name: "a", scheduled: true, lastRun: { found: false } });
    const plain = mk({ name: "b", scheduled: false, lastRun: { found: false } });
    expect(projectJobCompare(sched, plain, repoOrder)).toBeLessThan(0);
  });

  test("same category + same time falls back to repo order then name", () => {
    const a = mk({ repo: "o/r", name: "z", scheduled: true, lastRun: { found: false } });
    const b = mk({ repo: "o/s", name: "a", scheduled: true, lastRun: { found: false } });
    // o/r (index 0) before o/s (index 1) regardless of name
    expect(projectJobCompare(a, b, repoOrder)).toBeLessThan(0);
    // within the same repo, name decides
    const c = mk({ repo: "o/r", name: "alpha", scheduled: true, lastRun: { found: false } });
    const d = mk({ repo: "o/r", name: "beta", scheduled: true, lastRun: { found: false } });
    expect(projectJobCompare(c, d, repoOrder)).toBeLessThan(0);
  });
});
