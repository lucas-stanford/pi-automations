import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { Problem } from '../../host/contract';
import { ProblemsPanel } from './ProblemsPanel';
import { TabBar } from './TabBar';

const problems: Problem[] = [
  { file: 'flow.mmd', line: 3, severity: 'warning', message: 'flow.mmd: no node "body"' },
  { file: 'AUTOMATION.md', field: 'model', severity: 'info', message: 'model not checked' },
];

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <TabBar tab="flow" problems={problems.length} problemsOpen={open} onToggleProblems={() => setOpen((value) => !value)} onChange={() => undefined} />
      <ProblemsPanel problems={problems} open={open} />
    </>
  );
}

describe('Problems', () => {
  it('lists each problem on one line and is shown and hidden from the tab bar', () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: /Problems/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Problems' });
    expect(toggle).toHaveAttribute('aria-controls', list.id);
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(list.querySelector('li')).toHaveTextContent('warningflow.mmd:3flow.mmd: no node "body"');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Problems' })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('list', { name: 'Problems' })).toBeInTheDocument();
  });

  it('shows nothing when there is nothing to show', () => {
    render(<ProblemsPanel problems={[]} open />);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says so, instead of offering a button that does nothing, when there are no problems', () => {
    render(<TabBar tab="flow" problems={0} problemsOpen onToggleProblems={() => undefined} onChange={() => undefined} />);
    expect(screen.queryByRole('button', { name: /Problems/ })).toBeNull();
    expect(screen.getByText('No problems')).toBeInTheDocument();
  });
});
