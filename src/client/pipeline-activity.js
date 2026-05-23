/**
 * Count total and still-active (running or queued) jobs across every
 * workflow in a CI pipeline.
 *
 * Lets the UI distinguish "fully done" from "failed but more checks still
 * pending". When the rollup has already flipped to "failed" because one
 * job blew up, callers can keep the progress bar visible while remaining
 * jobs continue, instead of jumping straight to a static red footer.
 */
export function pipelineActivity(ci) {
  let total = 0;
  let active = 0;
  for (const wf of ci?.workflows ?? []) {
    for (const job of wf.jobs ?? []) {
      total++;
      if (job.status === "running" || job.status === "queued") active++;
    }
  }
  return { total, active };
}
