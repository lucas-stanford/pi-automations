import { describe, expect, it } from 'vitest';
import { addHook, deleteHook, deleteHookNode, draftFromBundle, flowProblems, flowTextAfterSave, insertHookNode, makeGeneratedFlow, moveHook, reorderHookNodes, toMonitorDraft } from './draft';
import { parseFlowMermaid, type FlowModel } from './flowMermaid';
import type { AutomationBundle, AutomationFields } from '../host/contract';

function fields(): AutomationFields {
  return { name: 'demo', description: 'Demo', enabled: true, on: { manual: true }, hooks: { pre: [{ script: 'a.js' }], post: [{ prompt: 'ship' }] }, body: 'Run it.' };
}

function bundle(flowText: string | null, generated = 'flowchart TD\n  body["body: demo"]\n'): AutomationBundle {
  const f = fields();
  return {
    summary: { id: 'demo.12345678', key: 'user:/tmp:demo', name: 'demo', scope: 'user', rootLabel: '~/.agents/automations', dir: '~/.agents/automations/demo', state: 'armed', triggers: f.on, tracked: Boolean(flowText), hasFlowFile: Boolean(flowText), editable: true, recent: [] },
    fields: f,
    files: { automation: { text: 'automation', revision: 'sha256:a', bytes: 10, updatedAt: null }, flow: flowText == null ? null : { text: flowText, revision: 'sha256:f', bytes: flowText.length, updatedAt: null } },
    flow: { source: flowText ? 'file' : 'none', text: flowText, generated, driven: ['pre0', 'body', 'post0'] },
    problems: [], nextFires: [], runs: [], notices: [],
  };
}

function parse(text: string): FlowModel {
  const parsed = parseFlowMermaid(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.model;
}

describe('monitor draft helpers', () => {
  it('adds, deletes and reorders positional hooks in fields', () => {
    const added = addHook(fields(), 'pre', { prompt: 'second' });
    expect(added.hooks.pre).toHaveLength(2);
    const moved = moveHook(added, 'pre', 1, 0);
    expect(moved.hooks.pre[0]).toEqual({ prompt: 'second' });
    const deleted = deleteHook(moved, 'pre', 1);
    expect(deleted.hooks.pre).toEqual([{ prompt: 'second' }]);
  });

  it('does not emit flowText for a generated chart or an unchanged flow file', () => {
    const generatedDraft = draftFromBundle(bundle(null));
    generatedDraft.fields = { ...fields(), description: 'changed' };
    expect(toMonitorDraft(generatedDraft)).not.toHaveProperty('flowText');

    const fileDraft = draftFromBundle(bundle('flowchart TD\n  pre0["Prepare run context"] --> body["Coordinate status-note subagents"]\n  body --> post0["Save result"]\n'));
    expect(toMonitorDraft(fileDraft)).not.toHaveProperty('flowText');
  });

  it('reads a chart from AUTOMATION.md when there is no older flow.mmd', () => {
    const chart = 'flowchart TD\n  body["From automation"]\n';
    const b = bundle(null);
    b.summary.tracked = true;
    b.summary.hasFlowFile = true;
    b.flow = { ...b.flow, source: 'automation', text: chart };
    const draft = draftFromBundle(b);
    expect(draft.hasChart).toBe(true);
    expect(draft.originalFlowText).toBe(chart);
    expect(toMonitorDraft(draft)).not.toHaveProperty('flowText');
  });

  it('emits flowText only after customize, remove, raw edit or semantic flow edit', () => {
    const generatedDraft = draftFromBundle(bundle(null));
    generatedDraft.flowModel = makeGeneratedFlow(fields());
    expect(toMonitorDraft(generatedDraft)).not.toHaveProperty('flowText');
    generatedDraft.flowTouched = true;
    expect(toMonitorDraft(generatedDraft).flowText).toContain('flowchart TD');

    const fileDraft = draftFromBundle(bundle('flowchart TD\n  body["body: demo"]\n'));
    fileDraft.flowModel = parse('flowchart TD\n  body["Renamed"]\n');
    expect(toMonitorDraft(fileDraft).flowText).toContain('Renamed');
    fileDraft.flowModel = null;
    fileDraft.flowText = null;
    fileDraft.flowTouched = true;
    expect(toMonitorDraft(fileDraft).flowText).toBeNull();
  });

  it('rewires and renumbers hook nodes against the flow-example chart', () => {
    const flowExample = parse(`flowchart TD\n  pre0["Prepare run context"] --> body["Coordinate status-note subagents"]\n  body --> outline["Draft outline"]\n  body --> facts["Collect run facts"]\n  outline --> compose["Combine worker results"]\n  facts --> compose\n  compose --> post0["Save result"]\n`);
    const withPre = insertHookNode(flowExample, fields(), 'pre', { script: 'b.js' });
    expect(withPre.nodes.some((node) => node.id === 'pre1')).toBe(true);
    expect(withPre.edges.some((edge) => edge.source === 'pre0' && edge.target === 'pre1')).toBe(true);
    expect(withPre.edges.some((edge) => edge.source === 'pre1' && edge.target === 'body')).toBe(true);

    const deleted = deleteHookNode(withPre, 'pre', 0);
    expect(deleted.nodes.some((node) => node.id === 'pre0')).toBe(true);
    expect(deleted.nodes.some((node) => node.id === 'pre1')).toBe(false);
    expect(deleted.edges.some((edge) => edge.source === 'pre0' && edge.target === 'body')).toBe(true);

    const reorderedFields = addHook(fields(), 'post', { script: 'second.js' });
    const withPost = insertHookNode(flowExample, fields(), 'post', { script: 'second.js' });
    const movedFields = moveHook(reorderedFields, 'post', 1, 0);
    const reordered = reorderHookNodes(withPost, movedFields, 'post');
    expect(reordered.nodes.find((node) => node.id === 'post0')?.label).toContain('second.js');
  });

  it('reports reserved-node and duplicate-arrow problems', () => {
    const model = makeGeneratedFlow(fields());
    const withDuplicate = { ...model, edges: [...model.edges, { ...model.edges[0], id: 'copy' }] };
    expect(flowProblems(withDuplicate, ['pre0', 'body', 'post0', 'post1'])).toEqual([
      'Reserved node post1 is missing from the flowchart.',
      'Duplicate arrow pre0 → body.',
    ]);
  });

  it('shows the chart a save would leave, never a rewrite the save will not make', () => {
    // A hand-written layout: a save that does not change the chart leaves it exactly as written.
    const authored = 'flowchart TD\n  pre0["Prepare run context"] --> body["Coordinate status-note subagents"]\n  body --> post0["Save result"]\n';
    const untouched = draftFromBundle(bundle(authored));
    untouched.fields = { ...fields(), description: 'only the description changed' };
    expect(flowTextAfterSave(untouched, authored)).toBe(authored);

    const relabelled = draftFromBundle(bundle(authored));
    relabelled.flowModel = parse(authored.replace('Save result', 'Save the note'));
    expect(flowTextAfterSave(relabelled, authored)).toContain('Save the note');

    const generated = draftFromBundle(bundle(null));
    expect(flowTextAfterSave(generated, null)).toBeNull();

    const removed = draftFromBundle(bundle(authored));
    removed.flowModel = null;
    removed.flowText = null;
    removed.flowTouched = true;
    expect(flowTextAfterSave(removed, authored)).toBeNull();
  });
});
