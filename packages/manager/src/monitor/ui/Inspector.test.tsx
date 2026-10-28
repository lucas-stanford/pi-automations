import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AutomationSettings, HookInspector, Inspector } from './Inspector';
import { sampleCompose, sampleDraft, sampleFields, sampleModelChoices } from './testHelpers';

describe('AutomationSettings', () => {
  it('updates draft fields and renders cron problems under the cron field', async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    const draft = sampleDraft();
    render(
      <AutomationSettings
        draft={draft}
        setDraft={setDraft}
        compose={sampleCompose()}
        models={sampleModelChoices()}
        problems={[{ file: 'AUTOMATION.md', field: 'on.schedule.cron', severity: 'error', message: 'on.schedule.cron: invalid cron' }]}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('Coordinate status-note subagents.'), { target: { value: 'Updated description' } });
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fields: expect.objectContaining({ description: 'Updated description' }), dirty: true }));

    fireEvent.change(screen.getByDisplayValue('anthropic/claude-sonnet-4-5:low'), { target: { value: 'openai/gpt-5' } });
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fields: expect.objectContaining({ model: 'openai/gpt-5' }) }));

    fireEvent.change(screen.getByDisplayValue('10m'), { target: { value: '1h' } });
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fields: expect.objectContaining({ timeout: '1h' }) }));

    fireEvent.change(screen.getByDisplayValue('0 9 * * 1-5'), { target: { value: '0 7 * * *' } });
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fields: expect.objectContaining({ on: expect.objectContaining({ schedule: expect.objectContaining({ cron: '0 7 * * *' }) }) }) }));

    fireEvent.change(screen.getByDisplayValue('America/Los_Angeles'), { target: { value: 'UTC' } });
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fields: expect.objectContaining({ on: expect.objectContaining({ schedule: expect.objectContaining({ timezone: 'UTC' }) }) }) }));

    await user.selectOptions(screen.getByDisplayValue('skip'), 'once');
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ fields: expect.objectContaining({ on: expect.objectContaining({ schedule: expect.objectContaining({ catchUp: 'once' }) }) }) }));
    expect(screen.getByText('on.schedule.cron: invalid cron')).toBeInTheDocument();
    expect(screen.getByLabelText('Scheduled for').children).toHaveLength(3);
    expect(screen.getByPlaceholderText('host default')).toBeInTheDocument();
  });

  it('turns a watch on with a starting script, edits it, shows its last check and turns it off', async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    const props = { setDraft, compose: sampleCompose(), models: sampleModelChoices() };
    const { rerender } = render(<AutomationSettings {...props} draft={sampleDraft()} problems={[]} />);

    expect(screen.queryByText('Watch script')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Watch' }));
    expect(setDraft.mock.lastCall![0].fields.on).toEqual(expect.objectContaining({ manual: true, watch: { script: 'scripts/watch.js', every: '5m' } }));

    const watched = sampleDraft(sampleFields({ on: { manual: true, watch: { script: 'scripts/watch.js', every: '5m' } } }));
    const checkedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    rerender(
      <AutomationSettings
        {...props}
        draft={watched}
        problems={[{ file: 'AUTOMATION.md', field: 'on.watch.every', severity: 'error', message: 'on.watch.every: 30s is shorter than a minute' }]}
        watchStatus={{ lastCheck: { checkedAt, exit: 3, durationMs: 900, said: 'nothing due' }, nextCheck: new Date(Date.now() + 2 * 60_000 + 5_000).toISOString() }}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Watch' })).toBeChecked();
    fireEvent.change(screen.getByDisplayValue('scripts/watch.js'), { target: { value: 'scripts/look.js' } });
    expect(setDraft.mock.lastCall![0].fields.on.watch).toEqual({ script: 'scripts/look.js', every: '5m' });
    fireEvent.change(screen.getByDisplayValue('5m'), { target: { value: '15m' } });
    expect(setDraft.mock.lastCall![0].fields.on.watch).toEqual({ script: 'scripts/watch.js', every: '15m' });
    expect(screen.getByText('on.watch.every: 30s is shorter than a minute')).toBeInTheDocument();
    expect(screen.getByText('Checked 3m ago · exit 3 · nothing due · next check in 2m')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Watch' }));
    expect(setDraft.mock.lastCall![0].fields.on.watch).toBeUndefined();
    expect(setDraft.mock.lastCall![0].fields.on.manual).toBe(true);
  });

  it('says a watch that never ran has not been checked, and how checks get run', () => {
    const watched = sampleDraft(sampleFields({ on: { manual: false, watch: { script: 'scripts/watch.js', every: '5m' } } }));
    render(<AutomationSettings draft={watched} setDraft={vi.fn()} compose={sampleCompose()} models={sampleModelChoices()} problems={[]} />);
    expect(screen.getByText(/^Not checked yet. .*the watcher is on \(pa watcher start\)/)).toBeInTheDocument();
  });
});

describe('Inspector', () => {
  it('opens Automation settings for a trigger node, and edits a chart step called watch as a step', () => {
    const fields = sampleFields({ on: { manual: false, watch: { script: 'scripts/watch.js', every: '5m' } } });
    const draft = sampleDraft(fields);
    draft.flowModel = { ...draft.flowModel!, nodes: [...draft.flowModel!.nodes, { id: 'watch', label: 'Watch CI', shape: 'rect' }] };
    const props = { draft, setDraft: vi.fn(), compose: sampleCompose(), problems: [], models: sampleModelChoices() };
    const { rerender } = render(<Inspector {...props} selection={{ type: 'node', id: 'trigger:watch' }} />);
    expect(screen.getByRole('checkbox', { name: 'Watch' })).toBeChecked();

    rerender(<Inspector {...props} selection={{ type: 'node', id: 'watch' }} />);
    expect(screen.getByText('Step')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Watch CI')).toBeInTheDocument();
  });
});

describe('HookInspector', () => {
  it('moves and deletes hooks while updating positional chart nodes', async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    const fields = sampleFields();
    const draft = sampleDraft(fields);
    const node = draft.flowModel!.nodes.find((item) => item.id === 'pre1')!;
    const { rerender } = render(<HookInspector draft={draft} setDraft={setDraft} node={node} />);

    expect(screen.getByText('PRE HOOK · pre1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move up' }));
    const moved = setDraft.mock.lastCall![0];
    expect(moved.fields.hooks.pre[0]).toEqual({ prompt: 'Collect context' });
    expect(moved.flowModel.nodes.find((item: { id: string; label: string }) => item.id === 'pre0')?.label).toContain('Collect context');

    rerender(<HookInspector draft={moved} setDraft={setDraft} node={moved.flowModel.nodes.find((item: { id: string }) => item.id === 'pre0')!} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const deleted = setDraft.mock.lastCall![0];
    expect(deleted.fields.hooks.pre).toHaveLength(1);
    expect(deleted.flowModel.nodes.some((item: { id: string }) => item.id === 'pre1')).toBe(false);
    expect(deleted.flowModel.edges.some((edge: { source: string; target: string }) => edge.source === 'pre0' && edge.target === 'body')).toBe(true);
  });
});
