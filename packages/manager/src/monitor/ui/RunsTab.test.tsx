import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationBundle, LiveProgress, RunSummary } from '../../host/contract';
import type { ManagerClient } from '../../host/client';
import { RunsTab } from './RunsTab';
import { sampleBundle } from './testHelpers';

const chart = 'flowchart TD\n  body["Verify"] --> publish["Publish"]\n  body -->|nothing new| done["Done"]\n';

function finishedRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    trigger: 'manual',
    outcome: 'ok',
    recordedAt: '2026-10-21T10:01:00.000Z',
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:01:00.000Z',
    durationMs: 60_000,
    summary: 'Published the digest',
    hooks: [],
    chart,
    steps: [
      { id: 'body', label: 'Verify', status: 'done' },
      { id: 'publish', label: 'Publish', status: 'done', text: 'posted to the channel' },
      { id: 'done', label: 'Done', status: 'pending' },
    ],
    taken: [['body', 'publish']],
    notes: [
      {
        ts: '2026-10-21T10:00:30.000Z',
        text: 'Opened **the PR**, see [the diff](https://example.com/diff) and [this](javascript:alert(1)).',
        links: [
          { label: 'PR #12', url: 'https://example.com/pr/12' },
          { url: 'ftp://example.com/file' },
        ],
      },
    ],
    ...overrides,
  };
}

function client(progress?: LiveProgress): ManagerClient {
  return {
    bundle: vi.fn(() => new Promise(() => {})),
    progress: vi.fn(() => (progress ? Promise.resolve(progress) : Promise.reject(new Error('404')))),
  } as unknown as ManagerClient;
}

function bundleWith(runs: RunSummary[], running?: AutomationBundle['summary']['running']): AutomationBundle {
  const b = sampleBundle();
  return { ...b, runs, summary: { ...b.summary, ...(running ? { running } : {}) } };
}

