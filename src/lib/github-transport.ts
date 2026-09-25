/** One serialized queue and shared rate budgets for every GitHub consumer. */
import { debugLog } from "./debug.ts";

type Resource = "core" | "graphql";
type Budget = { remaining?: number; limit?: number; resetAt?: number; pausedUntil: number };
type Counter = { requests: number; notModified: number; errors: number; points: number };
const budgets: Record<Resource, Budget> = { core: { pausedUntil: 0 }, graphql: { pausedUntil: 0 } };
const counters = new Map<string, Counter>();
const cache = new Map<string, { value: unknown; etag?: string; missingUntil?: number }>();
let queue = Promise.resolve();
let secondaryUntil = 0;
let secondaryFailures = 0;
let tokenIdentity: string | undefined;
const CACHE_LIMIT = 2000;

function numberSetting(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class GitHubPausedError extends Error {}

export function githubUsage() {
  return {
    budgets: structuredClone(budgets), secondaryUntil,
    operations: Object.fromEntries([...counters].map(([key, value]) => [key, { ...value }])),
  };
}

/** Clear process-local state; also used when authentication changes. */
export function resetGitHubTransport(): void {
  cache.clear(); counters.clear();
  budgets.core = { pausedUntil: 0 }; budgets.graphql = { pausedUntil: 0 };
  secondaryUntil = 0; secondaryFailures = 0;
  tokenIdentity = process.env.GH_TOKEN;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** No sleeping: callers preserve cached snapshots while the queue is paused. */
export function rateLimitDelayMs(res: { status: number; headers: Headers }, now: number): number | null {
  const remaining = headerNumber(res.headers, "x-ratelimit-remaining");
  const retry = res.headers.get("retry-after");
  if (res.status !== 429 && remaining !== 0 && !(res.status === 403 && retry !== null)) return null;
  const reset = headerNumber(res.headers, "x-ratelimit-reset");
  const retryMs = retry === null ? undefined : (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now);
  if (remaining === 0 && reset !== undefined) return Math.max(0, reset * 1000 - now, retryMs || 0);
  return retryMs !== undefined && Number.isFinite(retryMs) ? Math.max(0, retryMs) : 60_000;
}

function operationName(path: string): string {
  if (path.includes("/git/trees/")) return "rest.tree";
  if (path.includes("/contents/")) return "rest.file";
  if (/\/actions\/runs\/\d+/.test(path)) return "rest.run";
  if (path.includes("/actions/workflows/") && path.includes("/runs")) return "rest.workflow-runs";
  if (path.includes("/actions/workflows")) return "rest.workflows";
  if (path.includes("/actions/runs")) return "rest.runs";
  return "rest.other";
}

function remember(key: string, entry: { value: unknown; etag?: string; missingUntil?: number }) {
  cache.delete(key); cache.set(key, entry);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

async function request(resource: Resource, path: string, body: string | undefined, operation: string): Promise<unknown> {
  // Queue covers reading/parsing the response too: HTTP-200 GraphQL errors
  // must pause later requests before they are dispatched.
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (tokenIdentity !== process.env.GH_TOKEN) resetGitHubTransport();
    const cached = body === undefined ? cache.get(path) : undefined;
    const now = Date.now();
    if (cached?.missingUntil && cached.missingUntil > now) return undefined;
    const budget = budgets[resource];
    if (Math.max(secondaryUntil, budget.pausedUntil) > now) {
      throw new GitHubPausedError(`GitHub ${resource} paused until ${new Date(Math.max(secondaryUntil, budget.pausedUntil)).toISOString()}`);
    }
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json", "User-Agent": "pr-dashboard", "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const count = counters.get(operation) ?? { requests: 0, notModified: 0, errors: 0, points: 0 };
    counters.set(operation, count); count.requests++;
    let res: Response;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        headers, ...(body === undefined ? {} : { method: "POST", body }), signal: AbortSignal.timeout(30_000),
      });
    } catch (err) { count.errors++; throw err; }
    const remaining = headerNumber(res.headers, "x-ratelimit-remaining");
    const reset = headerNumber(res.headers, "x-ratelimit-reset");
    const limit = headerNumber(res.headers, "x-ratelimit-limit");
    if (remaining !== undefined) budget.remaining = remaining;
    if (reset !== undefined) budget.resetAt = reset * 1000;
    if (limit !== undefined) budget.limit = limit;
    // The reserve belongs to the user, not this application. Apply even to a
    // successful response; serve this response, then stop further requests.
    const reserve = numberSetting("DASHBOARD_GITHUB_RESERVE", 1000);
    if (remaining !== undefined && remaining <= reserve) budget.pausedUntil = reset ? reset * 1000 : now + 60_000;
    if (res.status === 304 && cached) {
      count.notModified++;
      return cached.value;
    }
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    const errors = Array.isArray(data?.errors) ? data.errors : [];
    const message = String(data?.message ?? "") + " " + errors.map((e: any) => `${e.type ?? ""} ${e.message ?? ""}`).join(" ");
    const limited = res.status === 429 || (remaining === 0 && (!res.ok || errors.length > 0)) || (res.status === 403 && res.headers.has("retry-after")) || /rate.limit|RATE_LIMITED|abuse detection|secondary limit/i.test(message);
    if (limited) {
      count.errors++;
      const delay = rateLimitDelayMs(res, now) ?? 60_000;
      if (remaining === 0) budget.pausedUntil = Math.max(budget.pausedUntil, now + Math.max(1000, delay));
      else {
        secondaryUntil = now + Math.max(delay, Math.min(3_600_000, 60_000 * 2 ** secondaryFailures++));
      }
      console.warn(`[github] ${operation}: rate limited; ${resource} remaining=${remaining ?? "unknown"}`);
      throw new GitHubPausedError(`GitHub ${resource} rate limited`);
    }
    secondaryFailures = 0;
    debugLog("github", `${operation}: HTTP ${res.status}, remaining=${remaining ?? "unknown"}`);
    if (res.status === 404 && resource === "core") {
      remember(path, { value: undefined, missingUntil: now + 30 * 60_000 });
      return undefined;
    }
    if (!res.ok) { count.errors++; throw new Error(`GitHub ${operation}: HTTP ${res.status}`); }
    if (resource === "graphql") {
      const cost = data?.data?.rateLimit?.cost;
      if (typeof cost === "number") count.points += cost;
      if (errors.length) { count.errors++; debugLog("github", JSON.stringify(errors)); }
      // Partial GraphQL data must not replace a good cached snapshot. Let
      // callers fall back to smaller queries for query-complexity failures.
      if (errors.length || !data?.data) return undefined;
      return data.data;
    }
    if (data === undefined) { count.errors++; throw new Error(`GitHub ${operation}: invalid JSON`); }
    count.points++;
    const etag = res.headers.get("etag");
    if (etag) remember(path, { value: data, etag });
    return data;
  } finally { release(); }
}

export function ghRest(path: string): Promise<unknown> {
  return request("core", path, undefined, operationName(path));
}

export async function ghGraphql(query: string, vars: Record<string, unknown> = {}, operation = "graphql.other"): Promise<Record<string, unknown> | undefined> {
  // All application queries have an explicit query definition (no mutations).
  const measured = query.replace("{", "{ rateLimit { cost } ");
  return await request("graphql", "/graphql", JSON.stringify({ query: measured, variables: vars }), operation) as Record<string, unknown> | undefined;
}
