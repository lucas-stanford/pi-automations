import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import dagre from '@dagrejs/dagre';
import { Background, BaseEdge, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { AutomationBundle, AutomationFields, ComposeResult, Hook } from '../../host/contract';
import { addHook, addStep, flowProblems, insertHookNode, makeGeneratedFlow, removeStep, type MonitorDraftState } from '../draft';
import type { FlowEdgeModel, FlowModel, FlowNodeModel } from '../flowMermaid';
import { scheduleText } from './format';
import { Button } from './Button';

type Selection = { type: 'automation' } | { type: 'node'; id: string } | { type: 'edge'; id: string };

export const FIT = { padding: 0.2, maxZoom: 1 };
/** Must match .am-flow-node in monitor.css: dagre routes edges around boxes of this size. */
const NODE_SIZE = { width: 248, height: 76 };

type Point = { x: number; y: number };

interface FlowNodeData extends Record<string, unknown> {
  node: FlowNodeModel;
  kind: 'trigger' | 'pre' | 'body' | 'post' | 'step';
  title: string;
  subtitle: string;
  direction: FlowModel['direction'];
  selectNode?: (id: string) => void;
}

export function targetPosition(direction: FlowModel['direction']): Position {
  if (direction === 'LR') return Position.Left;
  if (direction === 'RL') return Position.Right;
  if (direction === 'BT') return Position.Bottom;
  return Position.Top;
}

export function sourcePosition(direction: FlowModel['direction']): Position {
  if (direction === 'LR') return Position.Right;
  if (direction === 'RL') return Position.Left;
  if (direction === 'BT') return Position.Top;
  return Position.Bottom;
}

/** The canvas draws the triggers; the chart never names them. Chart ids have no colon, so a step called `watch` stays a step. */
const TRIGGER_IDS = new Set(['trigger:manual', 'trigger:schedule', 'trigger:watch']);

function kindFor(id: string): FlowNodeData['kind'] {
  if (TRIGGER_IDS.has(id)) return 'trigger';
  if (id === 'body') return 'body';
  if (/^pre\d+$/.test(id)) return 'pre';
  if (/^post\d+$/.test(id)) return 'post';
  return 'step';
}

/** What a node shows as its id: a chart node's id, or where a trigger is set (`on.watch`). */
function shownId(id: string): string {
  return TRIGGER_IDS.has(id) ? id.replace('trigger:', 'on.') : id;
}

function badgeFor(id: string): string {
  if (TRIGGER_IDS.has(id)) return 'TRIGGER';
  if (id === 'body') return 'BODY';
  if (/^pre\d+$/.test(id)) return 'PRE HOOK';
  if (/^post\d+$/.test(id)) return 'POST HOOK';
  return 'STEP';
}

function hookSubtitle(fields: AutomationFields, id: string): string {
  const pre = id.match(/^pre(\d+)$/);
  if (pre) {
    const hook = fields.hooks.pre[Number(pre[1])];
    if (!hook) return 'missing pre hook';
    return 'script' in hook ? hook.script : hook.prompt.split(/\r?\n/)[0] || 'prompt hook';
  }
  const post = id.match(/^post(\d+)$/);
  if (post) {
    const hook = fields.hooks.post[Number(post[1])];
    if (!hook) return 'missing post hook';
    return 'script' in hook ? hook.script : hook.prompt.split(/\r?\n/)[0] || 'prompt hook';
  }
  return '';
}

function subtitleFor(node: FlowNodeModel, fields: AutomationFields): string {
  if (node.id === 'trigger:manual') return 'Manual trigger';
  if (node.id === 'trigger:schedule') return scheduleText(fields.on.schedule, false);
  if (node.id === 'trigger:watch') return fields.on.watch ? `${fields.on.watch.script} · every ${fields.on.watch.every}` : 'no watch';
  if (node.id === 'body') return `${fields.model ?? 'host default'} · ${fields.timeout ?? 'host timeout'} · ${fields.body.split(/\r?\n/)[0] ?? ''}`;
  const hook = hookSubtitle(fields, node.id);
  if (hook) return hook;
  return 'moved by the run';
}

/** The chart plus a node per trigger, each pointing at the first step. */
export function withTriggerNodes(model: FlowModel, fields: AutomationFields): FlowModel {
  const entry = model.nodes.find((node) => /^pre0$|^body$/.test(node.id))?.id ?? model.nodes[0]?.id;
  if (!entry) return model;
  const nodes: FlowNodeModel[] = [];
  const edges: FlowEdgeModel[] = [];
  if (fields.on.manual) {
    nodes.push({ id: 'trigger:manual', label: 'Manual', shape: 'round' });
    edges.push({ id: 'trigger-manual', source: 'trigger:manual', target: entry, kind: 'arrow' });
  }
  if (fields.on.schedule) {
    nodes.push({ id: 'trigger:schedule', label: 'Schedule', shape: 'round' });
    edges.push({ id: 'trigger-schedule', source: 'trigger:schedule', target: entry, kind: 'arrow' });
  }
  if (fields.on.watch) {
    nodes.push({ id: 'trigger:watch', label: 'Watch', shape: 'round' });
    edges.push({ id: 'trigger-watch', source: 'trigger:watch', target: entry, kind: 'arrow' });
  }
  return { ...model, nodes: [...nodes, ...model.nodes], edges: [...edges, ...model.edges] };
}

interface RoutedEdgeData extends Record<string, unknown> {
  /** dagre's route, from the source node's border to the target node's border. */
  route: Point[];
  /** The centre of the room dagre kept free for the label. */
  labelAt?: Point;
  /** The edge runs with the flow, so it can start and end on the node handles. */
  forward: boolean;
}

/** Room for an edge label (11px text plus its background), so dagre keeps nodes off it. */
export function edgeLabelSize(label: string): { width: number; height: number } {
  return { width: Math.ceil(label.length * 6.6) + 16, height: 20 };
}

function runsForward(rankdir: string, from: Point, to: Point): boolean {
  if (rankdir === 'LR') return to.x > from.x;
  if (rankdir === 'RL') return to.x < from.x;
  if (rankdir === 'BT') return to.y < from.y;
  return to.y > from.y;
}

/**
 * A loop from a node back to itself, on the side where dagre kept room for it (`reserved`): out of
 * the node's border and back in, so the arrow lands on the node. dagre's own route for a self-loop is
 * not anchored to the node, so it is not used.
 */
function selfLoop(center: Point, reserved: Point | undefined, rankdir: string): { route: Point[]; labelAt: Point } {
  const halfW = NODE_SIZE.width / 2;
  const halfH = NODE_SIZE.height / 2;
  const reach = 48;
  const toward = reserved ?? (rankdir === 'LR' || rankdir === 'RL' ? { x: center.x, y: center.y + halfH + reach } : { x: center.x + halfW + reach, y: center.y });
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (Math.abs(dx) * NODE_SIZE.height >= Math.abs(dy) * NODE_SIZE.width) {
    const side = dx >= 0 ? 1 : -1;
    const x = center.x + side * halfW;
    const out = x + side * reach;
    const [top, bottom] = [center.y - halfH / 2, center.y + halfH / 2];
    return { route: [{ x, y: top }, { x: out, y: top }, { x: out, y: bottom }, { x, y: bottom }], labelAt: reserved ?? { x: out, y: center.y } };
  }
  const side = dy >= 0 ? 1 : -1;
  const y = center.y + side * halfH;
  const out = y + side * reach;
  const [left, right] = [center.x - halfW / 2, center.x + halfW / 2];
  return { route: [{ x: left, y }, { x: left, y: out }, { x: right, y: out }, { x: right, y }], labelAt: reserved ?? { x: center.x, y: out } };
}

/** The points an edge is drawn through: the handles for forward edges, dagre's border points otherwise. */
export function edgePoints(data: RoutedEdgeData | undefined, source: Point, target: Point): Point[] {
  const route = data?.route ?? [];
  if (route.length < 2) return [source, target];
  return data?.forward ? [source, ...route.slice(1, -1), target] : route;
}

/** d3's curveBasis, which Mermaid draws flowchart edges with. */
export function basisPath(points: Point[]): string {
  const [first, second] = points;
  if (!first) return '';
  if (!second) return `M${first.x},${first.y}`;
  if (points.length === 2) return `M${first.x},${first.y}L${second.x},${second.y}`;
  const curve = (a: Point, b: Point, c: Point) => `C${(2 * a.x + b.x) / 3},${(2 * a.y + b.y) / 3} ${(a.x + 2 * b.x) / 3},${(a.y + 2 * b.y) / 3} ${(a.x + 4 * b.x + c.x) / 6},${(a.y + 4 * b.y + c.y) / 6}`;
  let path = `M${first.x},${first.y}L${(5 * first.x + second.x) / 6},${(5 * first.y + second.y) / 6}`;
  let [a, b] = [first, second];
  for (const next of points.slice(2)) {
    path += curve(a, b, next);
    [a, b] = [b, next];
  }
  return `${path}${curve(a, b, b)}L${b.x},${b.y}`;
}

/**
 * Follows the route dagre worked out, so an edge that skips a rank goes around the nodes in
 * between instead of under them, and its label sits where dagre left room for it.
 */
function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, data, label, markerEnd, style, interactionWidth, labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius }: EdgeProps<Edge<RoutedEdgeData>>) {
  const points = edgePoints(data, { x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const at = data?.labelAt ?? points[Math.floor(points.length / 2)];
  return (
    <BaseEdge
      id={id}
      path={basisPath(points)}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth}
      label={label}
      labelX={at.x}
      labelY={at.y}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding ?? [6, 3]}
      labelBgBorderRadius={labelBgBorderRadius ?? 4}
    />
  );
}

