#!/usr/bin/env bun
import path from "node:path";
import { watch, readFileSync } from "node:fs";
import { DashboardPoller } from "./lib/dashboard-poller.ts";
import { setDebugEnabled } from "./lib/debug.ts";
import type { WsMessage } from "./types.ts";

const DEBUG =
  process.argv.includes("--debug") ||
  process.env.DASHBOARD_DEBUG === "1" ||
  process.env.DASHBOARD_DEBUG === "true";
setDebugEnabled(DEBUG);
if (DEBUG) console.log("[debug] Request/response tracing enabled (GitHub + CircleCI)");

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3456", 10);
const HOST = process.env.DASHBOARD_HOST ?? "0.0.0.0";
const PUBLIC_DIR = path.join(import.meta.dir, "..", "public");
const CLIENT_SRC_DIR = path.join(import.meta.dir, "client");

function normalizeBasePath(input: string): string {
  let s = (input ?? "").trim();
  if (!s || s === "/") return "/";
  if (!s.startsWith("/")) s = "/" + s;
  if (!s.endsWith("/")) s += "/";
  return s;
}
const BASE_HREF = normalizeBasePath(process.env.BASE_PATH ?? "");

let dashboardJs = "";

async function buildDashboardBundle(): Promise<void> {
  try {
    const result = await Bun.build({
      entrypoints: [path.join(CLIENT_SRC_DIR, "dashboard.js")],
      target: "browser",
      format: "iife",
    });
    if (!result.success || !result.outputs[0]) {
      console.error("[build] Dashboard failed:", result.logs);
      return;
    }
    dashboardJs = await result.outputs[0].text();
    console.log(`[build] Dashboard bundle built (${(dashboardJs.length / 1024).toFixed(1)}kb)`);
  } catch (err) {
    console.error("[build] Dashboard error:", err);
  }
}

await buildDashboardBundle();

type WS = Bun.ServerWebSocket<unknown>;
const clients = new Set<WS>();

function broadcast(msg: WsMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(payload); } catch { clients.delete(ws as WS); }
  }
}

const DASHBOARD_REPOS = (process.env.DASHBOARD_REPOS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// When DASHBOARD_REPOS is set, scope all feeds to just those repos by default;
// DASHBOARD_ALL_REPOS=1 restores the old behaviour (pin the repos but still
// show the viewer's PRs/issues/reviews everywhere).
const ALL_REPOS = process.env.DASHBOARD_ALL_REPOS === "1" || process.env.DASHBOARD_ALL_REPOS === "true";
const scopeRepos = !ALL_REPOS ? DASHBOARD_REPOS : [];
if (DASHBOARD_REPOS.length > 0) {
  console.log(
    scopeRepos.length > 0
      ? `[dashboard] scoping to repos: ${scopeRepos.join(", ")}`
      : `[dashboard] pinning repos (DASHBOARD_ALL_REPOS set): ${DASHBOARD_REPOS.join(", ")}`,
  );
}

const dashboardPoller = new DashboardPoller({
  onSnapshot: (snap) => broadcast({ type: "dashboard-snapshot", data: snap }),
  logger: (msg) => console.log(`[dashboard] ${msg}`),
  pinnedRepos: DASHBOARD_REPOS,
  scopeRepos,
});
void dashboardPoller.start().catch((err) => console.error("[dashboard] start failed:", err));

function serveHtml(filename: string): Response {
  const html = readFileSync(path.join(PUBLIC_DIR, filename), "utf-8");
  const out = html.replace('<base href="/">', `<base href="${BASE_HREF}">`);
  return new Response(out, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (pathname === "/" || pathname === "/index.html") return serveHtml("index.html");
    if (pathname === "/dashboard.css") return new Response(Bun.file(path.join(PUBLIC_DIR, "dashboard.css")));
    if (pathname === "/kermit.png") return new Response(Bun.file(path.join(PUBLIC_DIR, "kermit.png")));
    if (pathname === "/dashboard.js") {
      return new Response(dashboardJs, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
    }
    if (req.method === "GET" && pathname === "/api/dashboard") {
      return new Response(JSON.stringify(dashboardPoller.getSnapshot()), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws as WS);
      const snap = dashboardPoller.getSnapshot();
      if (snap.prs.length > 0 || snap.user) {
        ws.send(JSON.stringify({ type: "dashboard-snapshot", data: snap }));
      }
    },
    close(ws) { clients.delete(ws as WS); },
    message(ws, message) {
      try {
        const parsed = JSON.parse(String(message)) as { type?: string };
        if (parsed.type === "ping") ws.send(JSON.stringify({ type: "pong" } satisfies WsMessage));
      } catch { /* ignore */ }
    },
  },
});

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBundleRebuild = false;
function scheduleReload(needsBundle: boolean) {
  if (needsBundle) pendingBundleRebuild = true;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    rebuildTimer = null;
    if (pendingBundleRebuild) {
      pendingBundleRebuild = false;
      await buildDashboardBundle();
    }
    broadcast({ type: "reload" });
  }, 1_000);
}

watch(CLIENT_SRC_DIR, { recursive: true }, (_event, filename) => {
  if (filename && filename.endsWith(".js")) scheduleReload(true);
});
watch(PUBLIC_DIR, { recursive: true }, (_event, filename) => {
  if (filename && (filename.endsWith(".css") || filename.endsWith(".html"))) scheduleReload(false);
});

// macOS-host → Linux-container bind-mount polling fallback (matches todo's behavior).
{
  const mtimes = new Map<string, number>();
  const seed = async (dir: string, exts: string[]) => {
    const glob = new Bun.Glob("**/*");
    for await (const rel of glob.scan({ cwd: dir })) {
      if (!exts.some((e) => rel.endsWith(e))) continue;
      const stat = await Bun.file(path.join(dir, rel)).stat().catch(() => null);
      if (stat) mtimes.set(path.join(dir, rel), stat.mtimeMs);
    }
  };
  await Promise.all([seed(CLIENT_SRC_DIR, [".js"]), seed(PUBLIC_DIR, [".css", ".html"])]);

  setInterval(async () => {
    const check = async (dir: string, exts: string[], needsBundle: boolean) => {
      const glob = new Bun.Glob("**/*");
      let changed = false;
      for await (const rel of glob.scan({ cwd: dir })) {
        if (!exts.some((e) => rel.endsWith(e))) continue;
        const full = path.join(dir, rel);
        const stat = await Bun.file(full).stat().catch(() => null);
        if (!stat) continue;
        const prev = mtimes.get(full);
        if (prev !== stat.mtimeMs) {
          mtimes.set(full, stat.mtimeMs);
          if (prev !== undefined) changed = true;
        }
      }
      if (changed) scheduleReload(needsBundle);
    };
    try {
      await check(CLIENT_SRC_DIR, [".js"], true);
      await check(PUBLIC_DIR, [".css", ".html"], false);
    } catch { /* ignore */ }
  }, 1000);
}

console.log(`Dashboard server listening on http://${HOST}:${PORT}`);
