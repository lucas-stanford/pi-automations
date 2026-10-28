export type FlowDirection = 'TD' | 'TB' | 'BT' | 'LR' | 'RL';
export type FlowShape =
  | 'bare'
  | 'rect'
  | 'round'
  | 'stadium'
  | 'subroutine'
  | 'cylinder'
  | 'circle'
  | 'asymmetric'
  | 'rhombus'
  | 'hexagon'
  | 'parallelogram'
  | 'parallelogramAlt'
  | 'trapezoid'
  | 'trapezoidAlt';
export type EdgeKind = 'arrow' | 'open' | 'dottedArrow' | 'dottedOpen' | 'thickArrow' | 'thickOpen' | 'circle' | 'cross';

export interface FlowNodeModel {
  id: string;
  label: string;
  shape: FlowShape;
}

export interface FlowEdgeModel {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
}

export interface FlowModel {
  direction: FlowDirection;
  nodes: FlowNodeModel[];
  edges: FlowEdgeModel[];
  /** `%%` comment lines before the `flowchart` header, kept as written. */
  headerComments?: string[];
  /** `%%` comment lines after the header, kept in order and written back right after it. */
  comments?: string[];
}

type FlowParseResult =
  | { ok: true; model: FlowModel }
  | { ok: false; reason: string; line: number; column: number };

const ID = '[A-Za-z0-9_-]+';
const HEADER_RE = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*$/;
const UNSUPPORTED_RE = /^\s*(?:subgraph\b|end\b|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|accTitle\b|accDescr\b)/;

const BARE_EDGES: Array<{ text: string; kind: EdgeKind }> = [
  { text: '-.->', kind: 'dottedArrow' },
  { text: '-.-', kind: 'dottedOpen' },
  { text: '==>', kind: 'thickArrow' },
  { text: '===', kind: 'thickOpen' },
  { text: '--o', kind: 'circle' },
  { text: '--x', kind: 'cross' },
  { text: '-->', kind: 'arrow' },
  { text: '---', kind: 'open' },
];

const TEXT_LABEL_EDGES: Array<{ re: RegExp; kind: EdgeKind }> = [
  { re: /^--\s+(.+?)\s+-->/, kind: 'arrow' },
  { re: /^--\s+(.+?)\s+---/, kind: 'open' },
  { re: /^-\.\s+(.+?)\s+\.->/, kind: 'dottedArrow' },
  { re: /^-\.\s+(.+?)\s+\.-/, kind: 'dottedOpen' },
  { re: /^==\s+(.+?)\s+==>/, kind: 'thickArrow' },
  { re: /^==\s+(.+?)\s+===/, kind: 'thickOpen' },
  { re: /^--\s+(.+?)\s+--o/, kind: 'circle' },
  { re: /^--\s+(.+?)\s+--x/, kind: 'cross' },
];

function validId(id: string): boolean {
  return new RegExp(`^${ID}$`).test(id);
}

function unquote(label: string): string {
  const trimmed = label.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function mermaidLabel(label: string): string {
  return `"${label.replace(/"/g, "'")}"`;
}

function findClosing(input: string, start: number, close: string): number {
  let quoted = false;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') quoted = !quoted;
    if (!quoted && input.startsWith(close, i)) return i;
  }
  return -1;
}

function parseNodePrefix(input: string): { node: FlowNodeModel; rest: string } | null {
  const source = input.trimStart();
  const offset = input.length - source.length;
  const idMatch = source.match(new RegExp(`^(${ID})`));
  if (!idMatch) return null;
  const id = idMatch[1];
  const afterId = source.slice(id.length);
  if (afterId.startsWith('[/') || afterId.startsWith('[\\')) {
    const closeAt = findClosing(afterId, 2, ']');
    if (closeAt < 0) return null;
    const rawLabel = afterId.slice(2, closeAt - 1);
    const consumed = offset + id.length + closeAt + 1;
    if (afterId.startsWith('[/')) {
      return { node: { id, label: unquote(rawLabel), shape: afterId[closeAt - 1] === '\\' ? 'trapezoid' : 'parallelogram' }, rest: input.slice(consumed) };
    }
    return { node: { id, label: unquote(rawLabel), shape: afterId[closeAt - 1] === '/' ? 'trapezoidAlt' : 'parallelogramAlt' }, rest: input.slice(consumed) };
  }
  const cases: Array<[FlowShape, string, string]> = [
    ['stadium', '([', '])'],
    ['subroutine', '[[', ']]'],
    ['cylinder', '[(', ')]'],
    ['circle', '((', '))'],
    ['hexagon', '{{', '}}'],
    ['rect', '[', ']'],
    ['round', '(', ')'],
    ['asymmetric', '>', ']'],
    ['rhombus', '{', '}'],
  ];
  for (const [shape, open, close] of cases) {
    if (!afterId.startsWith(open)) continue;
    const closeAt = findClosing(afterId, open.length, close);
    if (closeAt < 0) return null;
    const rawLabel = afterId.slice(open.length, closeAt);
    const consumed = offset + id.length + closeAt + close.length;
    return { node: { id, label: unquote(rawLabel), shape }, rest: input.slice(consumed) };
  }
  return { node: { id, label: id, shape: 'bare' }, rest: input.slice(offset + id.length) };
}

function readPipeLabel(source: string): { label?: string; rest: string } {
  const text = source.trimStart();
  if (!text.startsWith('|')) return { rest: text };
  const end = text.indexOf('|', 1);
  if (end < 0) return { rest: text };
  return { label: unquote(text.slice(1, end)), rest: text.slice(end + 1).trimStart() };
}

