import { describe, it, expect } from 'bun:test';
import { renderFailuresBlock } from './dashboard-failures.js';

const mkJob = (overrides = {}) => ({
  name: 'job',
  url: 'https://ci/job',
  failedTests: [],
  ...overrides,
});

const mkFailed = (jobs) => jobs.map((job) => ({ workflow: 'wf', job }));

describe('renderFailuresBlock', () => {
  it('returns empty string when nothing failed', () => {
    expect(renderFailuresBlock([])).toBe('');
    expect(renderFailuresBlock(undefined)).toBe('');
  });

  it('renders a full breakdown when the global total is at or below the limit', () => {
    const html = renderFailuresBlock(mkFailed([
      mkJob({ name: 'build', failedTests: ['a', 'b'] }),
      mkJob({ name: 'lint', failedTests: ['c'] }),
    ]));
    expect(html).toContain('Failing jobs');
    expect(html).toContain('build');
    expect(html).toContain('lint');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>c</li>');
    expect(html).not.toContain('db-failures-count');
  });

  it('collapses to a global count when total tests exceed the limit', () => {
    const html = renderFailuresBlock(mkFailed([
      mkJob({ failedTests: ['a', 'b', 'c', 'd', 'e'] }),
    ]));
    expect(html).toContain('<div class="db-failures-count">5 failures</div>');
    expect(html).not.toContain('Failing jobs');
    expect(html).not.toContain('<li>');
  });

  it('aggregates across jobs (1 failing test in 5 jobs → "5 failures")', () => {
    const html = renderFailuresBlock(mkFailed([
      mkJob({ name: 'j1', failedTests: ['a'] }),
      mkJob({ name: 'j2', failedTests: ['b'] }),
      mkJob({ name: 'j3', failedTests: ['c'] }),
      mkJob({ name: 'j4', failedTests: ['d'] }),
      mkJob({ name: 'j5', failedTests: ['e'] }),
    ]));
    expect(html).toContain('<div class="db-failures-count">5 failures</div>');
    expect(html).not.toContain('j1');
  });

  it('counts a failed job without test detail as one failure', () => {
    const html = renderFailuresBlock(mkFailed([
      mkJob({ name: 'j1', failedTests: [] }),
      mkJob({ name: 'j2', failedTests: [] }),
      mkJob({ name: 'j3', failedTests: [] }),
      mkJob({ name: 'j4', failedTests: [] }),
      mkJob({ name: 'j5', failedTests: [] }),
    ]));
    expect(html).toContain('<div class="db-failures-count">5 failures</div>');
  });

  it('keeps a single failure in the breakdown path (does not collapse)', () => {
    const html = renderFailuresBlock(mkFailed([mkJob({ failedTests: ['only'] })]));
    expect(html).toContain('<li>only</li>');
    expect(html).not.toContain('db-failures-count');
  });

  it('renders job name as a link when url is present', () => {
    const html = renderFailuresBlock(mkFailed([
      mkJob({ name: 'build', url: 'https://example/ci', failedTests: ['t'] }),
    ]));
    expect(html).toContain('href="https://example/ci"');
    expect(html).toContain('>build<');
  });

  it('strips qualifier prefix from each test name', () => {
    const html = renderFailuresBlock(mkFailed([
      mkJob({ failedTests: ['pkg/foo::TestBar'] }),
    ]));
    expect(html).toContain('<li>TestBar</li>');
    expect(html).not.toContain('pkg/foo');
  });

  it('escapes HTML in test and job names', () => {
    const html = renderFailuresBlock(mkFailed([
      mkJob({ name: '<x>', url: '', failedTests: ['<img src=x onerror=alert(1)>'] }),
    ]));
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;x&gt;');
  });
});
