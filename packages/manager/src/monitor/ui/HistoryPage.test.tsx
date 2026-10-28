import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationIndex, HistoryPage as HistoryData, HistoryRun } from '../../host/contract';
import type { ManagerClient } from '../../host/client';
import { HistoryPage } from './HistoryPage';
import { sampleSummary, sampleFields } from './testHelpers';

function run(overrides: Partial<HistoryRun> = {}): HistoryRun {
  return {
    id: 'run-1',
    trigger: 'schedule',
    outcome: 'ok',
    recordedAt: '2026-10-22T08:01:00.000Z',
    startedAt: '2026-10-22T08:00:00.000Z',
    endedAt: '2026-10-22T08:01:00.000Z',
    durationMs: 60_000,
    summary: 'Published the digest',
    hooks: [],
    automation: { id: 'daily-digest.1234abcd', name: 'daily-digest' },
    ...overrides,
  };
}

const RUNS: HistoryRun[] = [
  run({
    message: {
      ts: '2026-10-22T08:00:59.000Z',
      text: 'Digest is up: **2 PRs** wait on you.',
      links: [
        { label: 'Canvas digest', url: 'https://example.com/d/1' },
        { label: 'PR #12', url: 'https://example.com/pr/12' },
        { label: 'sneaky', url: 'javascript:alert(1)' },
      ],
    },
  }),
  run({
    id: 'run-2',
    outcome: 'failed',
    summary: 'gh: HTTP 502 while posting',
    automation: { id: 'nightly.5678abcd', name: 'nightly' },
    notes: [{ ts: '2026-10-21T22:00:00.000Z', text: 'Drafted the report', links: [{ label: 'draft', url: 'https://example.com/draft' }] }],
  }),
  run({ id: 'run-3', summary: 'Nothing new', output: { text: '## Nothing new\n\nChecked 4 feeds.', truncated: false }, automation: { id: 'watcher.9999abcd', name: 'watcher' } }),
  run({ id: 'run-4', outcome: 'skipped', reason: 'weekend', summary: 'skipped: weekend', automation: { id: 'watcher.9999abcd', name: 'watcher' } }),
];

function index(): AutomationIndex {
  const a = { ...sampleSummary(sampleFields({ name: 'daily-digest' })), id: 'daily-digest.1234abcd' };
  const b = { ...sampleSummary(sampleFields({ name: 'nightly' })), id: 'nightly.5678abcd' };
  return { groups: [{ id: 'g', scope: 'user', title: 'USER', rootLabel: '~', automations: [b, a] }], generatedAt: '' };
}

function client(page: Partial<HistoryData> = {}) {
  const history = vi.fn(async () => ({ runs: RUNS, limit: 200, more: false, ...page }));
  return { c: { history } as unknown as ManagerClient, history };
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('HistoryPage', () => {
  it('leads every run with its message and its links as buttons, then whose it is, how it went and when', async () => {
    window.history.replaceState(null, '', '/history');
    const { c } = client();
    render(<HistoryPage client={c} index={index()} />);

    const list = await screen.findByRole('list', { name: 'Runs' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);

    const first = rows[0] as HTMLElement;
    expect(within(first).getByText('2 PRs')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Canvas digest ↗' })).toHaveAttribute('href', 'https://example.com/d/1');
    expect(within(first).getByRole('link', { name: 'PR #12 ↗' })).toHaveAttribute('target', '_blank');
    expect(within(first).queryByRole('link', { name: /sneaky/ })).toBeNull();
    const open = within(first).getByRole('link', { name: /daily-digest, ok, .*: open the run/ });
    expect(open).toHaveAttribute('href', '/automations/daily-digest.1234abcd?tab=runs&run=run-1');
    expect(open).toHaveTextContent('daily-digest');
    expect(open).toHaveTextContent('1:00');
    // The message comes before the automation's name.
    expect((first.textContent ?? '').indexOf('Digest is up')).toBeLessThan((first.textContent ?? '').indexOf('daily-digest'));

    // No message: its notes, and their links; no notes either: what it said.
    const second = rows[1] as HTMLElement;
    expect(within(second).getByText('Drafted the report')).toBeInTheDocument();

    expect(within(second).getByRole('link', { name: 'draft ↗' })).toHaveAttribute('href', 'https://example.com/draft');
    expect(within(rows[2] as HTMLElement).getByText('Nothing new')).toHaveClass('am-history-row__reply');
    // A run that said nothing gets no words made up for it.
    expect(within(rows[3] as HTMLElement).getByText('No message.')).toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).queryByText(/weekend/)).toBeNull();
  });

  it('asks the server again for each filter, and keeps them in the address', async () => {
    window.history.replaceState(null, '', '/history');
    const { c, history } = client({ more: true, limit: 3 });
    render(<HistoryPage client={c} index={index()} />);
    await screen.findByRole('list', { name: 'Runs' });
    expect(history).toHaveBeenLastCalledWith({ message: false });
    expect(screen.getByText(/Showing the newest 3/)).toBeInTheDocument();

    const automation = screen.getByRole('combobox', { name: 'Automation' });
    expect(within(automation).getAllByRole('option').map((o) => o.textContent)).toEqual(['All automations', 'daily-digest', 'nightly']);
    await userEvent.selectOptions(automation, 'nightly.5678abcd');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Outcome' }), 'failed');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only runs with a message or notes' }));
    await waitFor(() => expect(history).toHaveBeenLastCalledWith({ automation: 'nightly.5678abcd', outcome: 'failed', message: true }));
    expect(window.location.pathname + window.location.search).toBe('/history?automation=nightly.5678abcd&outcome=failed&message=1');
  });

  it('says when nothing matches', async () => {
    window.history.replaceState(null, '', '/history?message=1');
    const { c, history } = client({ runs: [] });
    render(<HistoryPage client={c} index={null} />);
    expect(await screen.findByText('No runs match.')).toBeInTheDocument();
    expect(history).toHaveBeenLastCalledWith({ message: true });
    expect(screen.getByRole('checkbox', { name: 'Only runs with a message or notes' })).toBeChecked();
  });

  it('says when the server could not answer', async () => {
    const c = { history: vi.fn(async () => { throw new Error('the server did not answer'); }) } as unknown as ManagerClient;
    render(<HistoryPage client={c} index={null} />);
    expect(await screen.findByText('the server did not answer')).toBeInTheDocument();
  });
});