export function layoutAutomation(model: FlowModel, fields: AutomationFields): { nodes: Node<FlowNodeData>[]; edges: Edge<RoutedEdgeData>[] } {
  return layoutFlow(model, (node) => subtitleFor(node, fields));
}

/**
 * Lay a chart out with dagre: node boxes and the routes their edges take. Shared by the editor's
 * canvas and the Runs tab, which draws a run on the same chart.
 */
export function layoutFlow(model: FlowModel, subtitle: (node: FlowNodeModel) => string): { nodes: Node<FlowNodeData>[]; edges: Edge<RoutedEdgeData>[] } {
  // A multigraph keeps two edges between the same pair of nodes apart; each is named by its index.
  const g = new dagre.graphlib.Graph({ multigraph: true });
  const rankdir = model.direction === 'TD' ? 'TB' : model.direction;
  g.setGraph({ rankdir, nodesep: 36, ranksep: 56, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of model.nodes) g.setNode(node.id, { ...NODE_SIZE });
  model.edges.forEach((edge, index) => {
    g.setEdge(edge.source, edge.target, edge.label ? { ...edgeLabelSize(edge.label), labelpos: 'c' } : {}, String(index));
  });
  dagre.layout(g);
  const nodes = model.nodes.map<Node<FlowNodeData>>((node) => {
    const pos = g.node(node.id) as { x: number; y: number } | undefined;
    const kind = kindFor(node.id);
    return {
      id: node.id,
      type: 'automationNode',
      position: { x: (pos?.x ?? 0) - NODE_SIZE.width / 2, y: (pos?.y ?? 0) - NODE_SIZE.height / 2 },
      data: {
        node,
        kind,
        title: node.label,
        subtitle: subtitle(node),
        direction: model.direction,
      },
    };
  });
  const edges = model.edges.map<Edge<RoutedEdgeData>>((edge, index) => {
    const laid = g.edge(edge.source, edge.target, String(index)) as { points?: Point[]; x?: number; y?: number } | undefined;
    const from = g.node(edge.source) as Point | undefined;
    const to = g.node(edge.target) as Point | undefined;
    const reserved = laid?.x !== undefined && laid.y !== undefined ? { x: laid.x, y: laid.y } : undefined;
    const loop = edge.source === edge.target && from ? selfLoop(from, reserved, rankdir) : undefined;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: 'routed',
      data: {
        route: loop?.route ?? laid?.points ?? [],
        labelAt: edge.label ? loop?.labelAt ?? reserved : undefined,
        forward: Boolean(from && to && edge.source !== edge.target && runsForward(rankdir, from, to)),
      },
      markerEnd: edge.kind === 'open' || edge.kind === 'dottedOpen' || edge.kind === 'thickOpen' ? undefined : { type: MarkerType.ArrowClosed, color: 'var(--dag-edge)' },
      className: `am-rf-edge am-rf-edge--${edge.kind}`,
      style: {
        strokeWidth: edge.kind.startsWith('thick') ? 2.5 : 1.4,
        strokeDasharray: edge.kind.startsWith('dotted') ? '4 4' : undefined,
        stroke: 'var(--dag-edge)',
      },
    };
  });
  return { nodes, edges };
}

function AutomationNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const direction = data.direction;
  return (
    <article
      className={`am-flow-node am-flow-node--${data.kind} ${selected ? 'am-flow-node--selected' : ''}`}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          data.selectNode?.(data.node.id);
        }
      }}
    >
      <Handle type="target" position={targetPosition(direction)} className="am-flow-handle" />
      <div className="am-flow-node__top">
        <span>{badgeFor(data.node.id)}</span>
        <code>{shownId(data.node.id)}</code>
      </div>
      <strong>{data.title}</strong>
      <p>{data.subtitle}</p>
      <Handle type="source" position={sourcePosition(direction)} className="am-flow-handle" />
    </article>
  );
}

const nodeTypes = { automationNode: AutomationNode };
/** Edges drawn along dagre's route, for any canvas laid out with layoutFlow. */
export const edgeTypes = { routed: RoutedEdge };

export function FlowCanvas({
  bundle,
  draft,
  setDraft,
  compose,
  selection,
  setSelection,
}: {
  bundle: AutomationBundle;
  draft: MonitorDraftState;
  setDraft: (draft: MonitorDraftState) => void;
  compose: ComposeResult | null;
  selection: Selection;
  setSelection: Dispatch<SetStateAction<Selection>>;
}) {
  const customModel = draft.flowModel;
  const fields = draft.fields;
  const generated = useMemo(() => {
    if (!fields) return null;
    if (compose?.generatedFlow) return null;
    return makeGeneratedFlow(fields);
  }, [compose?.generatedFlow, fields]);
  const baseModel = customModel ?? generated;
  const displayModel = useMemo(() => (baseModel && fields ? withTriggerNodes(baseModel, fields) : null), [baseModel, fields]);
  const graph = useMemo(() => (displayModel && fields ? layoutAutomation(displayModel, fields) : { nodes: [], edges: [] }), [displayModel, fields]);
  const selectedNodeId = selection.type === 'node' ? selection.id : undefined;
  const selectedEdgeId = selection.type === 'edge' ? selection.id : undefined;
  const idRef = useRef(1);
  const [flow, setFlow] = useState<ReactFlowInstance<Node<FlowNodeData>, Edge> | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Set once the person pans or zooms, so the view stops being refitted under them.
  const userMoved = useRef(false);
  const nodeCount = graph.nodes.length;

  // Keep the whole flow in view while the canvas changes size (the Problems list opening, the
  // window resizing) and when steps are added or removed — until the person moves it themselves.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element || !flow) return undefined;
    let frame = requestAnimationFrame(() => {
      if (!userMoved.current) void flow.fitView(FIT);
    });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!userMoved.current) void flow.fitView(FIT);
      });
    });
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [flow, nodeCount]);
  const problems = flowProblems(customModel, compose?.driven ?? bundle.flow.driven);
  const updateSelection = useCallback((next: Selection) => {
    setSelection((current) => {
      if (current.type !== next.type) return next;
      if (current.type === 'automation' || next.type === 'automation') return current;
      return current.id === next.id ? current : next;
    });
  }, [setSelection]);

  const ensureModel = useCallback((): FlowModel | null => {
    if (!fields) return null;
    return customModel ?? makeGeneratedFlow(fields);
  }, [customModel, fields]);

  const addHookAndNode = (phase: 'pre' | 'post') => {
    if (!fields) return;
    const hook: Hook = { prompt: `New ${phase} hook prompt` };
    const nextFields = addHook(fields, phase, hook);
    const model = ensureModel();
    setDraft({
      ...draft,
      fields: nextFields,
      flowModel: model ? insertHookNode(model, fields, phase, hook) : model,
      flowTouched: Boolean(model),
      dirty: true,
    });
  };

  const addCustomStep = () => {
    const model = ensureModel();
    if (!model) return;
    const id = `step${idRef.current}`;
    idRef.current += 1;
    setDraft({ ...draft, flowModel: addStep(model, id, `Step ${idRef.current - 1}`), flowTouched: true, dirty: true });
  };

  return (
    <section className="am-panel am-flow-panel">
      <div className="am-flow-header">
        <div className="am-flow-toolbar" role="toolbar" aria-label="Flowchart toolbar">
          <Button type="button" onClick={() => addHookAndNode('pre')}>+ Pre hook</Button>
          <Button type="button" onClick={() => addHookAndNode('post')}>+ Post hook</Button>
          <Button type="button" onClick={addCustomStep}>+ Step</Button>
          <Button type="button" onClick={() => { userMoved.current = false; void flow?.fitView(FIT); }}>Fit</Button>
          {!draft.hasChart && !draft.flowTouched ? (
            <Button type="button" onClick={() => fields && setDraft({ ...draft, flowModel: makeGeneratedFlow(fields), flowTouched: true, dirty: true })}>Customize flowchart</Button>
          ) : (
            <Button type="button" variant="danger" onClick={() => window.confirm(bundle.files.flow && bundle.flow.source === 'file' && !draft.flowTouched ? 'Remove flow.mmd? Its runs will no longer be tracked on a flowchart.' : 'Remove the flowchart from AUTOMATION.md? Its runs will no longer be tracked on a flowchart.') && setDraft({ ...draft, flowModel: null, flowText: null, flowTouched: true, dirty: true })}>Remove flowchart</Button>
          )}
        </div>
        {draft.flowRawReason && <p className="am-banner am-banner--warning am-flow-note">Raw mode: {draft.flowRawReason}. Edit the chart in Source.</p>}
        {problems.length > 0 && <ul className="am-flow-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      </div>
      <div className="am-flow-canvas" ref={canvasRef}>
        <ReactFlow
          nodes={graph.nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId, data: { ...node.data, selectNode: (nodeId: string) => updateSelection({ type: 'node', id: nodeId }) } }))}
          edges={graph.edges.map((edge) => ({ ...edge, selected: edge.id === selectedEdgeId }))}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
          fitView
          fitViewOptions={FIT}
          onMoveStart={(event) => {
            if (event) userMoved.current = true;
          }}
          onNodeClick={(_, node) => updateSelection({ type: 'node', id: node.id })}
          onEdgeClick={(_, edge) => updateSelection({ type: 'edge', id: edge.id })}
          onPaneClick={() => updateSelection({ type: 'automation' })}
          onInit={setFlow}
          onNodesDelete={(nodes) => {
            const model = ensureModel();
            if (!model) return;
            let next = model;
            for (const node of nodes) {
              if (!/^(manual|schedule|body|pre\d+|post\d+)$/.test(node.id)) next = removeStep(next, node.id);
            }
            setDraft({ ...draft, flowModel: next, flowTouched: true, dirty: true });
          }}
          deleteKeyCode={['Delete', 'Backspace']}
        >
          <Background color="var(--border)" gap={18} size={1} />
          {graph.nodes.length > 10 && <MiniMap pannable zoomable maskColor="color-mix(in srgb, var(--background) 68%, transparent)" nodeColor="var(--muted)" />}
          <Controls />
        </ReactFlow>
      </div>
    </section>
  );
}

export type { Selection };
