/**
 * Pure builders for the "expected / scheduled workflows" Projects view.
 *
 * No network here — the poller fetches raw config files + API payloads and
 * hands them to these functions, which is what makes them unit-testable.
 */

export interface CircleConfigFile {
  path: string;
  content: string;
}

export interface DefinedWorkflow {
  name: string;
  scheduled: boolean;
}

/** Parameter names that, when gating a workflow, mark it schedule-driven. */
const SCHEDULE_PARAM_RE = /schedul|weekly|nightly|daily|monthly|cron/i;

/**
 * Union of top-level workflow names across every committed CircleCI config
 * file (root config.yml plus any dynamic-config continuation files), each
 * flagged scheduled when its definition references a schedule trigger.
 *
 * Generic: no per-repo paths or parameter names are hard-coded. Files that
 * don't parse or have no `workflows:` map are skipped.
 */
export function scanCircleWorkflows(files: CircleConfigFile[]): DefinedWorkflow[] {
  const byName = new Map<string, boolean>();
  for (const f of files) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(f.content);
    } catch {
      continue;
    }
    const workflows = (doc as Record<string, unknown> | null)?.["workflows"];
    if (!workflows || typeof workflows !== "object") continue;
    for (const [name, def] of Object.entries(workflows as Record<string, unknown>)) {
      if (name === "version") continue;
      const scheduled = isScheduledWorkflow(def);
      byName.set(name, (byName.get(name) ?? false) || scheduled);
    }
  }
  return [...byName.entries()].map(([name, scheduled]) => ({ name, scheduled }));
}

function isScheduledWorkflow(def: unknown): boolean {
  if (!def || typeof def !== "object") return false;
  const d = def as Record<string, unknown>;
  // Legacy: workflows.<name>.triggers[].schedule.cron
  const triggers = d["triggers"];
  if (Array.isArray(triggers) && triggers.some((t) => t && typeof t === "object" && "schedule" in (t as object))) {
    return true;
  }
  // Modern: a `when` condition referencing pipeline.schedule or a schedule-y param.
  const when = d["when"];
  if (when === undefined) return false;
  const text = JSON.stringify(when);
  if (/pipeline\.schedule/i.test(text)) return true;
  const paramRefs = text.match(/pipeline\.parameters\.([A-Za-z0-9_-]+)/gi) ?? [];
  return paramRefs.some((r) => SCHEDULE_PARAM_RE.test(r));
}
