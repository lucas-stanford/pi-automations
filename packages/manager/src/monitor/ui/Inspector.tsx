import cronstrue from 'cronstrue';
import type { AutomationFields, ComposeResult, Hook, Problem, WatchCheckInfo } from '../../host/contract';
import { deleteHook, deleteHookNode, moveHook, reorderHookNodes, setHook, setNodeLabel, type MonitorDraftState } from '../draft';
import type { EdgeKind, FlowEdgeModel, FlowNodeModel, FlowShape } from '../flowMermaid';
import { Button } from './Button';
import { CodeEditor } from './CodeEditor';
import { Field, TextArea, TextInput } from './Field';
import { formatFuture, lastCheckText } from './format';
import type { Selection } from './FlowCanvas';
import { MarkdownView } from './MarkdownView';
import { ModelField, type ModelChoices } from './ModelField';

const SHAPES: FlowShape[] = ['rect', 'round', 'stadium', 'rhombus', 'hexagon', 'subroutine', 'cylinder', 'circle'];
const EDGE_KINDS: EdgeKind[] = ['arrow', 'open', 'dottedArrow', 'dottedOpen', 'thickArrow', 'thickOpen'];

function hookIndex(id: string): { phase: 'pre' | 'post'; index: number } | null {
  const pre = id.match(/^pre(\d+)$/);
  if (pre) return { phase: 'pre', index: Number(pre[1]) };
  const post = id.match(/^post(\d+)$/);
  if (post) return { phase: 'post', index: Number(post[1]) };
  return null;
}

/** What the tick last saw of this automation's watch, from the saved automation. */
interface WatchStatus {
  lastCheck?: WatchCheckInfo;
  nextCheck?: string;
}

