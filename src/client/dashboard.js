/**
 * PR Dashboard client. Talks to the same WebSocket as the main app
 * and renders the latest dashboard-snapshot messages.
 */

import { sortStacks } from "./dashboard-sort.js";
import {
  diffPrLifecycles,
  prLifecycleState,
  prVtName,
  queueLifecycleState,
  diffQueueEjections,
} from "./dashboard-lifecycle.js";
import { renderFailuresBlock } from "./dashboard-failures.js";
import { jobSortRank } from "./jobsort.js";
import {
  getTestCycle,
  injectTestPr,
  emptyTestSnapshot,
} from "./testmode.js";
import { pipelineActivity } from "./pipeline-activity.js";

const conn = document.getElementById("db-conn");
const userEl = document.getElementById("db-user");
const updatedEl = document.getElementById("db-updated");
const queuesSection = document.getElementById("db-queues-section");
const queuesEl = document.getElementById("db-queues");
const jobsEl = document.getElementById("db-jobs");
const stacksEl = document.getElementById("db-stacks");

let latest = null;
let updatedTicker = null;
let prevPrState = new Map();
let prevQueueState = new Map();
let prevMergedByRepo = new Map();
let activeLifecycles = { entering: new Set(), exiting: new Set(), ejecting: new Set() };

const TEST_CYCLE = getTestCycle();
const TEST_MODE = TEST_CYCLE !== null;
const TEST_CYCLE_MS = 5000;
let testCycleIdx = 0;

function effectiveSnapshot() {
  if (TEST_MODE) return injectTestPr(latest ?? emptyTestSnapshot(), TEST_CYCLE[testCycleIdx]);
  return latest;
}

// Repos whose queue rows just emptied via a merge — kept rendered as
// ship-only stubs long enough for the slurp + ship-sail animations to play.
// Without this the entire queue section vanishes the same frame the slurp
// starts and you see neither the slurp landing nor the ship sailing.
const lingerQueueRepos = new Set();
const lingerQueueTimers = new Map();
const QUEUE_LINGER_MS = 2200;

function holdQueueRowOpen(repo) {
  const existing = lingerQueueTimers.get(repo);
  if (existing) clearTimeout(existing);
  lingerQueueRepos.add(repo);
  const t = setTimeout(() => {
    lingerQueueRepos.delete(repo);
    lingerQueueTimers.delete(repo);
    // Re-render only the queue strip — avoid going through the full
    // lifecycle-diffing render(), which could re-trigger animations if
    // anything else has happened in the meantime.
    const snap = effectiveSnapshot();
    if (snap) renderQueues(snap, lingerQueueRepos);
  }, QUEUE_LINGER_MS);
  lingerQueueTimers.set(repo, t);
}

function setConn(state) {
  conn.dataset.state = state;
  conn.textContent = state === "open" ? "live" : state === "closed" ? "offline" : "connecting…";
}

function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function ciTone(status) {
  switch (status) {
    case "success": return "ok";
    case "failed": return "err";
    case "running": return "run";
    case "queued": return "warn";
    case "blocked": return "blocked";
    default: return "muted";
  }
}

function renderCi(ci) {
  if (!ci) return `<footer class="db-ci" data-tone="muted" data-status="none"><span class="db-ci-label">no CI</span></footer>`;
  const tone = ciTone(ci.rolledUp);
  const { total, active } = pipelineActivity(ci);
  // Keep the progress bar visible even after the rollup flips to "failed"
  // as long as there are checks still pending — the user wants to see
  // both the red card and how much is left to come back.
  const isRunning = ci.rolledUp === "running" || ci.rolledUp === "queued" || active > 0;
  // Server returns progressPct=100 for any terminal rollup, including
  // "failed". When the rollup is failed-but-active, derive the actual
  // percentage from job counts so the bar shows real progress.
  const pct = ci.rolledUp === "failed" && active > 0 && total > 0
    ? Math.round(((total - active) / total) * 100)
    : Math.max(0, Math.min(100, Math.round(ci.progressPct ?? 0)));
  const elapsed = fmtAge(ci.elapsedMs);
  const est = isRunning && ci.estimatedTotalMs ? ` / ${fmtAge(ci.estimatedTotalMs)}` : "";

  const failed = [];
  for (const wf of ci.workflows ?? []) {
    for (const job of wf.jobs ?? []) {
      if (job.status === "failed") {
        failed.push({ workflow: wf.name, job });
      }
    }
  }

  const failBox = renderFailuresBlock(failed);

  const label = ci.rolledUp.toUpperCase();
  const timeText = isRunning ? `${pct}% · ${elapsed}${est}` : elapsed;
  const bar = isRunning
    ? `<div class="db-bar"><div class="db-bar-fill" data-tone="${tone}" style="width:${pct}%"></div></div>`
    : "";
  return `
    <footer class="db-ci" data-tone="${tone}" data-status="${escapeAttr(ci.rolledUp)}">
      <div class="db-ci-line">
        <span class="db-ci-label">${escapeHtml(label)}</span>
        <span class="db-ci-time">${escapeHtml(timeText)}</span>
      </div>
      ${bar}
      ${failBox}
    </footer>
  `;
}

