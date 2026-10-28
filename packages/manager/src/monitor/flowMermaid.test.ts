import { describe, expect, it } from 'vitest';
import { parseFlowMermaid, serializeFlowMermaid } from './flowMermaid';

const charts = [
  `flowchart TD\n  pre0["Prepare run context"] --> body["Coordinate status-note subagents"]\n  body --> outline["Draft outline"]\n  body --> facts["Collect run facts"]\n  outline --> compose["Combine worker results"]\n  facts --> compose\n  compose --> post0["Save result"]\n`,
  `flowchart TD\n  pre0["Pick the next issue"] --> body["Triage the issue"]\n  body --> post0["Save the report"]\n`,
  `flowchart TD\n  body["Review one pull request and save the review"]\n`,
  `flowchart TD\n  start[Start automation] --> select[Select issue]\n  select --> triage[Triage issue]\n`,
];

describe('flowMermaid', () => {
  it('parses and serializes typical charts without dropping nodes or edges', () => {
    for (const chart of charts) {
      const parsed = parseFlowMermaid(chart);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const again = parseFlowMermaid(serializeFlowMermaid(parsed.model));
        expect(again).toMatchObject({ ok: true });
        if (again.ok) expect(again.model).toEqual(parsed.model);
      }
    }
  });

  it('supports quoted delimiter labels, whitespace-free arrows, chains and authored definitions', () => {
    const parsed = parseFlowMermaid(`graph LR\n  a["Tests [all] pass?"]-->b\n  a["Authored label"]\n  b --> c --> d\n  a -->|"yes"| c\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.model.direction).toBe('LR');
    expect(parsed.model.nodes.find((node) => node.id === 'a')?.label).toBe('Authored label');
    expect(parsed.model.edges.map((edge) => [edge.source, edge.target, edge.kind, edge.label])).toEqual([
      ['a', 'b', 'arrow', undefined],
      ['b', 'c', 'arrow', undefined],
      ['c', 'd', 'arrow', undefined],
      ['a', 'c', 'arrow', 'yes'],
    ]);
  });

  it('supports every node shape and edge kind with text labels', () => {
    const parsed = parseFlowMermaid(`flowchart BT\n  r[Rect] -- open --- o(Round)\n  o -- arrow --> s([Stadium])\n  s -. dotted .-> sub[[Subroutine]]\n  sub -. dotted open .- cyl[(Cylinder)]\n  cyl == thick ==> cir((Circle))\n  cir == thick open === asym>Asym]\n  asym -- circle --o rh{Rhombus}\n  rh -- cross --x hex{{Hexagon}}\n  hex --> para[/Para/] --> para2[\\Para2\\] --> trap[/Trap\\] --> trap2[\\Trap2/]\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.model.nodes.map((node) => node.shape)).toEqual([
      'rect', 'round', 'stadium', 'subroutine', 'cylinder', 'circle', 'asymmetric', 'rhombus', 'hexagon', 'parallelogram', 'parallelogramAlt', 'trapezoid', 'trapezoidAlt',
    ]);
    expect(parsed.model.edges.slice(0, 8).map((edge) => [edge.kind, edge.label])).toEqual([
      ['open', 'open'], ['arrow', 'arrow'], ['dottedArrow', 'dotted'], ['dottedOpen', 'dotted open'], ['thickArrow', 'thick'], ['thickOpen', 'thick open'], ['circle', 'circle'], ['cross', 'cross'],
    ]);
  });

  it('only lets the first header set direction', () => {
    const parsed = parseFlowMermaid(`flowchart LR\n  a --> b\ngraph TD\n  b --> c\n`);
    expect(parsed).toMatchObject({ ok: true, model: { direction: 'LR' } });
  });

  it('serializes double quotes as single quotes', () => {
    const parsed = parseFlowMermaid(`flowchart TD\n  a["Say "]\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    parsed.model.nodes[0].label = 'Say "hello"';
    expect(serializeFlowMermaid(parsed.model)).toContain(`a["Say 'hello'"]`);
  });

  it('keeps %% comments, before and after the header, through a round trip', () => {
    const text = `%% written by hand\nflowchart TD\n  %% pi moves pre0 and body\n  pre0["Pick"] --> body["Triage"]\n  %% the agent reports the rest\n  body --> read["Read"]\n`;
    const parsed = parseFlowMermaid(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.model.headerComments).toEqual(['%% written by hand']);
    expect(parsed.model.comments).toEqual(['%% pi moves pre0 and body', '%% the agent reports the rest']);
    expect(parsed.model.nodes.map((node) => node.id)).toEqual(['pre0', 'body', 'read']);
    const serialized = serializeFlowMermaid(parsed.model);
    expect(serialized.startsWith('%% written by hand\nflowchart TD\n  %% pi moves pre0 and body\n  %% the agent reports the rest\n')).toBe(true);
    const again = parseFlowMermaid(serialized);
    expect(again).toMatchObject({ ok: true });
    if (again.ok) expect(again.model).toEqual(parsed.model);
  });

  it('parses a chart with a comment between its statements', () => {
    const parsed = parseFlowMermaid(`flowchart TD\n  %% pi moves pre0 and body; the agent reports read, reproduce and draft.\n  pre0["Pick the next issue"] --> body["Triage the issue"]\n  body --> read["Read the issue"]\n  read --> reproduce["Try it on staging"]\n  read -->|no browser needed| draft["Draft the verdict"]\n  reproduce --> draft\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.model.edges.map((edge) => `${edge.source}>${edge.target}${edge.label ? `:${edge.label}` : ''}`)).toEqual([
      'pre0>body', 'body>read', 'read>reproduce', 'read>draft:no browser needed', 'reproduce>draft',
    ]);
  });

  it('refuses constructs that the structured editor cannot preserve', () => {
    const parsed = parseFlowMermaid(`flowchart TD\n  subgraph prep[Prepare]\n    a --> b\n  end\n`);
    expect(parsed).toMatchObject({ ok: false, line: 2 });
  });
});
