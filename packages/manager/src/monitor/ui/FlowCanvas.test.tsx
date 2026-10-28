import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeGeneratedFlow } from '../draft';
import { parseFlowMermaid } from '../flowMermaid';
import { withTriggerNodes, basisPath, layoutAutomation, edgeLabelSize, edgePoints, FlowCanvas } from './FlowCanvas';
import { sampleBundle, sampleDraft, sampleFields } from './testHelpers';

type Box = { left: number; top: number; right: number; bottom: number };
type Point = { x: number; y: number };

const nodeBox = (node: { position: Point }): Box => ({ left: node.position.x, top: node.position.y, right: node.position.x + 248, bottom: node.position.y + 76 });
const inside = (point: Point, box: Box) => point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom;
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Points along an SVG path made of M, L and C commands, as basisPath writes them. */
function sample(path: string): Point[] {
  const points: Point[] = [];
  let at: Point = { x: 0, y: 0 };
  for (const [, command, args] of path.matchAll(/([MLC])([^MLC]*)/g)) {
    const n = args.split(/[ ,]+/).filter(Boolean).map(Number);
    if (command === 'C') {
      const [c1, c2, end] = [{ x: n[0], y: n[1] }, { x: n[2], y: n[3] }, { x: n[4], y: n[5] }];
      for (let t = 0; t <= 1; t += 0.05) {
        const u = 1 - t;
        points.push({
          x: u * u * u * at.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
          y: u * u * u * at.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
        });
      }
      at = end;
    } else {
      const next = { x: n[0], y: n[1] };
      if (command === 'L') for (let t = 0; t <= 1; t += 0.05) points.push({ x: at.x + (next.x - at.x) * t, y: at.y + (next.y - at.y) * t });
      at = next;
    }
  }
  return points;
}

const TRIAGE_CHART = `flowchart TD
  %% pi moves pre0 and body; the agent reports read, reproduce and draft.
  pre0["Pick the next issue"] --> body["Triage the issue"]
  body --> read["Read the issue"]
  read --> reproduce["Try it on staging"]
  read -->|no browser needed| draft["Draft the verdict"]
  reproduce --> draft
`;

