import { describe, it, expect } from 'bun:test';
import { prActionRank, sortStacks } from './dashboard-sort.js';

const mkPr = (overrides = {}) => ({
  key: overrides.key ?? `o/r#${overrides.number ?? 1}`,
  number: 1,
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  isInMergeQueue: false,
  ci: { rolledUp: 'success' },
  ...overrides,
});

describe('prActionRank', () => {
  it('ranks approved + passing CI as ready-to-merge (1)', () => {
    expect(prActionRank(mkPr({ reviewDecision: 'APPROVED', ci: { rolledUp: 'success' } }))).toBe(1);
  });

  it('treats empty reviewDecision (no review required) as approved', () => {
    expect(prActionRank(mkPr({ reviewDecision: '', ci: { rolledUp: 'success' } }))).toBe(1);
  });

  it('ranks PRs already in the merge queue as ready-to-merge (1)', () => {
    expect(prActionRank(mkPr({ isInMergeQueue: true, reviewDecision: 'REVIEW_REQUIRED' }))).toBe(1);
  });

  it('treats running CI as not-yet-failing for an approved PR', () => {
    expect(prActionRank(mkPr({ reviewDecision: 'APPROVED', ci: { rolledUp: 'running' } }))).toBe(1);
  });

  it('ranks approved + failing CI as 2', () => {
    expect(prActionRank(mkPr({ reviewDecision: 'APPROVED', ci: { rolledUp: 'failed' } }))).toBe(2);
  });

  it('treats blocked CI as failing for an approved PR', () => {
    expect(prActionRank(mkPr({ reviewDecision: 'APPROVED', ci: { rolledUp: 'blocked' } }))).toBe(2);
  });

  it('ranks unapproved + failing CI as 3', () => {
    expect(prActionRank(mkPr({ reviewDecision: 'REVIEW_REQUIRED', ci: { rolledUp: 'failed' } }))).toBe(3);
  });

  it('treats CHANGES_REQUESTED as unapproved', () => {
    expect(prActionRank(mkPr({ reviewDecision: 'CHANGES_REQUESTED', ci: { rolledUp: 'failed' } }))).toBe(3);
  });

  it('ranks unapproved + passing CI as 4', () => {
    expect(prActionRank(mkPr({ reviewDecision: 'REVIEW_REQUIRED', ci: { rolledUp: 'success' } }))).toBe(4);
  });

  it('ranks drafts last (5) regardless of CI/review state', () => {
    expect(prActionRank(mkPr({ isDraft: true, reviewDecision: 'APPROVED', ci: { rolledUp: 'success' } }))).toBe(5);
    expect(prActionRank(mkPr({ isDraft: true, reviewDecision: 'REVIEW_REQUIRED', ci: { rolledUp: 'failed' } }))).toBe(5);
  });

  it('treats missing CI as not-failing', () => {
    expect(prActionRank(mkPr({ reviewDecision: 'APPROVED', ci: undefined }))).toBe(1);
    expect(prActionRank(mkPr({ reviewDecision: 'REVIEW_REQUIRED', ci: undefined }))).toBe(4);
  });
});

describe('sortStacks', () => {
  const prs = {
    'o/r#1': mkPr({ key: 'o/r#1', number: 1, reviewDecision: 'APPROVED', ci: { rolledUp: 'success' } }),    // rank 1
    'o/r#2': mkPr({ key: 'o/r#2', number: 2, reviewDecision: 'APPROVED', ci: { rolledUp: 'failed' } }),     // rank 2
    'o/r#3': mkPr({ key: 'o/r#3', number: 3, reviewDecision: 'REVIEW_REQUIRED', ci: { rolledUp: 'failed' } }), // rank 3
    'o/r#4': mkPr({ key: 'o/r#4', number: 4, reviewDecision: 'REVIEW_REQUIRED', ci: { rolledUp: 'success' } }), // rank 4
    'o/r#5': mkPr({ key: 'o/r#5', number: 5, isDraft: true }),                                              // rank 5
  };
  const byKey = new Map(Object.entries(prs));

  it('orders single-PR stacks by action rank', () => {
    const stacks = [
      { rootKey: 'o/r#5', prKeys: ['o/r#5'] },
      { rootKey: 'o/r#4', prKeys: ['o/r#4'] },
      { rootKey: 'o/r#3', prKeys: ['o/r#3'] },
      { rootKey: 'o/r#2', prKeys: ['o/r#2'] },
      { rootKey: 'o/r#1', prKeys: ['o/r#1'] },
    ];
    const sorted = sortStacks(stacks, byKey);
    expect(sorted.map((s) => s.rootKey)).toEqual([
      'o/r#1', 'o/r#2', 'o/r#3', 'o/r#4', 'o/r#5',
    ]);
  });

  it('uses best (lowest) rank inside a stack to position it', () => {
    // A stack containing one ready-to-merge PR should outrank a stack of only-drafts.
    const stacks = [
      { rootKey: 'o/r#5', prKeys: ['o/r#5'] },        // draft only
      { rootKey: 'o/r#4', prKeys: ['o/r#4', 'o/r#1'] }, // has a ready-to-merge PR
    ];
    const sorted = sortStacks(stacks, byKey);
    expect(sorted[0].rootKey).toBe('o/r#4');
    expect(sorted[1].rootKey).toBe('o/r#5');
  });

  it('breaks ties on rank by stack size (larger first)', () => {
    const byKeyAllReady = new Map([
      ['o/r#10', mkPr({ key: 'o/r#10', number: 10, reviewDecision: 'APPROVED', ci: { rolledUp: 'success' } })],
      ['o/r#11', mkPr({ key: 'o/r#11', number: 11, reviewDecision: 'APPROVED', ci: { rolledUp: 'success' } })],
      ['o/r#12', mkPr({ key: 'o/r#12', number: 12, reviewDecision: 'APPROVED', ci: { rolledUp: 'success' } })],
    ]);
    const stacks = [
      { rootKey: 'o/r#10', prKeys: ['o/r#10'] },
      { rootKey: 'o/r#11', prKeys: ['o/r#11', 'o/r#12'] },
    ];
    const sorted = sortStacks(stacks, byKeyAllReady);
    expect(sorted[0].rootKey).toBe('o/r#11');
    expect(sorted[1].rootKey).toBe('o/r#10');
  });

  it('does not mutate the input array', () => {
    const stacks = [
      { rootKey: 'o/r#5', prKeys: ['o/r#5'] },
      { rootKey: 'o/r#1', prKeys: ['o/r#1'] },
    ];
    const original = stacks.map((s) => s.rootKey);
    sortStacks(stacks, byKey);
    expect(stacks.map((s) => s.rootKey)).toEqual(original);
  });
});
