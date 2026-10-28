import { useEffect, useRef } from 'react';
import { Button } from './Button';
import { CodeEditor } from './CodeEditor';

export function DiffDrawer({ diff, open, onClose }: { diff: string; open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [onClose, open]);
  if (!open) return null;
  return (
    <aside className="am-diff-drawer" role="dialog" aria-modal="true" aria-labelledby="am-diff-title">
      <header>
        <h2 id="am-diff-title">Review changes</h2>
        <Button ref={closeRef} type="button" onClick={onClose}>Close</Button>
      </header>
      <CodeEditor label="Unified diff" language="diff" value={diff} readOnly />
    </aside>
  );
}
