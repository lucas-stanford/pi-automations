import { useEffect, useMemo, useRef } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { python } from '@codemirror/legacy-modes/mode/python';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import type { FileLanguage } from '../../host/contract';

function languageExtension(language: FileLanguage | 'diff'): Extension[] {
  if (language === 'javascript') return [javascript()];
  if (language === 'typescript') return [javascript({ typescript: true })];
  if (language === 'json') return [json()];
  if (language === 'yaml') return [yaml()];
  if (language === 'markdown' || language === 'mermaid') return [markdown()];
  if (language === 'python') return [StreamLanguage.define(python)];
  if (language === 'shell' || language === 'powershell') return [StreamLanguage.define(shell)];
  if (language === 'toml') return [StreamLanguage.define(toml)];
  return [];
}

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  label,
  readOnly = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  language?: FileLanguage | 'diff';
  label: string;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const extensions = useMemo<Extension[]>(() => [
    lineNumbers(),
    history(),
    drawSelection(),
    rectangularSelection(),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({
      'aria-label': label,
      ...(readOnly ? { 'aria-readonly': 'true' } : {}),
    }),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
    }),
    EditorView.theme({
      '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--background)', color: 'var(--foreground)' },
      '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.45' },
      '.cm-gutters': { backgroundColor: 'var(--background)', borderRight: '1px solid var(--border)', color: 'var(--muted-foreground)' },
      '.cm-content': { caretColor: 'var(--primary)' },
      '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-2px' },
    }),
    ...languageExtension(language),
  ], [language, readOnly]);

  useEffect(() => {
    if (!host.current) return undefined;
    const editor = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return <div className="am-code-editor" ref={host} />;
}
