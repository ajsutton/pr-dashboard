import { describe, it, expect } from 'bun:test';
import { buildStatCards } from './dashboard-stats.js';

const item = (over = {}) => ({
  repo: 'o/r',
  number: 1,
  title: 't',
  url: 'u',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-02T00:00:00Z',
  ...over,
});

describe('buildStatCards', () => {
  it('produces five cards in the expected order', () => {
    const cards = buildStatCards({
      assignedIssues: [],
      reviewRequests: [],
      totalIssuesByRepo: [],
      totalPrsByRepo: [],
    });
    expect(cards.map((c) => c.id)).toEqual([
      'assigned-issues',
      'personal-reviews',
      'review-requests',
      'open-issues',
      'open-prs',
    ]);
  });

  it('counts assigned issues by array length', () => {
    const cards = buildStatCards({
      assignedIssues: [item(), item(), item()],
      reviewRequests: [],
      totalIssuesByRepo: [],
      totalPrsByRepo: [],
    });
    expect(cards.find((c) => c.id === 'assigned-issues').count).toBe(3);
  });

  it('counts personal review requests as only the personal-flagged subset', () => {
    const cards = buildStatCards({
      assignedIssues: [],
      reviewRequests: [
        { ...item({ number: 1 }), isPersonal: true },
        { ...item({ number: 2 }), isPersonal: false },
        { ...item({ number: 3 }), isPersonal: true },
      ],
      totalIssuesByRepo: [],
      totalPrsByRepo: [],
    });
    const personal = cards.find((c) => c.id === 'personal-reviews');
    expect(personal.count).toBe(2);
    expect(personal.items.map((r) => r.number)).toEqual([1, 3]);
  });

  it('counts all review requests (personal + group) for the Review Requests card', () => {
    const cards = buildStatCards({
      assignedIssues: [],
      reviewRequests: [
        { ...item({ number: 1 }), isPersonal: true },
        { ...item({ number: 2 }), isPersonal: false },
      ],
      totalIssuesByRepo: [],
      totalPrsByRepo: [],
    });
    expect(cards.find((c) => c.id === 'review-requests').count).toBe(2);
  });

  it('sums per-repo totals for the open-issues / open-prs cards', () => {
    const cards = buildStatCards({
      assignedIssues: [],
      reviewRequests: [],
      totalIssuesByRepo: [
        { repo: 'a/b', count: 3, url: '' },
        { repo: 'c/d', count: 4, url: '' },
      ],
      totalPrsByRepo: [
        { repo: 'a/b', count: 1, url: '' },
        { repo: 'c/d', count: 7, url: '' },
      ],
    });
    expect(cards.find((c) => c.id === 'open-issues').count).toBe(7);
    expect(cards.find((c) => c.id === 'open-prs').count).toBe(8);
  });

  it('prefers server-provided totals over node-array length for assigned/review counts', () => {
    // The search API caps `nodes` at 100, so when the real workload exceeds
    // that, the server-provided *TotalCount is the only accurate number.
    const cards = buildStatCards({
      assignedIssues: [item(), item()], // length 2, but real total higher
      assignedIssuesTotalCount: 137,
      reviewRequests: [{ ...item(), isPersonal: true }],
      reviewRequestsTotalCount: 215,
      personalReviewRequestsTotalCount: 4,
      totalIssuesByRepo: [],
      totalPrsByRepo: [],
    });
    expect(cards.find((c) => c.id === 'assigned-issues').count).toBe(137);
    expect(cards.find((c) => c.id === 'review-requests').count).toBe(215);
    expect(cards.find((c) => c.id === 'personal-reviews').count).toBe(4);
  });

  it('marks items-cards with kind "items" and totals-cards with kind "totals"', () => {
    const cards = buildStatCards({
      assignedIssues: [item()],
      reviewRequests: [],
      totalIssuesByRepo: [{ repo: 'a/b', count: 1, url: '' }],
      totalPrsByRepo: [],
    });
    expect(cards.find((c) => c.id === 'assigned-issues').kind).toBe('items');
    expect(cards.find((c) => c.id === 'open-issues').kind).toBe('totals');
  });
});
