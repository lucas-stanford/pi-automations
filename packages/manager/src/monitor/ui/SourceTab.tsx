import type { AutomationBundle, ComposeResult } from '../../host/contract';
import { parseFlowMermaid } from '../flowMermaid';
import { flowTextAfterSave, toMonitorDraft, type MonitorDraftState } from '../draft';
import type { ResolvedTheme } from '../../theme/useTheme';
import { Button } from './Button';
import { CodeEditor } from './CodeEditor';
import { MermaidPreview } from './MermaidPreview';

export function SourceTab({ bundle, draft, setDraft, compose, theme }: { bundle: AutomationBundle; draft: MonitorDraftState; setDraft: (draft: MonitorDraftState) => void; compose: ComposeResult | null; theme: ResolvedTheme }) {
  const sentDraft = toMonitorDraft(draft);
  const sendsChart = sentDraft.flowText !== undefined;
  // While the user edits the text, show their own text: the editor resets to this value, so the
  // composed text, a round trip behind, would undo their typing. Otherwise show what a save
  // would write, the new chart included.
  const automationText = draft.automationText ?? compose?.automationText ?? bundle.files.automation.text;
  // Exactly what a save leaves as the chart — an untouched older flow.mmd keeps its own text and layout.
  const flowText = flowTextAfterSave(draft, bundle.flow.text ?? bundle.files.flow?.text ?? null);
  const generated = compose?.generatedFlow ?? bundle.flow.generated;
  const olderLayoutUnedited = Boolean(bundle.files.flow) && !sendsChart;
  const flowNote = olderLayoutUnedited
    ? 'Still in flow.mmd (the older layout). Your next chart edit moves it into AUTOMATION.md.'
    : 'Saved in AUTOMATION.md as a ```mermaid block.';
  const editFlow = (value: string) => {
    const parsed = parseFlowMermaid(value);
    setDraft({ ...draft, flowText: value, flowModel: parsed.ok ? parsed.model : null, flowRawReason: parsed.ok ? undefined : `${parsed.reason} at ${parsed.line}:${parsed.column}`, flowTouched: true, dirty: true });
  };
  return (
    <div className="am-split">
      <section className="am-panel">
        <header className="am-panel__header">
          <h2>AUTOMATION.md</h2>
          <Button type="button" onClick={() => setDraft({ ...draft, automationText, dirty: true })}>Edit as text</Button>
        </header>
        <div className="am-panel__body am-editor-pane">
          <CodeEditor label="AUTOMATION.md source" language="markdown" value={automationText} onChange={(value) => setDraft({ ...draft, automationText: value, dirty: true })} />
        </div>
      </section>
      <section className="am-panel">
        <header className="am-panel__header">
          <h2>Flowchart</h2>
          {flowText === null ? (
            generated && <Button type="button" onClick={() => editFlow(generated)}>Customize as text</Button>
          ) : (
            <Button type="button" onClick={() => setDraft({ ...draft, flowText, flowModel: null, flowTouched: true, dirty: true })}>Edit as text</Button>
          )}
        </header>
        {flowText === null ? (
          <>
            <p className="am-panel__note">
              No flowchart, and saving adds none. A tracked run gets this chart, made from the hooks and the body:
            </p>
            <div className="am-panel__body am-editor-pane">
              <CodeEditor label="Generated chart" language="mermaid" value={generated ?? ''} readOnly />
            </div>
            {generated && <div className="am-panel__body am-preview-pane"><MermaidPreview text={generated} theme={theme} /></div>}
          </>
        ) : (
          <>
            <p className="am-panel__note">{flowNote}</p>
            <div className="am-panel__body am-editor-pane">
              <CodeEditor label="Flowchart source" language="mermaid" value={flowText} onChange={editFlow} />
            </div>
            {flowText && <div className="am-panel__body am-preview-pane"><MermaidPreview text={flowText} theme={theme} /></div>}
          </>
        )}
      </section>
    </div>
  );
}
