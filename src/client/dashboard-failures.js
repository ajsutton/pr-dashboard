/**
 * Render the "Failing jobs" block on a CI card.
 *
 * Counts failures across *all* jobs on the card, not per-job: a single
 * card can have many failing jobs (busy merge-queue branch runs, for
 * example) and a per-job cap leaves the card growing unbounded. Once
 * the global total exceeds LIMIT, drop the breakdown entirely and show
 * just a single count line so the card height stays glanceable.
 *
 * A failed job with no failed-test detail counts as 1 (the job itself
 * failed, even if we don't know which test triggered it).
 */

const LIMIT = 4;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortenTestName(name) {
  if (!name) return "";
  const idx = name.indexOf("::");
  return idx >= 0 ? name.slice(idx + 2) : name;
}

function failureCount(failed) {
  return failed.reduce((n, { job }) => {
    const tests = job.failedTests?.length ?? 0;
    return n + (tests || 1);
  }, 0);
}

function renderJob({ job }) {
  const tests = job.failedTests ?? [];
  const url = job.url
    ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.name)}</a>`
    : escapeHtml(job.name);
  const testsHtml = tests.length
    ? `<ul class="db-failures-tests">${tests.map((t) => `<li>${escapeHtml(shortenTestName(t))}</li>`).join("")}</ul>`
    : "";
  return `<div class="db-failures-job">${url}${testsHtml}</div>`;
}

export function renderFailuresBlock(failed) {
  if (!failed || failed.length === 0) return "";
  const total = failureCount(failed);
  if (total > LIMIT) {
    const noun = total === 1 ? "failure" : "failures";
    return `<div class="db-failures"><div class="db-failures-count">${total} ${noun}</div></div>`;
  }
  const jobs = failed.map(renderJob).join("");
  return `<div class="db-failures"><div class="db-failures-title">Failing jobs</div>${jobs}</div>`;
}