export function AutomationSettings({
  draft,
  setDraft,
  compose,
  problems,
  models,
  watchStatus,
}: {
  draft: MonitorDraftState;
  setDraft: (draft: MonitorDraftState) => void;
  compose: ComposeResult | null;
  problems: Problem[];
  models: ModelChoices;
  watchStatus?: WatchStatus;
}) {
  const fields = draft.fields;
  if (!fields) return <p className="am-muted">AUTOMATION.md is in text mode. Edit it in Source.</p>;
  const { schedule, watch } = fields.on;
  const update = (patch: Partial<AutomationFields>) => setDraft({ ...draft, fields: { ...fields, ...patch }, dirty: true });
  const cronSentence = schedule?.cron ? (() => {
    try {
      return cronstrue.toString(schedule.cron);
    } catch {
      return 'Cron is not valid yet.';
    }
  })() : 'No schedule';
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone').slice(0, 256) : [];
  return (
    <div className="am-inspector-stack">
      <Field label="Name"><TextInput value={fields.name} readOnly className="am-mono" /></Field>
      <Field label="Description" field="description" problems={problems} hint={`${fields.description.length}/1024`}>
        <TextArea value={fields.description} maxLength={1024} rows={4} onChange={(event) => update({ description: event.target.value })} />
      </Field>
      <label className="am-switch"><input type="checkbox" checked={fields.enabled} onChange={(event) => update({ enabled: event.target.checked })} /> Enabled</label>
      <ModelField value={fields.model ?? ''} onChange={(model) => update({ model: model || undefined })} choices={models} problems={problems} />
      <Field label="Timeout" field="timeout" problems={problems} hint="90s · 10m · 1h">
        <TextInput value={fields.timeout ?? ''} pattern="^\d+(s|m|h)$" onChange={(event) => update({ timeout: event.target.value || undefined })} />
      </Field>
      <section className="am-subsection">
        <h3>Triggers</h3>
        <label className="am-switch"><input type="checkbox" checked={fields.on.manual} onChange={(event) => update({ on: { ...fields.on, manual: event.target.checked } })} /> Manual</label>
        <label className="am-switch"><input type="checkbox" checked={Boolean(schedule)} onChange={(event) => update({ on: { ...fields.on, schedule: event.target.checked ? { cron: '0 9 * * 1-5', catchUp: 'skip' } : undefined } })} /> Schedule</label>
        {schedule && (
          <>
            <Field label="Cron" field="on.schedule.cron" problems={problems} hint={cronSentence}>
              <TextInput value={schedule.cron} onChange={(event) => update({ on: { ...fields.on, schedule: { ...schedule, cron: event.target.value } } })} />
            </Field>
            {compose?.nextFires.length ? (
              <ol className="am-next-fires" aria-label="Scheduled for">
                {compose.nextFires.slice(0, 3).map((fire) => <li key={fire}>{new Date(fire).toLocaleString()}</li>)}
              </ol>
            ) : null}
            <Field label="Timezone" field="on.schedule.timezone" problems={problems} hint="Blank uses this machine's time zone.">
              <TextInput list="am-timezones" value={schedule.timezone ?? ''} onChange={(event) => update({ on: { ...fields.on, schedule: { ...schedule, timezone: event.target.value || undefined } } })} />
            </Field>
            <datalist id="am-timezones">{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
            <Field label="Catch-up">
              <select className="am-input" value={schedule.catchUp} onChange={(event) => update({ on: { ...fields.on, schedule: { ...schedule, catchUp: event.target.value as 'skip' | 'once' } } })}>
                <option value="skip">skip</option>
                <option value="once">once</option>
              </select>
            </Field>
          </>
        )}
        <label className="am-switch"><input type="checkbox" checked={Boolean(watch)} onChange={(event) => update({ on: { ...fields.on, watch: event.target.checked ? { script: 'scripts/watch.js', every: '5m' } : undefined } })} /> Watch</label>
        {watch && (
          <>
            <Field label="Watch script" field="on.watch.script" problems={problems} hint="Runs with no model. A run starts when it exits 0 and prints something new.">
              <TextInput className="am-mono" value={watch.script} onChange={(event) => update({ on: { ...fields.on, watch: { ...watch, script: event.target.value } } })} />
            </Field>
            <Field label="Every" field="on.watch.every" problems={problems} hint="1m to 24h · 5m · 1h">
              <TextInput value={watch.every} pattern="^\d+(s|m|h)$" onChange={(event) => update({ on: { ...fields.on, watch: { ...watch, every: event.target.value } } })} />
            </Field>
            <p className="am-muted">{lastCheckText(watchStatus?.lastCheck)}{watchStatus?.nextCheck ? ` · next check ${formatFuture(watchStatus.nextCheck)}` : ''}</p>
          </>
        )}
      </section>
      <section className="am-subsection">
        <h3>Hooks</h3>
        <p className="am-muted">Pre: {fields.hooks.pre.length} · Post: {fields.hooks.post.length}</p>
      </section>
    </div>
  );
}

export function HookInspector({ draft, setDraft, node }: { draft: MonitorDraftState; setDraft: (draft: MonitorDraftState) => void; node: FlowNodeModel }) {
  const fields = draft.fields;
  const idx = hookIndex(node.id);
  if (!fields || !idx) return null;
  const hook = fields.hooks[idx.phase][idx.index];
  if (!hook) return <p className="am-muted">This node has no matching hook in AUTOMATION.md.</p>;
  const kind = 'script' in hook ? 'script' : 'prompt';
  const update = (nextHook: Hook) => setDraft({ ...draft, fields: setHook(fields, idx.phase, idx.index, nextHook), dirty: true });
  return (
    <div className="am-inspector-stack">
      <p className="am-section-label">{idx.phase.toUpperCase()} HOOK · {node.id}</p>
      <div className="am-segmented">
        <Button type="button" variant={kind === 'script' ? 'primary' : 'default'} onClick={() => update({ script: 'script.js' })}>script</Button>
        <Button type="button" variant={kind === 'prompt' ? 'primary' : 'default'} onClick={() => update({ prompt: 'Hook prompt' })}>prompt</Button>
      </div>
      {'script' in hook ? (
        <Field label="Script path" field={`hooks.${idx.phase}[${idx.index}].script`}>
          <TextInput value={hook.script} onChange={(event) => update({ script: event.target.value })} />
        </Field>
      ) : (
        <>
          <Field label="Prompt" field={`hooks.${idx.phase}[${idx.index}].prompt`}>
            <CodeEditor label="Hook prompt" language="markdown" value={hook.prompt} onChange={(value) => update({ prompt: value })} />
          </Field>
          <MarkdownView text={hook.prompt} />
        </>
      )}
      <Field label="Flowchart label">
        <TextInput value={node.label} onChange={(event) => draft.flowModel && setDraft({ ...draft, flowModel: setNodeLabel(draft.flowModel, node.id, event.target.value), flowTouched: true, dirty: true })} />
      </Field>
      <div className="am-button-row">
        <Button type="button" disabled={idx.index === 0} onClick={() => {
          const nextFields = moveHook(fields, idx.phase, idx.index, idx.index - 1);
          setDraft({ ...draft, fields: nextFields, flowModel: draft.flowModel ? reorderHookNodes(draft.flowModel, nextFields, idx.phase) : draft.flowModel, flowTouched: draft.flowTouched || Boolean(draft.flowModel), dirty: true });
        }}>Move up</Button>
        <Button type="button" disabled={idx.index >= fields.hooks[idx.phase].length - 1} onClick={() => {
          const nextFields = moveHook(fields, idx.phase, idx.index, idx.index + 1);
          setDraft({ ...draft, fields: nextFields, flowModel: draft.flowModel ? reorderHookNodes(draft.flowModel, nextFields, idx.phase) : draft.flowModel, flowTouched: draft.flowTouched || Boolean(draft.flowModel), dirty: true });
        }}>Move down</Button>
        <Button type="button" variant="danger" onClick={() => {
          const nextFields = deleteHook(fields, idx.phase, idx.index);
          setDraft({ ...draft, fields: nextFields, flowModel: draft.flowModel ? deleteHookNode(draft.flowModel, idx.phase, idx.index) : draft.flowModel, flowTouched: draft.flowTouched || Boolean(draft.flowModel), dirty: true });
        }}>Delete</Button>
      </div>
    </div>
  );
}

function NodeInspector({ draft, setDraft, node }: { draft: MonitorDraftState; setDraft: (draft: MonitorDraftState) => void; node: FlowNodeModel }) {
  if (/^(pre|post)\d+$/.test(node.id)) return <HookInspector draft={draft} setDraft={setDraft} node={node} />;
  if (node.id === 'body') {
    return (
      <div className="am-inspector-stack">
        <p className="am-section-label">Body</p>
        <Field label="Flowchart label"><TextInput value={node.label} onChange={(event) => draft.flowModel && setDraft({ ...draft, flowModel: setNodeLabel(draft.flowModel, node.id, event.target.value), flowTouched: true, dirty: true })} /></Field>
        <p className="am-muted">Edit the body in the Body tab.</p>
      </div>
    );
  }
  return (
    <div className="am-inspector-stack">
      <p className="am-section-label">Step</p>
      <Field label="Step id"><TextInput value={node.id} readOnly className="am-mono" /></Field>
      <Field label="Label"><TextInput value={node.label} onChange={(event) => draft.flowModel && setDraft({ ...draft, flowModel: { ...draft.flowModel, nodes: draft.flowModel.nodes.map((item) => item.id === node.id ? { ...item, label: event.target.value } : item) }, flowTouched: true, dirty: true })} /></Field>
      <Field label="Shape">
        <select className="am-input" value={node.shape} onChange={(event) => draft.flowModel && setDraft({ ...draft, flowModel: { ...draft.flowModel, nodes: draft.flowModel.nodes.map((item) => item.id === node.id ? { ...item, shape: event.target.value as FlowShape } : item) }, flowTouched: true, dirty: true })}>
          {SHAPES.map((shape) => <option key={shape} value={shape}>{shape}</option>)}
        </select>
      </Field>
      <p className="am-muted">The run moves this step with <code>pa step {node.id}</code>.</p>
      <Button type="button" variant="danger" onClick={() => draft.flowModel && setDraft({ ...draft, flowModel: { ...draft.flowModel, nodes: draft.flowModel.nodes.filter((item) => item.id !== node.id), edges: draft.flowModel.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id) }, flowTouched: true, dirty: true })}>Delete step</Button>
    </div>
  );
}

