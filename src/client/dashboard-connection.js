export const STALE_AFTER_MS = 2 * 60 * 1000;

/** Own the stream so discarded sockets and REST requests cannot replay old state. */
export function startDashboardConnection({
  document, window, WebSocket, fetch, onSnapshot, onState, onReload,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let socket = null;
  let request = null;
  let retry = null;
  let generation = 0;
  let lastActivity = now();
  let latestTime = -Infinity;
  let stopped = false;

  function discard() {
    generation++;
    clearTimer(retry);
    retry = null;
    request?.abort();
    request = null;
    const old = socket;
    socket = null;
    old?.close();
  }

  function connect() {
    discard();
    if (stopped || document.hidden) return;
    const current = generation;
    let firstSnapshot = true;
    const accept = (data) => {
      if (current !== generation || !data || !Array.isArray(data.prs)) return;
      const timestamp = Date.parse(data.generatedAt);
      // A bootstrap response may arrive after a newer stream snapshot.
      if (!Number.isFinite(timestamp) || timestamp < latestTime) return;
      latestTime = timestamp;
      onSnapshot(data, { reset: firstSnapshot });
      firstSnapshot = false;
    };
    lastActivity = now();
    onState("connecting");
    const url = new URL("ws", document.baseURI);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = socket = new WebSocket(url.href);
    ws.addEventListener("open", () => {
      if (current === generation) onState("open");
    });
    ws.addEventListener("close", () => {
      if (current !== generation) return;
      onState("closed");
      retry = setTimer(connect, 2000);
    });
    ws.addEventListener("error", () => {
      if (current === generation) onState("closed");
    });
    ws.addEventListener("message", (event) => {
      if (current !== generation) return;
      // This also catches sleep/resume when queued messages run before focus
      // or visibilitychange. Replacing the socket drops its entire backlog.
      if (now() - lastActivity > STALE_AFTER_MS) {
        connect();
        return;
      }
      lastActivity = now();
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "dashboard-snapshot") accept(message.data);
      else if (message.type === "reload") onReload();
    });
    request = new AbortController();
    fetch(new URL("api/dashboard", document.baseURI).href, {
      cache: "no-store", signal: request.signal,
    }).then((response) => {
      if (!response.ok) throw new Error("Snapshot request failed");
      return response.json();
    }).then(accept).catch(() => {});
  }

  function visibilityChanged() {
    if (document.hidden) discard();
    else connect();
  }
  function resume() {
    if (!document.hidden && (!socket || now() - lastActivity > STALE_AFTER_MS)) connect();
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("focus", resume);
  window.addEventListener("pageshow", resume);
  connect();
  return () => {
    stopped = true;
    discard();
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("focus", resume);
    window.removeEventListener("pageshow", resume);
  };
}
