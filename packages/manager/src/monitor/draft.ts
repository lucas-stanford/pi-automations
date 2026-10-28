import type { AutomationBundle, AutomationFields, Hook, MonitorDraft } from '../host/contract';
import { parseFlowMermaid, serializeFlowMermaid, type FlowModel, type FlowNodeModel } from './flowMermaid';

export interface MonitorDraftState {
  fields: AutomationFields | null;
  automationText?: string;
  flowText?: string | null;
  flowModel: FlowModel | null;
  flowRawReason?: string;
  /** True when this automation has its own chart: in AUTOMATION.md, or an older flow.mmd. Generated charts are display-only. */
  hasChart: boolean;
  /** Canonical semantic form of the loaded chart. Null for raw/absent charts. */
  originalFlowCanonical: string | null;
  /** Exact loaded chart text. Undefined when the automation did not have its own chart. */
  originalFlowText?: string;
  /** Explicit user action: Customize flowchart, Remove flowchart, or raw source edit. */
  flowTouched: boolean;
  dirty: boolean;
  past: MonitorDraft[];
  future: MonitorDraft[];
}

export function draftFromBundle(bundle: AutomationBundle): MonitorDraftState {
  const flowText = bundle.flow.text ?? bundle.files.flow?.text ?? undefined;
  const parsed = flowText ? parseFlowMermaid(flowText) : null;
  const flowModel = parsed?.ok ? parsed.model : null;
  return {
    fields: bundle.fields,
    flowText,
    flowModel,
    flowRawReason: parsed && !parsed.ok ? `${parsed.reason} at ${parsed.line}:${parsed.column}` : undefined,
    hasChart: Boolean(flowText),
    originalFlowText: flowText,
    originalFlowCanonical: flowModel ? serializeFlowMermaid(flowModel) : null,
    flowTouched: false,
    dirty: false,
    past: [],
    future: [],
  };
}

export function toMonitorDraft(state: MonitorDraftState): MonitorDraft {
  const draft: MonitorDraft = {};
  if (state.automationText !== undefined) draft.automationText = state.automationText;
  else if (state.fields) draft.fields = state.fields;

  if (state.flowTouched) {
    if (state.flowModel) draft.flowText = serializeFlowMermaid(state.flowModel);
    else if (state.flowText !== undefined) draft.flowText = state.flowText;
  } else if (state.hasChart) {
    if (state.flowModel) {
      const next = serializeFlowMermaid(state.flowModel);
      if (next !== state.originalFlowCanonical) draft.flowText = next;
    } else if (state.flowText !== undefined && state.flowText !== state.originalFlowText) {
      draft.flowText = state.flowText;
    }
  }
  return draft;
}

/**
 * The chart a save would leave: the new text, `null` when there would be none, or the current chart
 * text when the save does not touch it.
 *
 * Every surface that shows "what will be written" (Source, Review changes) must use this rather
 * than re-serializing the model, or it shows a rewrite the save will never make.
 */
export function flowTextAfterSave(state: MonitorDraftState, onDisk: string | null): string | null {
  const sent = toMonitorDraft(state).flowText;
  return sent === undefined ? onDisk : sent;
}

function cloneFields(fields: AutomationFields): AutomationFields {
  return JSON.parse(JSON.stringify(fields)) as AutomationFields;
}

export function makeGeneratedFlow(fields: AutomationFields): FlowModel {
  const nodes: FlowNodeModel[] = [];
  const edges: FlowModel['edges'] = [];
  fields.hooks.pre.forEach((hook, index) => {
    nodes.push({ id: `pre${index}`, label: hookLabel('pre', hook, index), shape: 'rect' });
  });
  nodes.push({ id: 'body', label: `body: ${fields.name}`, shape: 'rect' });
  fields.hooks.post.forEach((hook, index) => {
    nodes.push({ id: `post${index}`, label: hookLabel('post', hook, index), shape: 'rect' });
  });
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({ id: `e${i}`, source: nodes[i].id, target: nodes[i + 1].id, kind: 'arrow' });
  }
  return { direction: 'TD', nodes, edges };
}

