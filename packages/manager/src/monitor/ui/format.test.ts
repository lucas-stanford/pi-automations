import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastCheckText, nextText, summarySchedule } from './format';
import { sampleFields, sampleSummary } from './testHelpers';

describe('watch text', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const watch = { script: 'scripts/watch.js', every: '5m' };

  it('says how often a watch checks, alone or beside a schedule', () => {
    expect(summarySchedule(sampleSummary(sampleFields({ on: { manual: true, watch } })))).toBe('checks every 5m');
    expect(summarySchedule(sampleSummary(sampleFields({ on: { manual: false, schedule: { cron: '0 9 * * *', catchUp: 'skip' }, watch } })))).toBe('At 09:00 AM · checks every 5m');
    expect(summarySchedule(sampleSummary(sampleFields({ on: { manual: true } })))).toBe('manual');
  });

  it('shows the next check only when there is no next fire', () => {
    const summary = sampleSummary(sampleFields({ on: { manual: true, watch } }));
    expect(nextText({ ...summary, nextCheck: '2026-10-07T12:04:00Z' })).toBe('next check in 4m');
    expect(nextText({ ...summary, nextFire: '2026-10-07T13:00:00Z', nextCheck: '2026-10-07T12:04:00Z' })).toBe('next in 1h 00m');
    expect(nextText(summary)).toBeNull();
  });

  it('says when the last check ran and how it ended', () => {
    expect(lastCheckText({ checkedAt: '2026-10-07T11:58:00Z', exit: 0, durationMs: 700, said: '2 new comments' })).toBe('Checked 2m ago · exit 0 · 2 new comments');
    expect(lastCheckText({ checkedAt: '2026-10-07T11:58:00Z', problem: 'timed out after 1m', durationMs: 60_000 })).toBe('Checked 2m ago · timed out after 1m');
  });
});
