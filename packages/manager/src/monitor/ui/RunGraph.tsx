import { useMemo } from 'react';
import { Background, Controls, Handle, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { RunStep, StepStatus } from '../../host/contract';
import { parseFlowMermaid, type FlowModel } from '../flowMermaid';
import { edgeTypes, FIT, layoutFlow, sourcePosition, targetPosition } from './FlowCanvas';

const STATUS_WORD: Record<StepStatus, string> = {
  pending: 'not reached',
  active: 'running',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  interrupted: 'interrupted',
};

interface RunNodeData extends Record<string, unknown> {
  id: string;
  label: string;
  status: StepStatus;
  text?: string;
  direction: FlowModel['direction'];
}

function RunNode({ data }: NodeProps<Node<RunNodeData>>) {
  return (
    <article className={`am-flow-node am-run-node am-run-node--${data.status}`} aria-label={`${data.label}: ${STATUS_WORD[data.status]}`}>
      <Handle type="target" position={targetPosition(data.direction)} className="am-flow-handle" />
      <div className="am-flow-node__top">
        <span>{STATUS_WORD[data.status]}</span>
        <code>{data.id}</code>
      </div>
      <strong>{data.label}</strong>
      {data.text && <p title={data.text}>{data.text}</p>}
      <Handle type="source" position={sourcePosition(data.direction)} className="am-flow-handle" />
    </article>
  );
}

const nodeTypes = { runNode: RunNode };

export function statusWord(status: StepStatus): string {
  return STATUS_WORD[status];
}

/** A run on its own chart, from its record: each node coloured by where it got to, arrows taken heavier. */
export function RunGraph({ chart, steps, taken }: { chart: string; steps: RunStep[]; taken: [string, string][] }) {
  const graph = useMemo(() => {
    const parsed = parseFlowMermaid(chart);
    if (!parsed.ok) return null;
    const byId = new Map(steps.map((s) => [s.id, s]));
    const tookEdge = new Set(taken.map(([a, b]) => `${a}\u0000${b}`));
    const laid = layoutFlow(parsed.model, () => '');
    const nodes: Node<RunNodeData>[] = laid.nodes.map((node) => {
      const step = byId.get(node.id);
      return {
        id: node.id,
        type: 'runNode',
        position: node.position,
        draggable: false,
        selectable: false,
        data: {
          id: node.id,
          label: step?.label ?? node.data.title,
          status: step?.status ?? 'pending',
          ...(step?.text ? { text: step.text } : {}),
          direction: parsed.model.direction,
        },
      };
    });
    const edges: Edge[] = laid.edges.map((edge) => {
      const took = tookEdge.has(`${edge.source}\u0000${edge.target}`);
      return {
        ...edge,
        selectable: false,
        className: `${edge.className ?? ''}${took ? ' am-rf-edge--taken' : ''}`,
        style: { ...edge.style, ...(took ? { stroke: 'var(--primary)', strokeWidth: 2.6 } : {}) },
      };
    });
    return { nodes, edges };
  }, [chart, steps, taken]);

  if (!graph) return null;
  return (
    <div className="am-run-graph" role="img" aria-label="The run on its flowchart">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
        fitView
        fitViewOptions={FIT}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