function hookLabel(phase: 'pre' | 'post', hook: Hook, index: number): string {
  if ('script' in hook) return `${phase}[${index}] ${hook.script}`;
  return `${phase}[${index}] ${hook.prompt.split(/\r?\n/)[0] || 'prompt'}`;
}

export function addHook(fields: AutomationFields, phase: 'pre' | 'post', hook: Hook): AutomationFields {
  const next = cloneFields(fields);
  next.hooks[phase].push(hook);
  return next;
}

export function setHook(fields: AutomationFields, phase: 'pre' | 'post', index: number, hook: Hook): AutomationFields {
  const next = cloneFields(fields);
  next.hooks[phase][index] = hook;
  return next;
}

export function deleteHook(fields: AutomationFields, phase: 'pre' | 'post', index: number): AutomationFields {
  const next = cloneFields(fields);
  next.hooks[phase].splice(index, 1);
  return next;
}

export function moveHook(fields: AutomationFields, phase: 'pre' | 'post', from: number, to: number): AutomationFields {
  const next = cloneFields(fields);
  const list = next.hooks[phase];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return next;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return next;
}

function renumberPhase(model: FlowModel, phase: 'pre' | 'post'): FlowModel {
  const re = new RegExp(`^${phase}(\\d+)$`);
  const ordered = model.nodes.filter((node) => re.test(node.id));
  const idMap = new Map(ordered.map((node, index) => [node.id, `${phase}${index}`]));
  return {
    ...model,
    nodes: model.nodes.map((node) => {
      const id = idMap.get(node.id);
      return id ? { ...node, id } : node;
    }),
    edges: model.edges.map((edge, index) => ({
      ...edge,
      id: `e${index}`,
      source: idMap.get(edge.source) ?? edge.source,
      target: idMap.get(edge.target) ?? edge.target,
    })),
  };
}

function reconnectWithoutNode(model: FlowModel, id: string): FlowModel {
  const incoming = model.edges.filter((edge) => edge.target === id).map((edge) => edge.source);
  const outgoing = model.edges.filter((edge) => edge.source === id).map((edge) => edge.target);
  const kept = model.edges.filter((edge) => edge.source !== id && edge.target !== id);
  const stitched = [...kept];
  for (const source of incoming) {
    for (const target of outgoing) {
      if (source !== target && !stitched.some((edge) => edge.source === source && edge.target === target)) {
        stitched.push({ id: `e${stitched.length}`, source, target, kind: 'arrow' });
      }
    }
  }
  return { ...model, nodes: model.nodes.filter((node) => node.id !== id), edges: stitched.map((edge, index) => ({ ...edge, id: `e${index}` })) };
}

