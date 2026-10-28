// The `g` pane: read-only, cached by (run, revision). Never a clipped graph; falls back to the step
// list.

import { chartState, type ProgressSnapshot } from "../../progress.js";
import type { RenderChart } from "../../core/contracts.js";
import { buildGraphLines, buildStepListLines, graphTooWideLine, graphWidth } from "../../ui/graph.js";
import type { LineTheme } from "../../ui/theme.js";
import type { FlowPane } from "../../ui/window.js";

export type { FlowPane };

export interface FlowViewerOptions {
  /** How to draw a chart, or nothing: then every pane is the step list. */
  render?: RenderChart;
  /** The current theme, or nothing. The builders never need pi to draw. */
  theme?: () => LineTheme | undefined;
}

export interface FlowViewer {
  /** The pane for a run, or `undefined` when it is not tracked. */
  pane(snapshot: ProgressSnapshot | undefined, width: number): FlowPane | undefined;
  /** Plain uncoloured lines for a finished run, stored on a transcript entry. */
  lines(snapshot: ProgressSnapshot | undefined, width?: number): string[] | undefined;
  /** The last render problem, shown once rather than on every frame. */
  readonly problem: string | undefined;
  /** Forget everything cached. Reload and disposal call this. */
  clear(): void;
}

/** Bounded, so a long session watching many runs does not hold every frame of every one. */
const CACHE_MAX = 64;

export function createFlowViewer(options: FlowViewerOptions = {}): FlowViewer {
  const cache = new Map<string, { lines: string[] } | { problem: string }>();
  let problem: string | undefined;

  const theme = (): LineTheme | undefined => options.theme?.();

  const graphFor = (snap: ProgressSnapshot): { lines: string[] } | undefined => {
    const render = options.render;
    if (!render) return undefined;
    const key = `${snap.run}\u0000${snap.revision}\u0000${snap.closed}`;
    let hit = cache.get(key);
    if (!hit) {
      let out: { text: string } | { problem: string };
      try {
        out = render({ plan: snap.chart, state: chartState(snap), format: "text" });
      } catch (e) {
        out = { problem: (e as Error)?.message ?? String(e) };
      }
      hit = "problem" in out ? { problem: out.problem } : { lines: graphLinesOf(out.text) };
      cache.set(key, hit);
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
    }
    if ("problem" in hit) {
      problem = hit.problem;
      return undefined;
    }
    return hit;
  };

  return {
    get problem() {
      return problem;
    },

    clear() {
      cache.clear();
    },

    pane(snap, width) {
      if (!snap || snap.nodes.length === 0) return undefined;
      const list = buildStepListLines(snap.nodes, width, theme());
      const graph = graphFor(snap);
      if (!graph) return { kind: "list", lines: list };

      const lines = buildGraphLines({ lines: graph.lines, width, theme: theme() });
      if (lines) return { kind: "graph", lines };
      return { kind: "list", lines: [...list, "", graphTooWideLine(graphWidth(graph.lines), width, theme())] };
    },

    lines(snap, width = 100) {
      if (!snap || snap.nodes.length === 0) return undefined;
      // Uncoloured: the entry renderer applies whatever theme is current when it draws.
      return buildStepListLines(snap.nodes, width);
    },
  };
}

function graphLinesOf(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // A renderer pads every line to the graph's width, so trailing blanks are layout, not content.
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === "") lines.pop();
  return lines;
}
