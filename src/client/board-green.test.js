import { describe, it, expect } from 'bun:test';
import { boardAllGreen, nextKermitAction } from './board-green.js';

// Minimal snapshot builders — only the fields boardAllGreen reads.
const pr = (rolledUp) => ({ ci: rolledUp ? { rolledUp } : null });
const queue = (...rolledUps) => ({
  entries: rolledUps.map((r) => ({ ci: r ? { rolledUp: r } : null })),
});
const job = (latest, lastCompleted) => ({
  latest: { status: latest },
  lastCompleted: lastCompleted ? { status: lastCompleted } : null,
});

const snap = (over = {}) => ({
  prs: [],
  mergeQueues: [],
  defaultBranchJobs: [],
  ...over,
});

describe('boardAllGreen', () => {
  it('is false for an empty/loading board (nothing to celebrate)', () => {
    expect(boardAllGreen(snap())).toBe(false);
  });

  it('is false for a null/absent snapshot', () => {
    expect(boardAllGreen(null)).toBe(false);
    expect(boardAllGreen(undefined)).toBe(false);
  });

  it('is true when the only item is a green PR', () => {
    expect(boardAllGreen(snap({ prs: [pr('success')] }))).toBe(true);
  });

  it('is false when any PR CI has failed', () => {
    expect(boardAllGreen(snap({ prs: [pr('success'), pr('failed')] }))).toBe(false);
  });

  it('treats a running PR as fine (nothing red)', () => {
    expect(boardAllGreen(snap({ prs: [pr('running')] }))).toBe(true);
  });

  it('is false when a merge-queue entry has failed', () => {
    expect(
      boardAllGreen(snap({ prs: [pr('success')], mergeQueues: [queue('running', 'failed')] })),
    ).toBe(false);
  });

  it('is true when merge-queue entries are running/queued', () => {
    expect(boardAllGreen(snap({ mergeQueues: [queue('running', 'queued')] }))).toBe(true);
  });

  it('is true for a Projects job whose latest run succeeded', () => {
    expect(boardAllGreen(snap({ defaultBranchJobs: [job('success')] }))).toBe(true);
  });

  it('is false for a Projects job whose latest run failed', () => {
    expect(boardAllGreen(snap({ defaultBranchJobs: [job('failed', 'success')] }))).toBe(false);
  });

  it('is false for a Projects job whose latest run is blocked', () => {
    expect(boardAllGreen(snap({ defaultBranchJobs: [job('blocked')] }))).toBe(false);
  });

  it('is true for a running Projects job whose previous run was green', () => {
    expect(boardAllGreen(snap({ defaultBranchJobs: [job('running', 'success')] }))).toBe(true);
  });

  it('is false for a running Projects job whose previous run was red', () => {
    expect(boardAllGreen(snap({ defaultBranchJobs: [job('running', 'failed')] }))).toBe(false);
  });

  it('treats a running Projects job with no previous run as fine', () => {
    expect(boardAllGreen(snap({ defaultBranchJobs: [job('running', null)] }))).toBe(true);
  });

  it('is true across all three sections when everything is green', () => {
    expect(
      boardAllGreen(
        snap({
          prs: [pr('success'), pr('running')],
          mergeQueues: [queue('running', 'queued')],
          defaultBranchJobs: [job('success'), job('running', 'success')],
        }),
      ),
    ).toBe(true);
  });

  it('is false if any one section has a failure', () => {
    expect(
      boardAllGreen(
        snap({
          prs: [pr('success')],
          mergeQueues: [queue('queued')],
          defaultBranchJobs: [job('running', 'failed')],
        }),
      ),
    ).toBe(false);
  });
});

describe('nextKermitAction', () => {
  const at = (over = {}) =>
    nextKermitAction({ green: false, visible: false, falling: false, reducedMotion: false, ...over });

  it('hops Kermit onto the pill when the board goes green and he is absent', () => {
    expect(at({ green: true, visible: false })).toBe('show');
  });

  it('does nothing while green and already perched', () => {
    expect(at({ green: true, visible: true })).toBe('none');
  });

  it('recovers (hops back up) if the board goes green again mid-fall', () => {
    expect(at({ green: true, visible: true, falling: true })).toBe('show');
  });

  it('topples Kermit backwards when the board goes red while he is perched', () => {
    expect(at({ green: false, visible: true })).toBe('fall');
  });

  it('does not restart the topple if he is already falling', () => {
    expect(at({ green: false, visible: true, falling: true })).toBe('none');
  });

  it('does nothing when red and he is already gone', () => {
    expect(at({ green: false, visible: false })).toBe('none');
  });

  it('skips the topple and hides immediately under reduced motion', () => {
    expect(at({ green: false, visible: true, reducedMotion: true })).toBe('hide');
  });
});
