import { useEffect, useMemo, useState } from 'react';
import type { FileContent, FileEntry, FileListing } from '../../host/contract';
import { ManagerClient, ManagerError } from '../../host/client';
import type { ResolvedTheme } from '../../theme/useTheme';
import { Button } from './Button';
import { CodeEditor } from './CodeEditor';
import { MermaidPreview } from './MermaidPreview';

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function restoreEol(text: string, eol: '\r\n' | '\n'): string {
  return eol === '\n' ? text.replace(/\r\n/g, '\n') : text.replace(/\r?\n/g, '\r\n');
}

function roleBadge(entry: FileEntry): string | undefined {
  if (entry.role === 'automation' || entry.role === 'flow') return '→ Source';
  if (entry.role === 'hook-script') return 'hook script';
  return undefined;
}

export function FilesTab({ client, id, theme, onOpenSource }: { client: ManagerClient; id: string; theme: ResolvedTheme; onOpenSource: () => void }) {
  const [listing, setListing] = useState<FileListing | null>(null);
  const [children, setChildren] = useState<Record<string, FileListing>>({});
  const [selected, setSelected] = useState<FileContent | null>(null);
  const [text, setText] = useState('');
  const [eol, setEol] = useState<'\r\n' | '\n'>('\n');
  const [message, setMessage] = useState('');
  const dirty = selected ? text !== selected.text : false;
  const entries = useMemo(() => listing?.entries ?? [], [listing]);

  useEffect(() => {
    void client.files(id).then(setListing).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Could not load files'));
  }, [client, id]);

  const open = (entry: FileEntry) => {
    if (entry.role === 'automation' || entry.role === 'flow') {
      onOpenSource();
      return;
    }
    if (entry.kind === 'dir') {
      if (children[entry.path]) {
        setChildren((current) => {
          const next = { ...current };
          delete next[entry.path];
          return next;
        });
      } else {
        void client.files(id, entry.path).then((value) => setChildren((current) => ({ ...current, [entry.path]: value }))).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Could not load folder'));
      }
      return;
    }
    void client.file(id, entry.path).then((file) => {
      setSelected(file);
      setText(file.text);
      setEol(detectEol(file.text));
      setMessage('');
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Could not load file'));
  };

  const save = () => {
    if (!selected) return;
    void client.writeFile(id, selected.path, { text: restoreEol(text, eol), base: selected.revision, bom: selected.bom })
      .then((result) => {
        setSelected(result.file);
        setText(result.file.text);
        setMessage('Saved');
      })
      .catch((error: unknown) => {
        if (error instanceof ManagerError && error.status === 409) setMessage('Changed on disk — reload this file before saving.');
        else setMessage(error instanceof Error ? error.message : 'Save failed');
      });
  };

  return (
    <div className="am-files-grid">
      <section className="am-panel">
        <header className="am-panel__header">
          <h2>Files</h2>
          <Button type="button" onClick={() => {
            const path = window.prompt('New file path');
            if (!path) return;
            setSelected({ path, text: '', bom: false, revision: '', bytes: 0, updatedAt: null, language: 'text' });
            setText('');
            setMessage('New file. Save creates it.');
          }}>New file</Button>
        </header>
        <div className="am-panel__body">
          <div className="am-file-tree">
            {entries.map((entry) => (
              <div key={entry.path}>
                <button type="button" className="am-file-row" aria-current={selected?.path === entry.path ? 'true' : undefined} aria-expanded={entry.kind === 'dir' ? Boolean(children[entry.path]) : undefined} onClick={() => open(entry)}>
                  <span>{entry.kind === 'dir' ? (children[entry.path] ? '▾' : '▸') : '•'}</span>
                  <span title={entry.path}>{entry.path}</span>
                  {roleBadge(entry) && <span className="am-badge">{roleBadge(entry)}</span>}
                  <span className="am-muted">{entry.kind === 'file' ? `${entry.bytes} B` : ''}</span>
                </button>
                {children[entry.path]?.entries.map((child) => (
                  <button type="button" key={child.path} className="am-file-row am-file-row--child" aria-current={selected?.path === child.path ? 'true' : undefined} onClick={() => open(child)}>
                    <span>{child.kind === 'dir' ? '▸' : '•'}</span>
                    <span title={child.path}>{child.name}</span>
                    {roleBadge(child) && <span className="am-badge">{roleBadge(child)}</span>}
                    <span className="am-muted">{child.kind === 'file' ? `${child.bytes} B` : ''}</span>
                  </button>
                ))}
              </div>
            ))}
            {listing?.skipped.map((entry) => <p key={entry.name} className="am-muted">{entry.name} skipped — {entry.reason}</p>)}
          </div>
        </div>
      </section>
      <section className="am-panel">
        <header className="am-panel__header">
          <h2>{selected?.path ?? 'Select a text file'}</h2>
          {selected && <div className="am-button-row"><Button type="button" variant="primary" disabled={!dirty} onClick={save}>Save file</Button><Button type="button" disabled={!dirty} onClick={() => setText(selected.text)}>Revert</Button></div>}
        </header>
        {message && <div className="am-banner am-banner--info">{message}</div>}
        {selected && (
          <>
            <div className="am-panel__body am-editor-pane">
              <CodeEditor label={`${selected.path} editor`} language={selected.language} value={text} onChange={setText} />
            </div>
            {selected.language === 'mermaid' && <div className="am-panel__body am-preview-pane"><MermaidPreview text={text} theme={theme} /></div>}
          </>
        )}
      </section>
    </div>
  );
}
