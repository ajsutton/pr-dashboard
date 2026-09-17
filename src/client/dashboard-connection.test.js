import { describe, expect, it } from 'bun:test';
import { startDashboardConnection, STALE_AFTER_MS } from './dashboard-connection.js';

function harness() {
  const document = new EventTarget();
  document.hidden = false;
  document.baseURI = 'https://example.com/dashboard/';
  const window = new EventTarget();
  const sockets = [];
  const requests = [];
  const snapshots = [];
  const states = [];
  const timers = new Map();
  let time = Date.parse('2026-09-17T00:00:00Z');
  let timerId = 0;
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; sockets.push(this); }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
    sendSnapshot(data) {
      this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'dashboard-snapshot', data }),
      }));
    }
  }
  const stop = startDashboardConnection({
    document, window, WebSocket: Socket,
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve: (data) => resolve({ ok: true, json: async () => data }), reject });
    }),
    onSnapshot: (data, options) => snapshots.push({ data, ...options }),
    onState: (state) => states.push(state),
    onReload: () => {},
    now: () => time,
    setTimer: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    document, window, sockets, requests, snapshots, states, timers, stop,
    advance: (ms) => { time += ms; },
    snapshot: () => ({ prs: [], generatedAt: new Date(time).toISOString() }),
    visibility: (hidden) => {
      document.hidden = hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('dashboard connection recovery', () => {
  it('discards hidden-tab backlog and replaces state on return', async () => {
    const h = harness();
    const old = h.sockets[0];
    old.sendSnapshot(h.snapshot());
    h.visibility(true);
    expect(old.closed).toBe(true);
    expect(h.requests[0].options.signal.aborted).toBe(true);
    h.advance(10 * STALE_AFTER_MS);
    h.visibility(false);
    old.sendSnapshot(h.snapshot());
    old.dispatchEvent(new Event('open'));
    old.dispatchEvent(new Event('close'));
    h.requests[0].resolve(h.snapshot());
    await flush();
    expect(h.snapshots).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    expect(h.states.at(-1)).toBe('connecting');
    h.requests[1].resolve(h.snapshot());
    await flush();
    expect(h.snapshots.at(-1)).toEqual({ data: h.snapshot(), reset: true });
    expect(h.sockets[1].url).toBe('wss://example.com/dashboard/ws');
    expect(h.requests[1].url).toBe('https://example.com/dashboard/api/dashboard');
    expect(h.requests[1].options.cache).toBe('no-store');
    h.stop();
  });

  it('drops queued messages before parsing when sleep ends before visibility events', () => {
    const h = harness();
    const old = h.sockets[0];
    const stale = h.snapshot();
    old.sendSnapshot(stale);
    h.advance(STALE_AFTER_MS + 1);
    for (let i = 0; i < 100; i++) old.sendSnapshot(stale);
    expect(h.sockets).toHaveLength(2);
    expect(h.snapshots).toHaveLength(1);
    h.sockets[1].sendSnapshot(h.snapshot());
    expect(h.snapshots.at(-1)).toEqual({ data: h.snapshot(), reset: true });
    h.stop();
  });

  it('recovers on focus/pageshow without opening duplicate connections', () => {
    const h = harness();
    h.advance(STALE_AFTER_MS + 1);
    h.window.dispatchEvent(new Event('focus'));
    h.window.dispatchEvent(new Event('pageshow'));
    expect(h.sockets).toHaveLength(2);
    h.stop();
  });

  it('keeps normal live updates and prevents late REST responses from rolling state back', async () => {
    const h = harness();
    const older = h.snapshot();
    h.sockets[0].sendSnapshot(older);
    h.advance(1000);
    h.sockets[0].sendSnapshot(h.snapshot());
    h.requests[0].resolve(older);
    await flush();
    expect(h.snapshots).toEqual([
      { data: older, reset: true },
      { data: h.snapshot(), reset: false },
    ]);
    h.stop();
  });

  it('accepts an old server snapshot without repeatedly reconnecting', () => {
    const h = harness();
    const stale = h.snapshot();
    h.advance(STALE_AFTER_MS + 1);
    h.window.dispatchEvent(new Event('pageshow'));
    h.sockets[1].sendSnapshot(stale);
    h.sockets[1].sendSnapshot(stale);
    expect(h.sockets).toHaveLength(2);
    expect(h.snapshots).toHaveLength(2);
    h.stop();
  });

  it('retries failed connections and cancels the retry when hidden', async () => {
    const h = harness();
    h.requests[0].reject(new Error('offline'));
    h.sockets[0].close();
    expect(h.timers.size).toBe(1);
    h.visibility(true);
    expect(h.timers.size).toBe(0);
    await flush();
    h.visibility(false);
    expect(h.sockets).toHaveLength(2);
    h.stop();
  });
});
