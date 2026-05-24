import { describe, it, expect } from "bun:test";
import { TEST_STATES, getTestCycle, injectTestPr, emptyTestSnapshot } from "./testmode.js";

const TEST_REPO = "demo/test-pr";
const TEST_KEY = `${TEST_REPO}#9999`;

describe("getTestCycle", () => {
  it("returns null when ?test is not present", () => {
    expect(getTestCycle("")).toBeNull();
    expect(getTestCycle("?foo=bar")).toBeNull();
  });

  it("returns every state for bare ?test or ?test=", () => {
    expect(getTestCycle("?test")).toEqual([...TEST_STATES]);
    expect(getTestCycle("?test=")).toEqual([...TEST_STATES]);
  });

  it("respects the order and selection given by ?test=a,b,c", () => {
    expect(getTestCycle("?test=passing,failing,merged")).toEqual([
      "passing",
      "failing",
      "merged",
    ]);
  });

  it("drops unknown state names but keeps valid ones", () => {
    expect(getTestCycle("?test=passing,bogus,merged")).toEqual(["passing", "merged"]);
  });

  it("falls back to the full cycle if nothing requested is valid", () => {
    expect(getTestCycle("?test=nope,also-nope")).toEqual([...TEST_STATES]);
  });

  it("trims whitespace around state names", () => {
    expect(getTestCycle("?test=passing,%20failing")).toEqual(["passing", "failing"]);
  });

  it("keeps base+modifier specs in the cycle (URLSearchParams decodes `+` to a space)", () => {
    // The browser turns `?test=passing+autoMergeEnabled` into the value
    // `"passing autoMergeEnabled"`, which our parser treats the same as
    // the literal `"passing+autoMergeEnabled"` form.
    expect(getTestCycle("?test=passing+autoMergeEnabled,failing+conflict")).toEqual([
      "passing autoMergeEnabled",
      "failing conflict",
    ]);
  });

  it("accepts an explicitly-encoded `%2B` to preserve the literal `+`", () => {
    expect(getTestCycle("?test=passing%2BautoMergeEnabled")).toEqual([
      "passing+autoMergeEnabled",
    ]);
  });

  it("drops entries with an unknown base even when modifiers are valid", () => {
    expect(getTestCycle("?test=bogus%2BautoMergeEnabled,passing%2Bconflict")).toEqual([
      "passing+conflict",
    ]);
  });

  it("keeps entries with unknown modifiers (modifiers themselves are dropped on apply)", () => {
    expect(getTestCycle("?test=passing%2Bnopemod,failing")).toEqual([
      "passing+nopemod",
      "failing",
    ]);
  });
});

describe("injectTestPr", () => {
  it("adds the test PR with passing CI in the passing state", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "passing");
    expect(snap.prs).toHaveLength(1);
    const pr = snap.prs[0];
    expect(pr.key).toBe(TEST_KEY);
    expect(pr.reviewDecision).toBe("APPROVED");
    expect(pr.isInMergeQueue).toBe(false);
    expect(pr.ci.rolledUp).toBe("success");
    expect(snap.stacks).toHaveLength(1);
    expect(snap.mergeQueues).toHaveLength(0);
  });

  it("marks the test PR as awaiting review with passing CI", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "awaiting");
    expect(snap.prs[0].reviewDecision).toBe("REVIEW_REQUIRED");
    expect(snap.prs[0].ci.rolledUp).toBe("success");
  });

  it("marks the test PR as failing CI", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "failing");
    expect(snap.prs[0].ci.rolledUp).toBe("failed");
    expect(snap.prs[0].ci.workflows[0].jobs.some((j) => j.status === "failed")).toBe(true);
  });

  it("exposes failed + still-running jobs in the failing-partial state", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "failing-partial");
    const jobs = snap.prs[0].ci.workflows[0].jobs;
    expect(snap.prs[0].ci.rolledUp).toBe("failed");
    expect(jobs.some((j) => j.status === "failed")).toBe(true);
    expect(jobs.some((j) => j.status === "running" || j.status === "queued")).toBe(true);
  });

  it("puts the test PR in the merge queue", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "queued");
    expect(snap.prs).toHaveLength(1);
    expect(snap.prs[0].isInMergeQueue).toBe(true);
    expect(snap.mergeQueues).toHaveLength(1);
    expect(snap.mergeQueues[0].repo).toBe(TEST_REPO);
    expect(snap.mergeQueues[0].entries).toHaveLength(1);
    expect(snap.mergeQueues[0].entries[0].mine).toBe(true);
  });

  it("removes the test PR from both lists when merged", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "merged");
    expect(snap.prs).toHaveLength(0);
    expect(snap.mergeQueues).toHaveLength(0);
  });

  it("always exposes the test repo + branch so the ship card stays mounted", () => {
    for (const state of TEST_STATES) {
      const snap = injectTestPr(emptyTestSnapshot(), state);
      expect(snap.defaultBranchByRepo.find((d) => d.repo === TEST_REPO)).toBeDefined();
      expect(snap.repos).toContain(TEST_REPO);
    }
  });

  it("applies autoMergeEnabled modifier on top of a base state", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "passing+autoMergeEnabled");
    expect(snap.prs[0].autoMergeEnabled).toBe(true);
    expect(snap.prs[0].ci.rolledUp).toBe("success");
    expect(snap.prs[0].reviewDecision).toBe("APPROVED");
  });

  it("applies conflict modifier", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "failing+conflict");
    expect(snap.prs[0].mergeable).toBe("CONFLICTING");
    expect(snap.prs[0].ci.rolledUp).toBe("failed");
  });

  it("approved modifier promotes review state on top of a non-approving base", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "failing+approved");
    expect(snap.prs[0].reviewDecision).toBe("APPROVED");
    expect(snap.prs[0].ci.rolledUp).toBe("failed");
  });

  it("stacked modifier attaches a not-on-dashboard parent so the new 'Stacked on #N' path fires", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "passing+stacked");
    expect(snap.prs[0].parentPr).toBeDefined();
    expect(snap.prs[0].parentPr.repo).toBe("demo/test-pr");
    expect(typeof snap.prs[0].parentPr.number).toBe("number");
    // The parent isn't injected into snap.prs, so the bridge-arrow path
    // doesn't trigger — exactly the case the new behaviour covers.
    expect(snap.prs).toHaveLength(1);
  });

  it("combines multiple modifiers in one spec", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "awaiting+autoMergeEnabled+conflict");
    const pr = snap.prs[0];
    expect(pr.autoMergeEnabled).toBe(true);
    expect(pr.mergeable).toBe("CONFLICTING");
    expect(pr.reviewDecision).toBe("REVIEW_REQUIRED");
  });

  it("silently ignores unknown modifiers", () => {
    const snap = injectTestPr(emptyTestSnapshot(), "passing+nopemod");
    expect(snap.prs[0].autoMergeEnabled).toBeUndefined();
    expect(snap.prs[0].mergeable).toBe("MERGEABLE");
  });

  it("layers on top of an existing snapshot without mutating it", () => {
    const real = emptyTestSnapshot();
    real.prs = [{ key: "real/repo#1", repo: "real/repo", number: 1 }];
    real.repos = ["real/repo"];
    const snap = injectTestPr(real, "passing");
    expect(snap.prs).toHaveLength(2);
    expect(snap.prs[0].key).toBe("real/repo#1");
    expect(snap.repos).toContain("real/repo");
    expect(snap.repos).toContain(TEST_REPO);
    // Original wasn't mutated.
    expect(real.prs).toHaveLength(1);
    expect(real.repos).toEqual(["real/repo"]);
  });
});
