import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FileListing } from '../../host/contract';
import type { ManagerClient } from '../../host/client';
import { FilesTab } from './FilesTab';

function client(): ManagerClient {
  const root: FileListing = {
    path: '',
    entries: [
      { name: 'scripts', path: 'scripts', kind: 'dir', bytes: 0, updatedAt: null },
      { name: 'AUTOMATION.md', path: 'AUTOMATION.md', kind: 'file', bytes: 40, updatedAt: null, role: 'automation' },
      { name: 'flow.mmd', path: 'flow.mmd', kind: 'file', bytes: 20, updatedAt: null, role: 'flow' },
    ],
    skipped: [{ name: 'node_modules', reason: 'dependency folder' }],
  };
  const scripts: FileListing = {
    path: 'scripts',
    entries: [{ name: 'prepare.js', path: 'scripts/prepare.js', kind: 'file', bytes: 10, updatedAt: null, role: 'hook-script' }],
    skipped: [],
  };
  return {
    files: vi.fn((_: string, path = '') => Promise.resolve(path === 'scripts' ? scripts : root)),
    file: vi.fn(),
    writeFile: vi.fn(),
  } as unknown as ManagerClient;
}

describe('FilesTab', () => {
  it('expands folders lazily, renders skipped reasons, and routes source files to Source', async () => {
    const user = userEvent.setup();
    const fake = client();
    const onOpenSource = vi.fn();
    render(<FilesTab client={fake} id="flow-example.12345678" theme="dark" onOpenSource={onOpenSource} />);

    expect(await screen.findByRole('button', { name: /scripts/ })).toBeInTheDocument();
    expect(screen.getByText('node_modules skipped — dependency folder')).toBeInTheDocument();
    expect(screen.getAllByText('→ Source')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /scripts/ }));
    await waitFor(() => expect(fake.files).toHaveBeenCalledWith('flow-example.12345678', 'scripts'));
    expect(await screen.findByRole('button', { name: /prepare.js/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /AUTOMATION.md/ }));
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /flow.mmd/ }));
    expect(onOpenSource).toHaveBeenCalledTimes(2);
  });
});

