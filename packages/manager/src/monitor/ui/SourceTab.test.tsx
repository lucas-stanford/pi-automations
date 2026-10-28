import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseFlowMermaid } from '../flowMermaid';
import { SourceTab } from './SourceTab';
import { sampleBundle, sampleCompose, sampleDraft, sampleFields } from './testHelpers';

vi.mock('./MermaidPreview', () => ({ MermaidPreview: () => null }));

function chartEdited() {
  const fields = sampleFields();
  const parsed = parseFlowMermaid('flowchart TD\n  pre0["Prepare"] --> body["Body"]\n');
  if (!parsed.ok) throw new Error(parsed.reason);
  return { fields, draft: { ...sampleDraft(fields), flowModel: parsed.model, flowTouched: true, dirty: true } };
}

describe('SourceTab', () => {
  it('shows the text being typed, not the composed text a round trip behind, after a chart edit', () => {
    const { fields, draft } = chartEdited();
    const compose = { ...sampleCompose(fields), automationText: 'composed a round trip ago' };
    render(<SourceTab bundle={sampleBundle(fields)} draft={{ ...draft, automationText: 'typed by hand' }} setDraft={vi.fn()} compose={compose} theme="dark" />);
    const source = screen.getByLabelText('AUTOMATION.md source');
    expect(source.textContent).toContain('typed by hand');
    expect(source.textContent).not.toContain('composed a round trip ago');
  });

  it('shows what a save would write, the new chart included, when only the chart changed', () => {
    const { fields, draft } = chartEdited();
    const compose = { ...sampleCompose(fields), automationText: 'composed with the chart' };
    render(<SourceTab bundle={sampleBundle(fields)} draft={draft} setDraft={vi.fn()} compose={compose} theme="dark" />);
    expect(screen.getByLabelText('AUTOMATION.md source').textContent).toContain('composed with the chart');
    expect(screen.getByText('Saved in AUTOMATION.md as a ```mermaid block.')).toBeInTheDocument();
  });
});
