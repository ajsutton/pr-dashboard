import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import type { Subprocess } from "bun";

const SERVER_PATH = join(import.meta.dir, "server.ts");

async function waitForReady(port: number, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok || r.status === 404) return;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`server on ${port} never came up`);
}

describe("dashboard server", () => {
  let proc: Subprocess | null = null;
  const port = 3490 + Math.floor(Math.random() * 100);

  beforeEach(async () => {
    proc = Bun.spawn(["bun", SERVER_PATH], {
      env: { ...process.env, DASHBOARD_PORT: String(port), GH_TOKEN: "", DASHBOARD_REPOS: "", DASHBOARD_MODE: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForReady(port);
  });

  afterEach(() => { proc?.kill(); });

  it("serves dashboard HTML at /", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("<title>CI Dashboard</title>");
  });

  it("reports user mode by default", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    expect((await r.json()).mode).toBe("user");
  });

  it("returns 200 for /api/dashboard", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    expect(r.status).toBe(200);
    const snap = await r.json();
    expect(snap).toHaveProperty("prs");
  });

  it("exposes GitHub budget diagnostics without credentials", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/github-usage`);
    expect(r.status).toBe(200);
    const usage = await r.json();
    expect(usage).toHaveProperty("budgets.core");
    expect(usage).toHaveProperty("budgets.graphql");
    expect(usage).toHaveProperty("operations");
  });

  it("serves the kermit image as a PNG", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/kermit.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await r.arrayBuffer());
    // PNG magic number.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("respects BASE_PATH in the base href", async () => {
    proc?.kill();
    proc = Bun.spawn(["bun", SERVER_PATH], {
      env: { ...process.env, DASHBOARD_PORT: String(port + 1), GH_TOKEN: "", BASE_PATH: "/dashboard", DASHBOARD_MODE: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForReady(port + 1);
    const r = await fetch(`http://127.0.0.1:${port + 1}/`);
    const html = await r.text();
    expect(html).toContain('<base href="/dashboard/">');
  });

  it("reports generic mode when DASHBOARD_MODE=generic", async () => {
    proc?.kill();
    proc = Bun.spawn(["bun", SERVER_PATH], {
      env: { ...process.env, DASHBOARD_PORT: String(port + 2), GH_TOKEN: "", DASHBOARD_MODE: "generic", DASHBOARD_REPOS: "o/r" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForReady(port + 2);
    const r = await fetch(`http://127.0.0.1:${port + 2}/api/dashboard`);
    expect((await r.json()).mode).toBe("generic");
  });
});

describe("dashboard server config", () => {
  async function exitWith(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn(["bun", SERVER_PATH], {
      env: { ...process.env, DASHBOARD_PORT: "0", GH_TOKEN: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return { code, stderr: await new Response(proc.stderr).text() };
  }

  it("refuses generic mode without DASHBOARD_REPOS", async () => {
    const { code, stderr } = await exitWith({ DASHBOARD_MODE: "generic", DASHBOARD_REPOS: "" });
    expect(code).not.toBe(0);
    expect(stderr).toContain("DASHBOARD_REPOS");
  });

  it("refuses an unknown DASHBOARD_MODE", async () => {
    const { code, stderr } = await exitWith({ DASHBOARD_MODE: "team" });
    expect(code).not.toBe(0);
    expect(stderr).toContain("DASHBOARD_MODE");
  });
});
