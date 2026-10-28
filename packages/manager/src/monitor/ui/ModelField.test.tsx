import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelField, modelListNote, modelOptionLabel, modelOptionLabels } from './ModelField';
import { sampleModelChoices, sampleModelList } from './testHelpers';

describe('ModelField', () => {
  it("offers pi's models with their names, and edits the value", () => {
    const onChange = vi.fn();
    const { container } = render(<ModelField value="anthropic/claude-sonnet-4-5:low" onChange={onChange} choices={sampleModelChoices()} problems={[]} />);
    const options = [...container.querySelectorAll('datalist option')].map((option) => [option.getAttribute('value'), option.getAttribute('label')]);
    expect(options).toEqual([
      ['anthropic/claude-opus-4-1', 'Claude Opus 4.1 · enabled in pi'],
      ['anthropic/claude-sonnet-4-5:low', 'anthropic/claude-sonnet-4-5:low · used by an automation'],
      ['openai/gpt-5', 'GPT-5 · available in pi'],
    ]);
    const input = screen.getByLabelText('Model');
    expect(input.getAttribute('list')).toBe(container.querySelector('datalist')?.id);
    fireEvent.change(input, { target: { value: 'openai/gpt-5' } });
    expect(onChange).toHaveBeenLastCalledWith('openai/gpt-5');
  });

  it('reads the list again from pi when refresh is pressed, and says so while it does', () => {
    const refresh = vi.fn();
    const { rerender } = render(<ModelField value="" onChange={() => undefined} choices={sampleModelChoices({ refresh })} problems={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the model list from pi' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<ModelField value="" onChange={() => undefined} choices={sampleModelChoices({ refresh, refreshing: true })} problems={[]} />);
    expect(screen.getByRole('button', { name: 'Refresh the model list from pi' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Reading the models pi can run');
  });

  it('says why the list is short, and shows model problems under the field', () => {
    render(
      <ModelField
        value="nope/model"
        onChange={() => undefined}
        choices={sampleModelChoices({ list: sampleModelList({ error: 'pi needs Node 22.19.0 or newer, and this is Node 20.12.1' }) })}
        problems={[{ file: 'AUTOMATION.md', field: 'model', severity: 'error', message: 'model: unknown provider "nope"' }]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent("Could not read pi's models: pi needs Node 22.19.0 or newer");
    expect(screen.getByText('model: unknown provider "nope"')).toBeInTheDocument();
  });

  it('describes where the list came from', () => {
    expect(modelListNote(sampleModelList({ readAt: null }), false)).toBe('Only models automations already use.');
    expect(modelListNote(sampleModelList(), false)).toMatch(/^3 models from pi, read at /);
    expect(modelOptionLabel({ value: 'a/b', source: 'available' })).toBe('a/b · available in pi');
    // Firefox shows only the label, so thinking levels and same-named models must still differ.
    expect(modelOptionLabels([
      { value: 'p/sonnet:low', name: 'Sonnet', source: 'automation' },
      { value: 'p/sonnet:high', name: 'Sonnet', source: 'automation' },
      { value: 'p/opus', name: 'Opus', source: 'available' },
      { value: 'q/opus', name: 'Opus', source: 'available' },
    ])).toEqual(['Sonnet (low) · used by an automation', 'Sonnet (high) · used by an automation', 'p/opus · available in pi', 'q/opus · available in pi']);
  });
});