function reviewBadge(pr) {
  if (pr.isDraft) return { label: "Draft", tone: "draft" };
  if (pr.isInMergeQueue) return { label: "In merge queue", tone: "blocked" };
  switch (pr.reviewDecision) {
    case "APPROVED": return { label: "Approved", tone: "ok" };
    case "CHANGES_REQUESTED": return { label: "Changes requested", tone: "err" };
    case "REVIEW_REQUIRED": return { label: "Awaiting review", tone: "warn" };
    default: return { label: pr.state || "Open", tone: "run" };
  }
}

function renderPrBadges(pr) {
  const b = reviewBadge(pr);
  const badges = [`<span class="db-badge" data-tone="${b.tone}">${b.label}</span>`];
  if (pr.mergeable === "CONFLICTING") {
    badges.push(`<span class="db-badge" data-tone="err">Conflicts</span>`);
  }
  return badges.join("");
}

function reviewTone(pr) {
  if (pr.isInMergeQueue) return "queue";
  if (pr.isDraft) return "draft";
  switch (pr.reviewDecision) {
    case "APPROVED": return "ok";
    case "CHANGES_REQUESTED": return "err";
    case "REVIEW_REQUIRED": return "warn";
    // No review required → treat as approved.
    default: return "ok";
  }
}

function reviewLabel(pr) {
  if (pr.isInMergeQueue) return "In queue";
  if (pr.isDraft) return "Draft";
  switch (pr.reviewDecision) {
    case "APPROVED": return "Approved";
    case "CHANGES_REQUESTED": return "Changes requested";
    case "REVIEW_REQUIRED": return "Awaiting review";
    default: return "No review required";
  }
}

function lifecycleClass(key) {
  if (activeLifecycles.entering.has(key)) return " pr-entering";
  if (activeLifecycles.ejecting.has(key)) return " pr-ejecting";
  return "";
}

// Left-pointing arrow: the parent always renders just before this card in
// the flattened grid, so the glyph points back at it.
const STACK_ARROW_SVG = `<svg class="db-stack-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M15 8 H1 M1 8 L6 3 M1 8 L6 13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function renderPr(pr, opts = {}) {
  const ciStatus = pr.ci?.rolledUp ?? "none";
  const ciT = ciTone(ciStatus);
  const conflicts = pr.mergeable === "CONFLICTING";
  const vt = prVtName(pr.repo, pr.number);
  const lc = lifecycleClass(pr.key);
  // Children of a visible-stack parent show "Stacked on #N" instead of their
  // review label — the structural relationship is more useful here, and you
  // can't land the child until the parent merges anyway.
  const stackedOn = opts.stackParentNumber ?? null;
  const review = stackedOn != null ? "stacked" : reviewTone(pr);
  const footLabel = stackedOn != null
    ? `${STACK_ARROW_SVG}<span>Stacked on #${stackedOn}${conflicts ? " · Conflicts" : ""}</span>`
    : `<span>${reviewLabel(pr)}${conflicts ? " · CONFLICTS" : ""}</span>`;
  const bridgeHtml = stackedOn != null
    ? `<div class="db-pr-bridge" aria-hidden="true">${STACK_ARROW_SVG}</div>`
    : "";
  return `
    <article class="db-pr${lc}" data-pr-key="${escapeAttr(pr.key)}" data-review="${review}" data-ci="${ciT}" data-status="${escapeAttr(ciStatus)}" style="view-transition-name: ${vt}">
      ${bridgeHtml}
      <header class="db-pr-head">
        <span class="db-pr-num">#${pr.number}</span>
      </header>
      <a class="db-pr-title" href="${escapeAttr(pr.url)}" target="_blank" rel="noopener">${escapeHtml(pr.title)}</a>
      ${renderCi(pr.ci)}
      <footer class="db-pr-foot" data-review="${review}">
        <span class="db-pr-foot-label">${footLabel}</span>
      </footer>
    </article>
  `;
}