function readEdge(input: string): { rest: string; kind: EdgeKind; label?: string } | null {
  const source = input.trimStart();
  for (const pattern of TEXT_LABEL_EDGES) {
    const match = source.match(pattern.re);
    if (match) return { kind: pattern.kind, label: unquote(match[1]), rest: source.slice(match[0].length).trimStart() };
  }
  for (const edge of BARE_EDGES) {
    if (!source.startsWith(edge.text)) continue;
    const pipe = readPipeLabel(source.slice(edge.text.length));
    return { kind: edge.kind, ...(pipe.label ? { label: pipe.label } : {}), rest: pipe.rest };
  }
  return null;
}

export function parseFlowMermaid(text: string): FlowParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const nodes = new Map<string, FlowNodeModel>();
  const edges: FlowEdgeModel[] = [];
  const headerComments: string[] = [];
  const comments: string[] = [];
  let direction: FlowDirection = 'TD';
  let sawHeader = false;

  // A Map keeps the order ids were first seen, even when a later declaration replaces the node.
  const addNode = (node: FlowNodeModel) => {
    if (node.shape !== 'bare' || !nodes.has(node.id)) nodes.set(node.id, node);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // `%%` comments are kept and written back, never read as statements.
    if (trimmed.startsWith('%%')) {
      (sawHeader ? comments : headerComments).push(trimmed);
      continue;
    }
    const header = trimmed.match(HEADER_RE);
    if (header) {
      if (!sawHeader) direction = (header[1] as FlowDirection | undefined) ?? 'TD';
      sawHeader = true;
      continue;
    }
    if (!sawHeader) return { ok: false, reason: 'Missing flowchart header', line: i + 1, column: 1 };
    if (UNSUPPORTED_RE.test(trimmed) || trimmed.includes('&')) {
      return { ok: false, reason: `Unsupported Mermaid construct: ${trimmed.split(/\s+/)[0]}`, line: i + 1, column: line.indexOf(trimmed) + 1 };
    }

    const first = parseNodePrefix(trimmed);
    if (!first || !validId(first.node.id)) {
      return { ok: false, reason: 'Invalid node id; use ASCII letters, digits, - or _', line: i + 1, column: 1 };
    }
    let current = first.node;
    addNode(current);
    let chain = first.rest;
    while (chain.trim() !== '') {
      const edge = readEdge(chain);
      if (!edge) return { ok: false, reason: 'Unsupported arrow syntax', line: i + 1, column: Math.max(1, line.length - chain.length + 1) };
      const targetRead = parseNodePrefix(edge.rest);
      if (!targetRead || !validId(targetRead.node.id)) {
        return { ok: false, reason: 'Invalid node id; use ASCII letters, digits, - or _', line: i + 1, column: Math.max(1, line.indexOf(edge.rest) + 1) };
      }
      const target = targetRead.node;
      addNode(target);
      edges.push({
        id: `e${edges.length}`,
        source: current.id,
        target: target.id,
        kind: edge.kind,
        ...(edge.label ? { label: edge.label } : {}),
      });
      chain = targetRead.rest;
      current = target;
    }
  }

  if (!sawHeader) return { ok: false, reason: 'Missing flowchart header', line: 1, column: 1 };
  return {
    ok: true,
    model: {
      direction,
      nodes: [...nodes.values()],
      edges,
      ...(headerComments.length ? { headerComments } : {}),
      ...(comments.length ? { comments } : {}),
    },
  };
}

function nodeSyntax(node: FlowNodeModel): string {
  const label = mermaidLabel(node.label);
  switch (node.shape) {
    case 'bare': return node.id === node.label ? node.id : `${node.id}[${label}]`;
    case 'rect': return `${node.id}[${label}]`;
    case 'round': return `${node.id}(${label})`;
    case 'stadium': return `${node.id}([${label}])`;
    case 'subroutine': return `${node.id}[[${label}]]`;
    case 'cylinder': return `${node.id}[(${label})]`;
    case 'circle': return `${node.id}((${label}))`;
    case 'asymmetric': return `${node.id}>${label}]`;
    case 'rhombus': return `${node.id}{${label}}`;
    case 'hexagon': return `${node.id}{{${label}}}`;
    case 'parallelogram': return `${node.id}[/${label}/]`;
    case 'parallelogramAlt': return `${node.id}[\\${label}\\]`;
    case 'trapezoid': return `${node.id}[/${label}\\]`;
    case 'trapezoidAlt': return `${node.id}[\\${label}/]`;
  }
}

function edgeSyntax(edge: FlowEdgeModel): string {
  const arrow: Record<EdgeKind, string> = {
    arrow: '-->', open: '---', dottedArrow: '-.->', dottedOpen: '-.-', thickArrow: '==>', thickOpen: '===', circle: '--o', cross: '--x',
  };
  if (edge.label) return `${edge.source} ${arrow[edge.kind]}|${mermaidLabel(edge.label)}| ${edge.target}`;
  return `${edge.source} ${arrow[edge.kind]} ${edge.target}`;
}

export function serializeFlowMermaid(model: FlowModel): string {
  const declared = new Set<string>();
  const lines = [...(model.headerComments ?? []), `flowchart ${model.direction}`, ...(model.comments ?? []).map((comment) => `  ${comment}`)];
  for (const node of model.nodes) {
    lines.push(`  ${nodeSyntax(node)}`);
    declared.add(node.id);
  }
  for (const edge of model.edges) {
    if (!declared.has(edge.source)) lines.push(`  ${edge.source}`);
    if (!declared.has(edge.target)) lines.push(`  ${edge.target}`);
    lines.push(`  ${edgeSyntax(edge)}`);
  }
  return `${lines.join('\n')}\n`;
}
