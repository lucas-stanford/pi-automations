import type { MonitorDraftState } from '../draft';
import { CodeEditor } from './CodeEditor';
import { MarkdownView } from './MarkdownView';

export function InstructionsTab({ draft, setDraft }: { draft: MonitorDraftState; setDraft: (draft: MonitorDraftState) => void }) {
  const body = draft.fields?.body ?? '';
  return (
    <div className="am-split">
      <section className="am-panel">
        <header className="am-panel__header"><h2>Body</h2></header>
        <div className="am-panel__body am-editor-pane">
          <CodeEditor label="Body" language="markdown" value={body} onChange={(value) => draft.fields && setDraft({ ...draft, fields: { ...draft.fields, body: value }, dirty: true })} />
        </div>
      </section>
      <section className="am-panel">
        <header className="am-panel__header"><h2>Preview</h2></header>
        <div className="am-panel__body am-preview-pane">
          <MarkdownView text={body} />
        </div>
      </section>
    </div>
  );
}