function renderStacks(snap) {
  if (!snap.prs.length) {
    stacksEl.innerHTML = `<div class="db-empty">No open PRs.</div>`;
    return;
  }
  const byKey = new Map(snap.prs.map((p) => [p.key, p]));
  // PRs in the merge queue render as queue cards, not stack cards. Sharing
  // a view-transition-name across both would error; this also makes the
  // move-to-queue feel like the PR has left the stack.
  const visibleStacks = snap.stacks
    .map((stack) => ({
      ...stack,
      prKeys: stack.prKeys.filter((k) => {
        const pr = byKey.get(k);
        return pr && !pr.isInMergeQueue;
      }),
    }))
    .filter((s) => s.prKeys.length > 0);

  if (!visibleStacks.length) {
    stacksEl.innerHTML = `<div class="db-empty">All open PRs are queued for merge.</div>`;
    return;
  }

  // Flatten sorted stacks into a single grid of PR cards. Stack ordering is
  // preserved so descendants render right after their root in the grid; the
  // "Stacked on #N" footer on non-root cards is the visual chain.
  const visibleKeys = new Set(visibleStacks.flatMap((s) => s.prKeys));
  const html = sortStacks(visibleStacks, byKey)
    .flatMap((stack) => stack.prKeys.map((k) => byKey.get(k)).filter(Boolean))
    .map((pr) => {
      const parentKey = pr.parentPr
        ? `${pr.parentPr.repo}#${pr.parentPr.number}`
        : null;
      const stackParentNumber = parentKey && visibleKeys.has(parentKey)
        ? pr.parentPr.number
        : null;
      return renderPr(pr, { stackParentNumber });
    })
    .join("");
  stacksEl.innerHTML = html;
}

function renderQueueCard(repo, e) {
  const ciStatus = e.ci?.rolledUp ?? "none";
  const tone = ciTone(ciStatus);
  const { total, active } = pipelineActivity(e.ci);
  const isRunning = ciStatus === "running" || ciStatus === "queued" || active > 0;
  const pct = ciStatus === "failed" && active > 0 && total > 0
    ? Math.round(((total - active) / total) * 100)
    : Math.max(0, Math.min(100, Math.round(e.ci?.progressPct ?? 0)));
  const elapsed = e.ci ? fmtAge(e.ci.elapsedMs) : "";
  const est = isRunning && e.ci?.estimatedTotalMs ? ` / ${fmtAge(e.ci.estimatedTotalMs)}` : "";
  const timeText = e.ci
    ? (isRunning ? `${pct}% · ${elapsed}${est}` : elapsed)
    : "";
  const bar = isRunning
    ? `<div class="db-bar"><div class="db-bar-fill" data-tone="${tone}" style="width:${pct}%"></div></div>`
    : "";
  const key = `${repo}#${e.prNumber}`;
  const vt = prVtName(repo, e.prNumber);
  const lc = lifecycleClass(key);
  return `
    <div class="db-queue-card${lc}" data-pr-key="${escapeAttr(key)}" data-tone="${tone}" data-status="${escapeAttr(ciStatus)}" data-mine="${e.mine}" style="view-transition-name: ${vt}">
      <div class="db-queue-pos">#${e.position} · ${escapeHtml(ciStatus.toUpperCase())}</div>
      <div class="db-queue-pr"><a href="${escapeAttr(e.prUrl)}" target="_blank" rel="noopener">#${e.prNumber}</a></div>
      ${bar}
      ${timeText ? `<div class="db-queue-time">${escapeHtml(timeText)}</div>` : ""}
      <div class="db-queue-owner" data-mine="${e.mine}">${e.mine ? "YOU" : escapeHtml(e.author)}</div>
    </div>
  `;
}