describe('FlowCanvas', () => {
  it('lays out flow-example with parallel facts/outline rank and trigger above pre0', () => {
    const fields = sampleFields();
    const parsed = parseFlowMermaid(`flowchart TD
  pre0["Prepare run context"] --> body["Coordinate status-note subagents"]
  body --> outline["Draft outline"]
  body --> facts["Collect run facts"]
  outline --> compose["Combine worker results"]
  facts --> compose
  compose --> post0["Save result"]
`);
    if (!parsed.ok) throw new Error(parsed.reason);
    const graph = layoutAutomation(withTriggerNodes(parsed.model, fields), fields);
    const y = (id: string) => graph.nodes.find((node) => node.id === id)!.position.y;
    expect(y('outline')).toBe(y('facts'));
    expect(y('trigger:manual')).toBeLessThan(y('pre0'));
  });

  it('draws an edge that skips a rank around the node in between, with its label in the clear', () => {
    const fields = sampleFields({ name: 'issue-triage', hooks: { pre: [{ script: 'scripts/pick.js' }], post: [] } });
    const parsed = parseFlowMermaid(TRIAGE_CHART);
    if (!parsed.ok) throw new Error(parsed.reason);
    const graph = layoutAutomation(withTriggerNodes(parsed.model, fields), fields);
    const boxes = new Map(graph.nodes.map((node) => [node.id, nodeBox(node)]));

    const skip = graph.edges.find((edge) => edge.source === 'read' && edge.target === 'draft')!;
    const at = skip.data!.labelAt!;
    const size = edgeLabelSize('no browser needed');
    const label = { left: at.x - size.width / 2, top: at.y - size.height / 2, right: at.x + size.width / 2, bottom: at.y + size.height / 2 };
    for (const [id, box] of boxes) expect(overlaps(label, box), `the label covers ${id}`).toBe(false);

    // Draw every edge the way the canvas does (from the bottom handle to the top handle) and check
    // it never passes through a node it does not connect.
    for (const edge of graph.edges) {
      const from = boxes.get(edge.source)!;
      const to = boxes.get(edge.target)!;
      const points = edgePoints(edge.data, { x: (from.left + from.right) / 2, y: from.bottom }, { x: (to.left + to.right) / 2, y: to.top });
      for (const point of sample(basisPath(points))) {
        for (const [id, box] of boxes) {
          if (id !== edge.source && id !== edge.target) expect(inside(point, box), `${edge.source}→${edge.target} runs under ${id}`).toBe(false);
        }
      }
    }
  });

  it('keeps two edges between the same nodes apart and routes a loop back by the node borders', () => {
    const fields = sampleFields({ hooks: { pre: [], post: [] }, on: { manual: false } });
    const parsed = parseFlowMermaid(`flowchart TD
  body --> check["Check"]
  check -->|pass| done["Done"]
  check -->|fail| done
  done -->|again| check
`);
    if (!parsed.ok) throw new Error(parsed.reason);
    const graph = layoutAutomation(parsed.model, fields);
    const [pass, fail] = graph.edges.filter((edge) => edge.source === 'check' && edge.target === 'done');
    expect(pass.data!.labelAt).toBeDefined();
    expect(fail.data!.labelAt).toBeDefined();
    expect(pass.data!.labelAt).not.toEqual(fail.data!.labelAt);
    expect(pass.data!.forward).toBe(true);

    const back = graph.edges.find((edge) => edge.source === 'done' && edge.target === 'check')!;
    expect(back.data!.forward).toBe(false);
    const handles = { source: { x: 0, y: 0 }, target: { x: 1, y: 1 } };
    // A loop back starts and ends on dagre's border points, not on the downward-facing handles.
    expect(edgePoints(back.data, handles.source, handles.target)).toEqual(back.data!.route);
  });

  it('draws a self-loop out of the node and back into it, with its label clear of every node', () => {
    for (const direction of ['TD', 'LR']) {
      const fields = sampleFields({ hooks: { pre: [], post: [] }, on: { manual: false } });
      const parsed = parseFlowMermaid(`flowchart ${direction}
  body --> check["Check"]
  check -->|retry| check
  check --> done["Done"]
`);
      if (!parsed.ok) throw new Error(parsed.reason);
      const graph = layoutAutomation(parsed.model, fields);
      const boxes = new Map(graph.nodes.map((node) => [node.id, nodeBox(node)]));
      const check = boxes.get('check')!;
      const loop = graph.edges.find((edge) => edge.source === 'check' && edge.target === 'check')!;
      const points = edgePoints(loop.data, { x: -1, y: -1 }, { x: -1, y: -1 });
      const onBorder = (p: Point) => (p.x === check.left || p.x === check.right || p.y === check.top || p.y === check.bottom) && p.x >= check.left && p.x <= check.right && p.y >= check.top && p.y <= check.bottom;
      expect(onBorder(points[0]), `${direction}: the loop leaves from the node`).toBe(true);
      expect(onBorder(points[points.length - 1]), `${direction}: the arrow lands on the node`).toBe(true);
      const drawn = sample(basisPath(points));
      expect(drawn.some((p) => !inside(p, check) && !onBorder(p)), `${direction}: the loop bends outside the node`).toBe(true);
      for (const p of drawn) for (const [id, box] of boxes) if (id !== 'check') expect(inside(p, box), `${direction}: the loop runs under ${id}`).toBe(false);
      const at = loop.data!.labelAt!;
      const size = edgeLabelSize('retry');
      const label = { left: at.x - size.width / 2, top: at.y - size.height / 2, right: at.x + size.width / 2, bottom: at.y + size.height / 2 };
      for (const [id, box] of boxes) expect(overlaps(label, box), `${direction}: the label covers ${id}`).toBe(false);
    }
  });

  it('draws a straight line between two points and a basis curve through more', () => {
    expect(basisPath([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toBe('M0,0L10,20');
    const curve = basisPath([{ x: 0, y: 0 }, { x: 0, y: 60 }, { x: 60, y: 60 }, { x: 60, y: 120 }]);
    expect(curve.startsWith('M0,0L0,10C')).toBe(true);
    expect(curve.endsWith('L60,120')).toBe(true);
    expect(edgePoints(undefined, { x: 1, y: 2 }, { x: 3, y: 4 })).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  it('puts a watch above the first step as a trigger, beside the others', () => {
    const fields = sampleFields({ on: { manual: true, schedule: { cron: '0 9 * * 1-5', catchUp: 'skip' }, watch: { script: 'scripts/watch.js', every: '5m' } } });
    const graph = layoutAutomation(withTriggerNodes(makeGeneratedFlow(fields), fields), fields);
    const node = (id: string) => graph.nodes.find((item) => item.id === id)!;
    expect(node('trigger:watch').data).toEqual(expect.objectContaining({ kind: 'trigger', subtitle: 'scripts/watch.js · every 5m' }));
    expect(graph.edges.some((edge) => edge.id === 'trigger-watch' && edge.source === 'trigger:watch' && edge.target === 'pre0')).toBe(true);
    expect(node('trigger:watch').position.y).toBe(node('trigger:manual').position.y);
    expect(node('trigger:watch').position.y).toBeLessThan(node('pre0').position.y);

    const without = sampleFields({ on: { manual: true } });
    expect(withTriggerNodes(makeGeneratedFlow(without), without).nodes.some((item) => item.id === 'trigger:watch')).toBe(false);
  });

  it('keeps a chart step called watch apart from the watch trigger', () => {
    const fields = sampleFields({ hooks: { pre: [], post: [] }, on: { manual: false, watch: { script: 'scripts/watch.js', every: '5m' } } });
    const parsed = parseFlowMermaid('flowchart TD\n  body --> watch["Watch CI"]\n');
    if (!parsed.ok) throw new Error(parsed.reason);
    const graph = layoutAutomation(withTriggerNodes(parsed.model, fields), fields);
    const ids = graph.nodes.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.nodes.find((item) => item.id === 'watch')!.data).toEqual(expect.objectContaining({ kind: 'step' }));
    expect(graph.nodes.find((item) => item.id === 'trigger:watch')!.data).toEqual(expect.objectContaining({ kind: 'trigger' }));
  });

  it('shows customize for generated charts without showing remove', () => {
    const fields = sampleFields({ name: 'daily-digest', hooks: { pre: [], post: [] } });
    render(
      <FlowCanvas
        bundle={sampleBundle(fields, null)}
        draft={sampleDraft(fields, null)}
        setDraft={vi.fn()}
        compose={null}
        selection={{ type: 'automation' }}
        setSelection={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Customize flowchart' })).toBeInTheDocument();
    expect(screen.getByText('on.manual')).toBeInTheDocument();
    expect(screen.queryByText('trigger:manual')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove flowchart' })).not.toBeInTheDocument();
    const graph = layoutAutomation(withTriggerNodes(makeGeneratedFlow(fields), fields), fields);
    expect(graph.nodes.some((node) => node.id === 'trigger:manual')).toBe(true);
  });
});

