import { describe, it, expect } from 'bun:test';
import {
  diffPrLifecycles,
  prLifecycleState,
  prVtName,
  queueLifecycleState,
  diffQueueEjections,
} from './dashboard-lifecycle.js';

const mk = (key, inQueue = false) => [key, { inQueue }];

describe('diffPrLifecycles', () => {
  it('marks brand-new PRs as entering', () => {
    const prev = new Map();
    const next = new Map([mk('o/r#1'), mk('o/r#2')]);
    const { entering, exiting, ejecting } = diffPrLifecycles(prev, next);
    expect([...entering]).toEqual(['o/r#1', 'o/r#2']);
    expect([...exiting]).toEqual([]);
    expect([...ejecting]).toEqual([]);
  });

  it('marks vanished stack PRs as exiting (not merging)', () => {
    const prev = new Map([mk('o/r#1'), mk('o/r#2')]);
    const next = new Map([mk('o/r#2')]);
    const { entering, exiting, ejecting, merging } = diffPrLifecycles(prev, next);
    expect([...entering]).toEqual([]);
    expect([...exiting]).toEqual(['o/r#1']);
    expect([...ejecting]).toEqual([]);
    expect([...merging]).toEqual([]);
  });

  it('marks vanished queue PRs as merging (not exiting)', () => {
    const prev = new Map([mk('o/r#1', true)]);
    const next = new Map();
    const { exiting, merging } = diffPrLifecycles(prev, next);
    expect([...merging]).toEqual(['o/r#1']);
    expect([...exiting]).toEqual([]);
  });

  it('marks PR leaving the queue as ejecting', () => {
    const prev = new Map([mk('o/r#1', true)]);
    const next = new Map([mk('o/r#1', false)]);
    const { entering, exiting, ejecting } = diffPrLifecycles(prev, next);
    expect([...entering]).toEqual([]);
    expect([...exiting]).toEqual([]);
    expect([...ejecting]).toEqual(['o/r#1']);
  });

  it('does not mark PR entering the queue as ejecting', () => {
    const prev = new Map([mk('o/r#1', false)]);
    const next = new Map([mk('o/r#1', true)]);
    const { entering, exiting, ejecting } = diffPrLifecycles(prev, next);
    expect([...ejecting]).toEqual([]);
    expect([...entering]).toEqual([]);
  });

  it('handles unchanged PR set as empty diff', () => {
    const prev = new Map([mk('o/r#1'), mk('o/r#2', true)]);
    const next = new Map([mk('o/r#1'), mk('o/r#2', true)]);
    const { entering, exiting, ejecting, merging } = diffPrLifecycles(prev, next);
    expect(entering.size).toBe(0);
    expect(exiting.size).toBe(0);
    expect(ejecting.size).toBe(0);
    expect(merging.size).toBe(0);
  });
});

describe('prLifecycleState', () => {
  it('captures in-queue flag from snapshot', () => {
    const snap = {
      prs: [
        { key: 'o/r#1', isInMergeQueue: true },
        { key: 'o/r#2', isInMergeQueue: false },
      ],
    };
    const st = prLifecycleState(snap);
    expect(st.get('o/r#1').inQueue).toBe(true);
    expect(st.get('o/r#2').inQueue).toBe(false);
  });

  it('handles missing/undefined isInMergeQueue as false', () => {
    const snap = { prs: [{ key: 'o/r#1' }] };
    expect(prLifecycleState(snap).get('o/r#1').inQueue).toBe(false);
  });
});

describe('queueLifecycleState', () => {
  it('captures one entry per queued PR keyed by repo#number', () => {
    const snap = {
      mergeQueues: [
        {
          repo: 'o/r',
          entries: [
            { prNumber: 1, mine: true, state: 'QUEUED', ci: { rolledUp: 'running' } },
            { prNumber: 2, mine: false, state: 'UNMERGEABLE', ci: { rolledUp: 'failed' } },
          ],
        },
      ],
    };
    const st = queueLifecycleState(snap);
    expect(st.get('o/r#1')).toEqual({ mine: true, state: 'QUEUED', ciRolledUp: 'running' });
    expect(st.get('o/r#2')).toEqual({ mine: false, state: 'UNMERGEABLE', ciRolledUp: 'failed' });
  });

  it('tolerates missing mergeQueues / entries / ci fields', () => {
    expect(queueLifecycleState({}).size).toBe(0);
    const snap = { mergeQueues: [{ repo: 'o/r', entries: [{ prNumber: 7 }] }] };
    expect(queueLifecycleState(snap).get('o/r#7')).toEqual({
      mine: false,
      state: null,
      ciRolledUp: null,
    });
  });
});

describe('diffQueueEjections', () => {
  const e = (overrides = {}) => ({ mine: false, state: 'QUEUED', ciRolledUp: 'running', ...overrides });

  it('explodes a non-mine entry that vanished after going UNMERGEABLE', () => {
    const prev = new Map([['o/r#1', e({ state: 'UNMERGEABLE' })]]);
    const next = new Map();
    expect([...diffQueueEjections(prev, next)]).toEqual(['o/r#1']);
  });

  it('explodes a non-mine entry that vanished after CI failed', () => {
    const prev = new Map([['o/r#1', e({ ciRolledUp: 'failed' })]]);
    const next = new Map();
    expect([...diffQueueEjections(prev, next)]).toEqual(['o/r#1']);
  });

  it('does not explode a non-mine entry that vanished cleanly (likely merged)', () => {
    const prev = new Map([['o/r#1', e({ state: 'MERGEABLE', ciRolledUp: 'success' })]]);
    const next = new Map();
    expect([...diffQueueEjections(prev, next)]).toEqual([]);
  });

  it('does not explode a non-mine entry that vanished while still running', () => {
    const prev = new Map([['o/r#1', e({ ciRolledUp: 'running' })]]);
    const next = new Map();
    expect([...diffQueueEjections(prev, next)]).toEqual([]);
  });

  it('never explodes the dashboard user\'s own PRs (covered by ejecting/merging)', () => {
    const prev = new Map([
      ['o/r#1', e({ mine: true, state: 'UNMERGEABLE' })],
      ['o/r#2', e({ mine: true, ciRolledUp: 'failed' })],
    ]);
    const next = new Map();
    expect([...diffQueueEjections(prev, next)]).toEqual([]);
  });

  it('does not explode entries that are still present', () => {
    const prev = new Map([['o/r#1', e({ ciRolledUp: 'failed' })]]);
    const next = new Map([['o/r#1', e({ ciRolledUp: 'failed' })]]);
    expect([...diffQueueEjections(prev, next)]).toEqual([]);
  });

  it('does not explode brand-new entries', () => {
    const prev = new Map();
    const next = new Map([['o/r#1', e({ ciRolledUp: 'failed' })]]);
    expect([...diffQueueEjections(prev, next)]).toEqual([]);
  });
});

describe('prVtName', () => {
  it('produces a CSS-safe identifier from repo + number', () => {
    expect(prVtName('owner/repo', 42)).toBe('pr-owner_repo-42');
  });

  it('replaces all non-alphanumeric characters', () => {
    expect(prVtName('owner.x/repo-y', 7)).toBe('pr-owner_x_repo_y-7');
  });
});