const SHIP_SVG = `<svg class="db-ship-svg" viewBox="0 0 64 32" aria-hidden="true">
  <circle cx="40" cy="2" r="1.3" fill="rgba(255,255,255,0.3)"/>
  <circle cx="34" cy="3" r="1.6" fill="rgba(255,255,255,0.35)"/>
  <circle cx="38" cy="5" r="2" fill="rgba(255,255,255,0.45)"/>
  <rect x="37" y="7" width="4" height="8" fill="#b3331f"/>
  <rect x="37" y="8.2" width="4" height="1.4" fill="#3a2a14"/>
  <rect x="24" y="13" width="22" height="9" fill="#dfe5ec"/>
  <circle cx="28" cy="17.5" r="1.1" fill="#2a3845"/>
  <circle cx="33" cy="17.5" r="1.1" fill="#2a3845"/>
  <circle cx="38" cy="17.5" r="1.1" fill="#2a3845"/>
  <circle cx="43" cy="17.5" r="1.1" fill="#2a3845"/>
  <path d="M6 22 L58 22 L54 28 L10 28 Z" fill="#3a2a14"/>
  <rect x="9" y="23.5" width="46" height="0.8" fill="#a07740"/>
  <path d="M4 27 q4 -2 8 0 t8 0 t8 0 t8 0 t8 0 t8 0 t8 0" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

function repoSlug(repo) {
  return repo.replace(/[^a-zA-Z0-9-]/g, "_");
}

function shipVtName(repo) {
  return `db-ship-${repoSlug(repo)}`;
}

function shipCardHtml(repo, branch) {
  const slash = repo.indexOf("/");
  const owner = slash >= 0 ? repo.slice(0, slash) : "";
  const name = slash >= 0 ? repo.slice(slash + 1) : repo;
  const ownerHtml = owner ? `<span class="db-branch-owner">${escapeHtml(owner)}</span>` : "";
  return `
    <article class="db-ship-card" data-repo="${escapeAttr(repo)}" style="view-transition-name: ${shipVtName(repo)}">
      <header class="db-branch-head">
        <div class="db-branch-id">
          ${ownerHtml}
          <span class="db-branch-repo">${escapeHtml(name)}</span>
        </div>
        <span class="db-branch-name">${escapeHtml(branch || "")}</span>
      </header>
      <div class="db-ship-anchor" data-repo="${escapeAttr(repo)}">
        <div class="db-ship-wrap" data-repo="${escapeAttr(repo)}">${SHIP_SVG}</div>
      </div>
    </article>
  `;
}

/**
 * Top-of-page merge queue rows — one per repo with active queue entries
 * (plus any repo currently in `lingerRepos`, which renders a ship-only
 * stub so the merge animation has somewhere to land). Section visibility
 * flips based on whether anything is being rendered; the section itself
 * carries the slide-in-from-top animation.
 */
function renderQueues(snap, lingerRepos = new Set()) {
  const branchByRepo = new Map((snap.defaultBranchByRepo ?? []).map((d) => [d.repo, d.branch]));
  const liveQueues = (snap.mergeQueues ?? []).filter((q) => q.entries && q.entries.length > 0);
  const liveRepos = new Set(liveQueues.map((q) => q.repo));
  const queues = [
    ...liveQueues,
    ...[...lingerRepos]
      .filter((r) => !liveRepos.has(r))
      .map((r) => ({ repo: r, entries: [] })),
  ];
  if (queues.length === 0) {
    queuesEl.innerHTML = "";
    queuesSection.hidden = true;
    return;
  }
  queuesSection.hidden = false;

  // Honour the server-provided repo order when possible.
  const order = new Map((snap.repos ?? []).map((r, i) => [r, i]));
  const sorted = [...queues].sort((a, b) => (order.get(a.repo) ?? 1e6) - (order.get(b.repo) ?? 1e6));

  queuesEl.innerHTML = sorted
    .map((q) => {
      const entries = [...q.entries].sort((a, b) => a.position - b.position);
      const branch = branchByRepo.get(q.repo) ?? "";
      const ship = shipCardHtml(q.repo, branch);
      const cards = entries.map((e) => renderQueueCard(q.repo, e)).join("");
      const vt = `db-queue-row-${repoSlug(q.repo)}`;
      return `
        <article class="db-queue-row" data-repo="${escapeAttr(q.repo)}" style="view-transition-name: ${vt}">
          <div class="db-queue-row-ship">${ship}</div>
          <div class="db-repo-arrow" aria-hidden="true">◀</div>
          <div class="db-repo-queue"><div class="db-repo-queue-cards">${cards}</div></div>
        </article>
      `;
    })
    .join("");
}

function jobTone(status) {
  switch (status) {
    case "success": return "ok";
    case "failed":
    case "blocked": return "err";
    case "running": return "run";
    case "queued": return "warn";
    case "canceled": return "muted";
    default: return "muted";
  }
}

function renderJobCard(job) {
  const latest = job.latest;
  const completed = job.lastCompleted;
  const headTone = jobTone(latest.status);
  const footTone = completed ? jobTone(completed.status) : "muted";
  const isRunning = latest.status === "running" || latest.status === "queued";
  const pct = Math.max(0, Math.min(100, Math.round(latest.progressPct ?? 0)));
  const latestElapsed = fmtAge(latest.elapsedMs);
  const latestEst = isRunning && latest.estimatedDurationMs ? ` / ${fmtAge(latest.estimatedDurationMs)}` : "";
  const headTime = isRunning ? `${pct}% · ${latestElapsed}${latestEst}` : latestElapsed;
  const bar = isRunning
    ? `<div class="db-bar"><div class="db-bar-fill" data-tone="${headTone}" style="width:${pct}%"></div></div>`
    : "";
  const completedAgo = completed?.stoppedAt
    ? fmtAge(Date.now() - Date.parse(completed.stoppedAt))
    : "";
  const completedLabel = completed
    ? completed.status.toUpperCase()
    : "NO RECENT RESULT";
  const completedHref = completed?.url || latest.url;
  const headHref = latest.url;
  const vt = `db-job-${job.key.replace(/[^a-zA-Z0-9-]/g, "_")}`;
  const slash = job.repo.indexOf("/");
  const repoOwner = slash >= 0 ? job.repo.slice(0, slash) : "";
  const repoName = slash >= 0 ? job.repo.slice(slash + 1) : job.repo;
  const branch = job.branch || "";
  return `
    <article class="db-job" data-head-tone="${headTone}" data-foot-tone="${footTone}" data-job-key="${escapeAttr(job.key)}" style="view-transition-name: ${vt}">
      <a class="db-job-head" href="${escapeAttr(headHref)}" target="_blank" rel="noopener">
        <div class="db-job-project">
          ${repoOwner ? `<span class="db-job-project-owner">${escapeHtml(repoOwner)}/</span>` : ""}<span class="db-job-project-repo">${escapeHtml(repoName)}</span>
          ${branch ? `<span class="db-job-project-branch">${escapeHtml(branch)}</span>` : ""}
        </div>
        <header class="db-job-meta">
          <span class="db-job-name">${escapeHtml(job.name || "(unnamed workflow)")}</span>
          <span class="db-job-status">${escapeHtml(latest.status.toUpperCase())}</span>
        </header>
        <div class="db-job-time">${escapeHtml(headTime)}</div>
        ${bar}
      </a>
      <a class="db-job-foot" data-tone="${footTone}" href="${escapeAttr(completedHref)}" target="_blank" rel="noopener">
        <span class="db-job-foot-label">${escapeHtml(completedLabel)}</span>
        ${completedAgo ? `<span class="db-job-foot-age">${escapeHtml(completedAgo)} ago</span>` : ""}
      </a>
    </article>
  `;
}

function renderJobs(snap) {
  const jobs = snap.defaultBranchJobs ?? [];
  if (jobs.length === 0) {
    jobsEl.innerHTML = `<div class="db-empty">No recent builds on tracked default branches.</div>`;
    return;
  }
  // Flat grid across all repos. Sort by interest (failures first via
  // jobSortRank), then by repo order from the server, then by workflow name
  // for stability within the same rank/repo.
  const repoOrder = new Map((snap.repos ?? []).map((r, i) => [r, i]));
  const sorted = [...jobs].sort((a, b) => {
    const ra = jobSortRank(a);
    const rb = jobSortRank(b);
    if (ra !== rb) return ra - rb;
    const ria = repoOrder.get(a.repo) ?? 1e6;
    const rib = repoOrder.get(b.repo) ?? 1e6;
    if (ria !== rib) return ria - rib;
    if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
    return a.name.localeCompare(b.name);
  });
  jobsEl.innerHTML = `<div class="db-jobs-grid">${sorted.map(renderJobCard).join("")}</div>`;
}

/**
 * Add the `pr-exiting` class to any PR card or queue card whose PR is gone
 * from the new snapshot. This must happen *before* startViewTransition so
 * the captured old-snapshot picks up the matching view-transition-class
 * and the CSS exit animation plays.
 */
function markExiting(exiting) {
  for (const key of exiting) {
    const els = document.querySelectorAll(`[data-pr-key="${cssEscapeAttr(key)}"]`);
    for (const el of els) el.classList.add("pr-exiting");
  }
}

function cssEscapeAttr(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

/**
 * Prepare a slurp animation for each PR that just merged: clone the
 * existing queue card to a body-level overlay so it survives the
 * re-render, capture its current viewport rect and the rect of the
 * destination branch card. Returns a list of slurp jobs to run after
 * the re-render has started (so the snapshot of the original card is
 * already taken if a view-transition is also running).
 */
// Set of PR keys whose slurp animation is still in flight. Guards against
// the same key being slurped twice if a re-render somehow surfaces the
// merging diff again before the clone has finished animating.
const inFlightSlurps = new Set();

function prepareSlurps(mergingKeys) {
  const jobs = [];
  for (const key of mergingKeys) {
    if (inFlightSlurps.has(key)) continue;
    const hashIdx = key.indexOf("#");
    if (hashIdx < 0) continue;
    const repo = key.slice(0, hashIdx);
    const src = document.querySelector(`[data-pr-key="${cssEscapeAttr(key)}"]`);
    if (!src) continue;
    const target = document.querySelector(`.db-ship-card[data-repo="${cssEscapeAttr(repo)}"]`);
    if (!target) continue;
    inFlightSlurps.add(key);

    const srcRect = src.getBoundingClientRect();
    const tgtRect = target.getBoundingClientRect();

    const clone = src.cloneNode(true);
    clone.style.position = "fixed";
    clone.style.left = `${srcRect.left}px`;
    clone.style.top = `${srcRect.top}px`;
    clone.style.width = `${srcRect.width}px`;
    clone.style.height = `${srcRect.height}px`;
    clone.style.margin = "0";
    clone.style.zIndex = "1000";
    clone.style.pointerEvents = "none";
    // Detach from the view-transition machinery — we drive this one manually.
    clone.style.viewTransitionName = "none";
    // Strip the identifiers so a follow-up render can't pick up the clone
    // via querySelector("[data-pr-key=...]") and animate it a second time.
    clone.removeAttribute("data-pr-key");
    clone.classList.remove("pr-exiting", "pr-ejecting", "pr-entering");
    document.body.appendChild(clone);

    // Detach the original entirely *before* the view-transition captures
    // its snapshot. display:none alone isn't enough: with the queue row
    // persisting across the transition (because of the linger fix), the
    // parent's snapshot can still pick up the queue card's pixels and
    // crossfade them out in place — reading as a phantom second slurp
    // running next to the body-level clone.
    src.remove();

    jobs.push({ key, clone, srcRect, tgtRect, target });
  }
  return jobs;
}

function runSlurps(jobs) {
  for (const { key, clone, srcRect, tgtRect, target } of jobs) {
    const dx = (tgtRect.left + tgtRect.width / 2) - (srcRect.left + srcRect.width / 2);
    const dy = (tgtRect.top + tgtRect.height / 2) - (srcRect.top + srcRect.height / 2);
    const anim = clone.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1, offset: 0 },
        { transform: `translate(${dx * 0.65}px, ${dy * 0.65}px) scale(0.5) rotate(-3deg)`, opacity: 0.9, offset: 0.6 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.05) rotate(-8deg)`, opacity: 0, offset: 1 },
      ],
      { duration: 700, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
    );
    anim.finished.finally(() => {
      clone.remove();
      inFlightSlurps.delete(key);
    });

    // Brief green flash on the branch card as it "absorbs" the PR.
    setTimeout(() => {
      target.animate(
        [
          { filter: "brightness(1) drop-shadow(0 0 0 transparent)" },
          { filter: "brightness(1.35) drop-shadow(0 0 28px var(--ok))" },
          { filter: "brightness(1) drop-shadow(0 0 0 transparent)" },
        ],
        { duration: 550, easing: "ease-out" },
      );
    }, 480);
  }
}

