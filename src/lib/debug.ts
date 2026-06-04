/**
 * Opt-in request/response tracing for the GitHub + CircleCI clients. Enabled
 * with `DASHBOARD_DEBUG=1` (or `--debug`); off by default so normal runs stay
 * quiet. Use to diagnose "0 PRs / blank board" cases where GitHub answers
 * HTTP 200 but with a partial GraphQL `errors` payload the clients otherwise
 * swallow.
 */

let enabled = false;

export function setDebugEnabled(on: boolean): void {
  enabled = on;
}

export function debugEnabled(): boolean {
  return enabled;
}

export function debugLog(scope: string, msg: string): void {
  if (!enabled) return;
  console.log(`[debug:${scope}] ${msg}`);
}

const MAX_BODY = 8000;

/** Trim oversized response bodies (busy-repo statusCheckRollup payloads run huge). */
export function truncateBody(body: string): string {
  if (body.length <= MAX_BODY) return body;
  return `${body.slice(0, MAX_BODY)}… (${body.length} bytes total, truncated)`;
}

/** Collapse a multi-line GraphQL query to a single short line for log context. */
export function summarizeQuery(query: string): string {
  const collapsed = query.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
}