describe('RunsTab', () => {
  it("draws a finished run's steps and shows its notes with safe links", () => {
    render(<RunsTab bundle={bundleWith([finishedRun()])} client={client()} id="flow-example.12345678" onRuns={() => undefined} />);

    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'body Verifydone',
      'publish Publishdoneposted to the channel',
      'done Donenot reached',
    ]);
    expect(screen.getByRole('img', { name: 'The run on its flowchart' })).toBeInTheDocument();

    expect(screen.getByText('the PR')).toBeInTheDocument();
    const diff = screen.getByRole('link', { name: 'the diff' });
    expect(diff).toHaveAttribute('href', 'https://example.com/diff');
    expect(diff).toHaveAttribute('target', '_blank');
    expect(diff).toHaveAttribute('rel', 'noreferrer');
    // Only http and https become links.
    expect(screen.queryByRole('link', { name: 'this' })).toBeNull();
    expect(screen.getByText('this')).toBeInTheDocument();
    const pr = screen.getByRole('link', { name: 'PR #12 ↗' });
    expect(pr).toHaveAttribute('href', 'https://example.com/pr/12');
    expect(pr).toHaveAttribute('rel', 'noreferrer');
    expect(screen.queryByRole('link', { name: /ftp:/ })).toBeNull();
    expect(screen.getByText('ftp://example.com/file')).toBeInTheDocument();
  });

  it('says so for a run that was not tracked, and shows plugin problems without hiding the run', () => {
    render(
      <RunsTab
        bundle={bundleWith([finishedRun({ chart: undefined, steps: undefined, taken: undefined, notes: [], pluginProblems: ['plugin probe: observer broke'] })])}
        client={client()}
        id="x"
        onRuns={() => undefined}
      />,
    );
    expect(screen.getByText('This run was not tracked on a flowchart.')).toBeInTheDocument();
    expect(screen.getByText('No notes.')).toBeInTheDocument();
    // No output either: no message is made up from its summary, which still shows on its own.
    expect(within(screen.getByRole('region', { name: 'Message' })).getByText('No message.')).toBeInTheDocument();
    expect(screen.getByText('Published the digest', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('plugin probe: observer broke')).toBeInTheDocument();
  });

  it("follows a running run's live progress, and switches to a finished one", async () => {
    const live: LiveProgress = {
      runId: 'run-live',
      key: 'k',
      name: 'flow-example',
      chart,
      steps: [
        { id: 'body', label: 'Verify', status: 'done' },
        { id: 'publish', label: 'Publish', status: 'active', text: 'publishing' },
        { id: 'done', label: 'Done', status: 'pending' },
      ],
      taken: [['body', 'publish']],
      notes: [{ ts: '2026-10-21T10:00:30.000Z', text: 'Draft is up', links: [{ label: 'draft', url: 'https://example.com/draft' }] }],
      closed: false,
    };
    const c = client(live);
    render(<RunsTab bundle={bundleWith([finishedRun()], { runId: 'run-live', pid: 1, startedAt: new Date().toISOString() })} client={c} id="flow-example.12345678" onRuns={() => undefined} />);

    expect(await screen.findByText('Draft is up')).toBeInTheDocument();
    expect(c.progress).toHaveBeenCalledWith('flow-example.12345678', 'run-live');
    expect(within(screen.getByRole('list', { name: 'Steps' })).getByText('running')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'draft ↗' })).toHaveAttribute('href', 'https://example.com/draft');

    await userEvent.click(screen.getByRole('button', { name: /ok manual/ }));
    expect(screen.getByText('Opened', { exact: false })).toBeInTheDocument();
  });

  it("leads the detail with the run's message, its links as buttons, above the flowchart and its notes", () => {
    const message = {
      ts: '2026-10-21T10:00:50.000Z',
      text: 'Digest is up. **2 PRs** wait on you.',
      links: [
        { label: 'Canvas digest', url: 'https://example.com/d/1' },
        { label: 'bad', url: 'javascript:alert(1)' },
      ],
    };
    const { container } = render(<RunsTab bundle={bundleWith([finishedRun({ message })])} client={client()} id="x" onRuns={() => undefined} />);

    const detail = container.querySelector('.am-run-detail') as HTMLElement;
    const headings = within(detail).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(0, 3)).toEqual(['Message', 'Flowchart', 'Notes']);
    const section = within(detail).getByRole('region', { name: 'Message' });
    expect(within(section).getByText('2 PRs')).toBeInTheDocument();
    const chip = within(section).getByRole('link', { name: 'Canvas digest ↗' });
    expect(chip).toHaveAttribute('href', 'https://example.com/d/1');
    expect(chip).toHaveAttribute('rel', 'noreferrer');
    expect(within(section).queryByRole('link', { name: /bad/ })).toBeNull();
    expect(within(section).getByText('bad')).toBeInTheDocument();
    // The summary still says what it produced, quietly, under the message.
    expect(within(detail).getByText('Published the digest')).toBeInTheDocument();

    // The run's row reads its message first, with how many links it left.
    expect(screen.getByRole('button', { name: /ok manual/ })).toHaveTextContent('Digest is up. 2 PRs wait on you. · 2 links');
  });

  it('shows its notes as the message when it left none, and only once', () => {
    render(<RunsTab bundle={bundleWith([finishedRun()])} client={client()} id="x" onRuns={() => undefined} />);
    const section = screen.getByRole('region', { name: 'Message' });
    expect(within(section).getByText('No message; these are its notes.')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'PR #12 ↗' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Notes' })).toBeNull();
  });

  it('opens the run History asked for, and says so when it is older than the list', () => {
    const older = finishedRun({ id: 'run-0', recordedAt: '2026-10-20T10:01:00.000Z', summary: 'An older run', notes: [] });
    render(<RunsTab bundle={bundleWith([finishedRun(), older])} client={client()} id="x" onRuns={() => undefined} initialRun="run-0" />);
    expect(screen.getByRole('button', { name: /An older run/ })).toHaveAttribute('aria-current', 'true');

    cleanup();
    render(<RunsTab bundle={bundleWith([finishedRun()])} client={client()} id="x" onRuns={() => undefined} initialRun="run-gone" />);
    expect(screen.getByText(/older than the twenty shown here/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/history');
  });
});