/**
 * Prepare an explosion overlay for each non-mine queue card that's about to
 * vanish. Cloned to body level (like slurp) so the animation outlives the
 * re-render; the original is hidden before the view-transition snapshots so
 * the card doesn't double-fade behind the explosion.
 */
function prepareExplosions(explodingKeys) {
  const jobs = [];
  for (const key of explodingKeys) {
    const src = document.querySelector(`[data-pr-key="${cssEscapeAttr(key)}"]`);
    if (!src) continue;
    const rect = src.getBoundingClientRect();
    const clone = src.cloneNode(true);
    clone.style.position = "fixed";
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.margin = "0";
    clone.style.zIndex = "1001";
    clone.style.pointerEvents = "none";
    clone.style.viewTransitionName = "none";
    clone.removeAttribute("data-pr-key");
    clone.classList.remove("pr-exiting", "pr-ejecting", "pr-entering");
    document.body.appendChild(clone);
    src.remove();
    jobs.push({ clone, rect });
  }
  return jobs;
}

function runExplosions(jobs) {
  const reduced =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const { clone, rect } of jobs) {
    if (reduced) {
      clone.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 200, fill: "forwards" },
      ).finished.finally(() => clone.remove());
      continue;
    }
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const flash = document.createElement("div");
    flash.className = "pr-explode-flash";
    clone.appendChild(flash);

    const PARTICLE_COUNT = 14;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = document.createElement("div");
      p.className = "pr-explode-particle";
      p.style.left = `${cx - 5}px`;
      p.style.top = `${cy - 5}px`;
      const angle = (i / PARTICLE_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      const distance = 90 + Math.random() * 80;
      const tx = Math.cos(angle) * distance;
      const ty = Math.sin(angle) * distance;
      const dur = 550 + Math.random() * 250;
      p.animate(
        [
          { transform: "translate(0, 0) scale(1)", opacity: 1 },
          { transform: `translate(${tx * 0.5}px, ${ty * 0.5}px) scale(1.1)`, opacity: 1, offset: 0.4 },
          { transform: `translate(${tx}px, ${ty + 30}px) scale(0)`, opacity: 0 },
        ],
        { duration: dur, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" },
      );
      clone.appendChild(p);
    }

    const shake = clone.animate(
      [
        { transform: "translate(0, 0) scale(1) rotate(0deg)", opacity: 1, filter: "brightness(1)" },
        { transform: "translate(-4px, 2px) scale(1.08) rotate(-2deg)", opacity: 1, filter: "brightness(1.6)", offset: 0.15 },
        { transform: "translate(5px, -3px) scale(1.12) rotate(3deg)", opacity: 0.9, filter: "brightness(1.8)", offset: 0.3 },
        { transform: "translate(0, 0) scale(0.35) rotate(-6deg)", opacity: 0, filter: "brightness(1)" },
      ],
      { duration: 650, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" },
    );
    shake.finished.finally(() => clone.remove());
  }
}