function EdgeInspector({ draft, setDraft, edge }: { draft: MonitorDraftState; setDraft: (draft: MonitorDraftState) => void; edge: FlowEdgeModel }) {
  const update = (patch: Partial<FlowEdgeModel>) => draft.flowModel && setDraft({ ...draft, flowModel: { ...draft.flowModel, edges: draft.flowModel.edges.map((item) => item.id === edge.id ? { ...item, ...patch } : item) }, flowTouched: true, dirty: true });
  return (
    <div className="am-inspector-stack">
      <p className="am-section-label">Arrow</p>
      <p className="am-muted">{edge.source} → {edge.target}</p>
      <Field label="Label"><TextInput value={edge.label ?? ''} onChange={(event) => update({ label: event.target.value || undefined })} /></Field>
      <Field label="Style">
        <select className="am-input" value={edge.kind} onChange={(event) => update({ kind: event.target.value as EdgeKind })}>
          {EDGE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </Field>
      <Button type="button" variant="danger" onClick={() => draft.flowModel && setDraft({ ...draft, flowModel: { ...draft.flowModel, edges: draft.flowModel.edges.filter((item) => item.id !== edge.id) }, flowTouched: true, dirty: true })}>Delete arrow</Button>
    </div>
  );
}

export function Inspector({
  draft,
  setDraft,
  compose,
  problems,
  models,
  selection,
  watchStatus,
}: {
  draft: MonitorDraftState;
  setDraft: (draft: MonitorDraftState) => void;
  compose: ComposeResult | null;
  problems: Problem[];
  models: ModelChoices;
  selection: Selection;
  watchStatus?: WatchStatus;
}) {
  const model = draft.flowModel;
  const selectedNode = selection.type === 'node' ? model?.nodes.find((node) => node.id === selection.id) ?? null : null;
  const selectedEdge = selection.type === 'edge' ? model?.edges.find((edge) => edge.id === selection.id) ?? null : null;
  return (
    <aside className="am-inspector am-panel">
      <header className="am-panel__header">
        <h2>Inspector</h2>
      </header>
      <div className="am-panel__body">
        {selectedNode ? <NodeInspector draft={draft} setDraft={setDraft} node={selectedNode} /> : selectedEdge ? <EdgeInspector draft={draft} setDraft={setDraft} edge={selectedEdge} /> : <AutomationSettings draft={draft} setDraft={setDraft} compose={compose} problems={problems} models={models} watchStatus={watchStatus} />}
      </div>
    </aside>
  );
}
