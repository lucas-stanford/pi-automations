// The `g` pane: read-only, cached by (run, revision). Never a clipped graph; falls back to the step
// list.
import { chartState } from "../../progress.js";
import { buildGraphLines, buildStepListLines, graphTooWideLine, graphWidth } from "../../ui/graph.js";
/** Bounded, so a long session watching many runs does not hold every frame of every one. */
const CACHE_MAX = 64;
export function createFlowViewer(options = {}) {
    const cache = new Map();
    let problem;
    const theme = () => options.theme?.();
    const graphFor = (snap) => {
        const render = options.render;
        if (!render)
            return undefined;
        const key = `${snap.run}\u0000${snap.revision}\u0000${snap.closed}`;
        let hit = cache.get(key);
        if (!hit) {
            let out;
            try {
                out = render({ plan: snap.chart, state: chartState(snap), format: "text" });
            }
            catch (e) {
                out = { problem: e?.message ?? String(e) };
            }
            hit = "problem" in out ? { problem: out.problem } : { lines: graphLinesOf(out.text) };
            cache.set(key, hit);
            while (cache.size > CACHE_MAX) {
                const oldest = cache.keys().next();
                if (oldest.done)
                    break;
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
            if (!snap || snap.nodes.length === 0)
                return undefined;
            const list = buildStepListLines(snap.nodes, width, theme());
            const graph = graphFor(snap);
            if (!graph)
                return { kind: "list", lines: list };
            const lines = buildGraphLines({ lines: graph.lines, width, theme: theme() });
            if (lines)
                return { kind: "graph", lines };
            return { kind: "list", lines: [...list, "", graphTooWideLine(graphWidth(graph.lines), width, theme())] };
        },
        lines(snap, width = 100) {
            if (!snap || snap.nodes.length === 0)
                return undefined;
            // Uncoloured: the entry renderer applies whatever theme is current when it draws.
            return buildStepListLines(snap.nodes, width);
        },
    };
}
function graphLinesOf(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    // A renderer pads every line to the graph's width, so trailing blanks are layout, not content.
    while (lines.length > 0 && lines[lines.length - 1].trim() === "")
        lines.pop();
    return lines;
}
//# sourceMappingURL=flow-viewer.js.map