/** Set of repos that had a queue row visible at last render. */
let prevQueueRepos = new Set();

function currentQueueRepos(snap) {
  const set = new Set();
  for (const q of snap?.mergeQueues ?? []) {
    if (q.entries && q.entries.length > 0) set.add(q.repo);
  }
  return set;
}

function markQueueRowsEntering(prev, next) {
  for (const repo of next) {
    if (prev.has(repo)) continue;
    const el = document.querySelector(`.db-queue-row[data-repo="${cssEscapeAttr(repo)}"]`);
    if (el) el.classList.add("queue-row-entering");
  }
}

function clearQueueRowEntering() {
  for (const el of document.querySelectorAll(".queue-row-entering")) {
    el.classList.remove("queue-row-entering");
  }
}

/** Map of repo → number of PRs whose merge animation we need to run this tick. */
function reposWithMerges(mergingKeys) {
  const repos = new Set();
  for (const key of mergingKeys) {
    const hashIdx = key.indexOf("#");
    if (hashIdx < 0) continue;
    repos.add(key.slice(0, hashIdx));
  }
  return repos;
}

function runShipSail(repos) {
  const reduced =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;
  for (const repo of repos) {
    const wrap = document.querySelector(`.db-ship-wrap[data-repo="${cssEscapeAttr(repo)}"]`);
    if (!wrap) continue;
    const card = wrap.closest(".db-ship-card");
    if (!card) continue;
    const width = card.getBoundingClientRect().width;
    const out = wrap.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(${-(width + 60)}px)` },
      ],
      { duration: 700, easing: "cubic-bezier(0.4, 0, 0.6, 1)", fill: "forwards" },
    );
    out.finished.then(() => {
      wrap.animate(
        [
          { transform: `translateX(${width + 60}px)` },
          { transform: "translateX(0)" },
        ],
        { duration: 800, easing: "cubic-bezier(0.2, 0.6, 0.3, 1)", fill: "forwards" },
      );
    }).catch(() => {});
  }
}

function render() {
  const snap = effectiveSnapshot();
  if (!snap) return;
  userEl.textContent = snap.user || "";

  const nextState = prLifecycleState(snap);
  activeLifecycles = diffPrLifecycles(prevPrState, nextState);
  const nextQueueState = queueLifecycleState(snap);
  const exploding = diffQueueEjections(prevQueueState, nextQueueState);
  markExiting(activeLifecycles.exiting);
  const slurps = prepareSlurps(activeLifecycles.merging);
  const explosions = prepareExplosions(exploding);
  const mergedRepos = reposWithMerges(activeLifecycles.merging);
  // Keep the queue row mounted for the slurp + ship-sail to play out, even
  // if the snapshot already shows the queue as empty. The follow-up
  // re-render (scheduled inside holdQueueRowOpen) cleans up the stub.
  for (const repo of mergedRepos) holdQueueRowOpen(repo);
  const nextQueueRepos = currentQueueRepos(snap);

  const hadContent = stacksEl.children.length > 0 || jobsEl.children.length > 0 || queuesEl.children.length > 0;
  const doRender = () => {
    renderQueues(snap, lingerQueueRepos);
    renderStacks(snap);
    renderJobs(snap);
    // Run synchronously inside the view-transition callback so the new
    // snapshot picks up the .queue-row-entering class and ::view-transition-new
    // sees it. (Live-element CSS keyframes also work as a fallback path.)
    markQueueRowsEntering(prevQueueRepos, nextQueueRepos);
  };
  // Skip the view-transition on merges. The slurp clone is added to <body>
  // before the snapshot, which means the browser captures it in both the
  // old and new snapshots; once the transition starts, the clone is hidden
  // along with the rest of the live DOM, the Web Animation continues
  // invisibly, and when the transition finishes the clone reappears mid-
  // flight — visually reading as a second, "slightly quicker" slurp on top
  // of the actual one. Bypassing the transition lets the clone animate
  // cleanly from queue position to ship.
  const wantViewTransition = document.startViewTransition && hadContent && slurps.length === 0;
  if (wantViewTransition) {
    const t = document.startViewTransition(doRender);
    t.ready.finally(() => {
      clearLifecycleClasses();
      runSlurps(slurps);
      runExplosions(explosions);
      setTimeout(() => runShipSail(mergedRepos), 520);
      setTimeout(clearQueueRowEntering, 900);
    });
  } else {
    doRender();
    setTimeout(clearLifecycleClasses, 900);
    runSlurps(slurps);
    runExplosions(explosions);
    setTimeout(() => runShipSail(mergedRepos), 520);
    setTimeout(clearQueueRowEntering, 900);
  }
  prevPrState = nextState;
  prevQueueState = nextQueueState;
  prevQueueRepos = nextQueueRepos;
  updateTimestamp();
}

function clearLifecycleClasses() {
  for (const el of document.querySelectorAll(".pr-entering, .pr-ejecting, .pr-exiting")) {
    el.classList.remove("pr-entering", "pr-ejecting", "pr-exiting");
  }
}

function updateTimestamp() {
  if (!latest?.generatedAt) {
    updatedEl.textContent = "";
    return;
  }
  const age = Date.now() - Date.parse(latest.generatedAt);
  updatedEl.textContent = `updated ${fmtAge(age)} ago`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) { return escapeHtml(s); }

function connect() {
  // Resolve "ws" against <base href> so the URL goes through whatever
  // reverse-proxy prefix the page was served under.
  const wsHref = new URL("ws", document.baseURI);
  wsHref.protocol = wsHref.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsHref.href);
  setConn("connecting");
  ws.addEventListener("open", () => setConn("open"));
  ws.addEventListener("close", () => {
    setConn("closed");
    setTimeout(connect, 2000);
  });
  ws.addEventListener("error", () => setConn("closed"));
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "dashboard-snapshot") {
      latest = msg.data;
      render();
    } else if (msg.type === "reload") {
      location.reload();
    }
  });
}

// Bootstrap snapshot via REST in case we missed the initial WS push.
fetch("api/dashboard")
  .then((r) => r.json())
  .then((data) => {
    if (data && data.prs) {
      latest = data;
      render();
    }
  })
  .catch(() => {});

connect();

updatedTicker = setInterval(updateTimestamp, 1000);

if (TEST_MODE) {
  // Render immediately so the test PR shows up even before any real data
  // arrives over the wire, then advance through the cycle every five seconds.
  render();
  if (TEST_CYCLE.length > 1) {
    setInterval(() => {
      testCycleIdx = (testCycleIdx + 1) % TEST_CYCLE.length;
      render();
    }, TEST_CYCLE_MS);
  }
}