export function insertHookNode(model: FlowModel, fields: AutomationFields, phase: 'pre' | 'post', hook: Hook): FlowModel {
  const index = fields.hooks[phase].length;
  const id = `${phase}${index}`;
  const node: FlowNodeModel = { id, label: hookLabel(phase, hook, index), shape: 'rect' };
  if (phase === 'pre') {
    const preIds = fields.hooks.pre.map((_, i) => `pre${i}`).filter((preId) => model.nodes.some((n) => n.id === preId));
    const previous = preIds.at(-1);
    if (previous) {
      const outgoing = model.edges.filter((edge) => edge.source === previous);
      const withoutOutgoing = model.edges.filter((edge) => edge.source !== previous);
      return { ...model, nodes: [...model.nodes, node], edges: [...withoutOutgoing, ...outgoing.map((edge, i) => ({ ...edge, id: `e${withoutOutgoing.length + i}`, source: id })), { id: `e${withoutOutgoing.length + outgoing.length}`, source: previous, target: id, kind: 'arrow' }] };
    }
    const incomingBody = model.edges.filter((edge) => edge.target === 'body');
    const withoutIncoming = model.edges.filter((edge) => edge.target !== 'body');
    return { ...model, nodes: [node, ...model.nodes], edges: [...withoutIncoming, ...incomingBody.map((edge, i) => ({ ...edge, id: `e${withoutIncoming.length + i}`, target: id })), { id: `e${withoutIncoming.length + incomingBody.length}`, source: id, target: 'body', kind: 'arrow' }] };
  }

  const postIds = fields.hooks.post.map((_, i) => `post${i}`).filter((postId) => model.nodes.some((n) => n.id === postId));
  const previous = postIds.at(-1);
  if (previous) {
    return { ...model, nodes: [...model.nodes, node], edges: [...model.edges, { id: `e${model.edges.length}`, source: previous, target: id, kind: 'arrow' }] };
  }
  const targets = model.nodes.map((n) => n.id);
  const sinks = targets.filter((target) => !model.edges.some((edge) => edge.source === target));
  return { ...model, nodes: [...model.nodes, node], edges: [...model.edges, ...sinks.map((source, i) => ({ id: `e${model.edges.length + i}`, source, target: id, kind: 'arrow' as const }))] };
}

export function deleteHookNode(model: FlowModel, phase: 'pre' | 'post', index: number): FlowModel {
  return renumberPhase(reconnectWithoutNode(model, `${phase}${index}`), phase);
}

export function reorderHookNodes(model: FlowModel, fields: AutomationFields, phase: 'pre' | 'post'): FlowModel {
  const labels = fields.hooks[phase].map((hook, index) => hookLabel(phase, hook, index));
  return {
    ...model,
    nodes: model.nodes.map((node) => {
      const match = node.id.match(new RegExp(`^${phase}(\\d+)$`));
      if (!match) return node;
      const index = Number(match[1]);
      return labels[index] ? { ...node, label: labels[index] } : node;
    }),
  };
}

export function setNodeLabel(model: FlowModel, id: string, label: string): FlowModel {
  return { ...model, nodes: model.nodes.map((node) => (node.id === id ? { ...node, label } : node)) };
}

export function addStep(model: FlowModel, id: string, label: string): FlowModel {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || model.nodes.some((node) => node.id === id) || /^(pre|post)\d+$|^body$/.test(id)) return model;
  const nodes = [...model.nodes, { id, label, shape: 'rect' as const }];
  const body = model.nodes.find((node) => node.id === 'body')?.id ?? model.nodes[0]?.id;
  const edges = body ? [...model.edges, { id: `e${model.edges.length}`, source: body, target: id, kind: 'arrow' as const }] : model.edges;
  return { ...model, nodes, edges };
}

export function removeStep(model: FlowModel, id: string): FlowModel {
  if (id === 'body' || /^pre\d+$/.test(id) || /^post\d+$/.test(id)) return model;
  return reconnectWithoutNode(model, id);
}

export function flowProblems(model: FlowModel | null, driven: string[]): string[] {
  if (!model) return [];
  const problems: string[] = [];
  const ids = new Set(model.nodes.map((node) => node.id));
  for (const id of driven) if (!ids.has(id)) problems.push(`Reserved node ${id} is missing from the flowchart.`);
  for (const node of model.nodes) {
    if (!/^[A-Za-z0-9_-]+$/.test(node.id)) problems.push(`Node id ${node.id} is invalid.`);
    if (/^(pre|post)\d+$/.test(node.id) && !driven.includes(node.id)) problems.push(`${node.id} looks like a reserved hook node, but there is no such hook.`);
  }
  const seen = new Set<string>();
  for (const edge of model.edges) {
    const key = `${edge.source}->${edge.target}:${edge.label ?? ''}`;
    if (seen.has(key)) problems.push(`Duplicate arrow ${edge.source} → ${edge.target}.`);
    seen.add(key);
  }
  return problems;
}
