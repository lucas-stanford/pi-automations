import { createTwoFilesPatch } from 'diff';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Problem } from '../../host/contract';
import { diffFor } from '../MonitorApp';
import { ConflictBanner, InvalidBanner } from './Banners';
import { AutomationHeader } from './AutomationHeader';
import { DiffDrawer } from './DiffDrawer';
import { SaveBar } from './SaveBar';
import { sampleBundle, sampleCompose, sampleDraft } from './testHelpers';

function SaveHarness({ save }: { save: (request: object) => void }) {
  const problems: Problem[] = [{ file: 'AUTOMATION.md', field: 'description', severity: 'error', message: 'description: too long' }];
  return (
    <>
      <SaveBar dirty status="Changed on disk" onSave={() => save({ allowInvalid: false })} onRevert={() => {}} onReview={() => {}} />
      <ConflictBanner onReload={() => {}} onReview={() => {}} onOverwrite={() => save({ base: { automation: 'sha256:current', flow: null }, allowInvalid: false })} />
      <InvalidBanner problems={problems} onSaveAnyway={() => save({ allowInvalid: true })} />
    </>
  );
}

describe('SaveBar and banners', () => {
  it('renders 409/422 actions and sends overwrite/save-anyway intent', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<SaveHarness save={save} />);
    await user.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(save).toHaveBeenCalledWith({ base: { automation: 'sha256:current', flow: null }, allowInvalid: false });
    expect(screen.getByText(/too long/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    expect(save).toHaveBeenCalledWith({ allowInvalid: true });
  });
});

describe('DiffDrawer', () => {
  it('shows added and removed lines for a changed description', async () => {
    const diff = createTwoFilesPatch('AUTOMATION.md (disk)', 'AUTOMATION.md (draft)', 'description: old\n', 'description: new\n');
    render(<DiffDrawer diff={diff} open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Review changes' })).toBeInTheDocument());
    expect(document.body.textContent).toContain('-description: old');
    expect(document.body.textContent).toContain('+description: new');
  });

  it('shows chart edits in AUTOMATION.md and deletes older flow.mmd in the review diff', () => {
    const bundle = sampleBundle();
    const draft = sampleDraft();
    draft.flowText = 'flowchart TD\n  body["New chart"]\n';
    draft.flowModel = null;
    draft.flowTouched = true;
    const compose = {
      ...sampleCompose(bundle.fields!),
      automationText: `${bundle.files.automation.text}\n\n\`\`\`mermaid\n${draft.flowText}\`\`\`\n`,
      flowText: draft.flowText,
      flowFileText: null,
      changed: { automation: true, flow: true },
    };
    const diff = diffFor(bundle, draft, compose);
    expect(diff).toContain('+```mermaid');
    expect(diff).toContain('+  body["New chart"]');
    expect(diff).toContain('flow.mmd (disk)');
    expect(diff).toContain('-  pre0["Prepare"] --> pre1["Collect"]');
  });
});

describe('AutomationHeader', () => {
  it('shows flowchart for charts sourced from AUTOMATION.md', () => {
    const bundle = sampleBundle();
    bundle.flow.source = 'automation';
    bundle.flow.text = bundle.files.flow!.text;
    bundle.files.flow = null;
    render(<AutomationHeader bundle={bundle} dirty={false} status="" onSave={() => {}} onRevert={() => {}} onReview={() => {}} />);
    expect(screen.getByText(/⋔ flowchart/)).toBeInTheDocument();
  });
});
