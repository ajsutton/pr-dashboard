import { describe, it, expect } from "bun:test";
import { pipelineActivity } from "./pipeline-activity.js";

const ci = (workflows) => ({ workflows });
const wf = (jobs) => ({ jobs });
const job = (status) => ({ status });

describe("pipelineActivity", () => {
  it("returns zeroes for an undefined or empty pipeline", () => {
    expect(pipelineActivity(undefined)).toEqual({ total: 0, active: 0 });
    expect(pipelineActivity(ci([]))).toEqual({ total: 0, active: 0 });
  });

  it("counts every job across every workflow", () => {
    const out = pipelineActivity(ci([
      wf([job("success"), job("success")]),
      wf([job("running"), job("failed")]),
    ]));
    expect(out.total).toBe(4);
    expect(out.active).toBe(1);
  });

  it("treats both running and queued jobs as active", () => {
    const out = pipelineActivity(ci([
      wf([job("running"), job("queued"), job("success")]),
    ]));
    expect(out.active).toBe(2);
  });

  it("treats canceled, blocked, and unknown as terminal (not active)", () => {
    const out = pipelineActivity(ci([
      wf([job("canceled"), job("blocked"), job("unknown")]),
    ]));
    expect(out.total).toBe(3);
    expect(out.active).toBe(0);
  });

  it("reports active>0 even when the workflow rollup is already failed", () => {
    // The user-facing case: at least one job failed, others still running.
    const out = pipelineActivity(ci([
      wf([job("failed"), job("running"), job("queued")]),
    ]));
    expect(out.total).toBe(3);
    expect(out.active).toBe(2);
  });
});
