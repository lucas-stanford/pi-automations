// Just enough of a Mermaid flowchart to know its nodes and arrows; everything else is skipped.
/** Opening and closing delimiters, longest first so `((` wins over `(`. */
const SHAPES = [
    ["(((", [")))"]],
    ["((", ["))"]],
    ["([", ["])"]],
    ["[[", ["]]"]],
    ["[(", [")]"]],
    ["{{", ["}}"]],
    ["[/", ["/]", "\\]"]],
    ["[\\", ["\\]", "/]"]],
    ["[", ["]"]],
    ["(", [")"]],
    ["{", ["}"]],
    [">", ["]"]],
];
const SKIP = /^(subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;
const HEADER = /^(flowchart|graph)\b/i;
const ID = /^[\p{L}\p{N}_]+(?:[-.](?![-.>=])[\p{L}\p{N}_]+)*/u;
/** A link at the start of `s`: its length in characters and its label, or nothing. */
function readLink(s) {
    // `-- text -->`, `== text ==>`, `-. text .->`: the label sits inside the arrow.
    const inline = /^(<?)(--|==|-\.)\s+([^|]*?)\s+(-{2,}[>ox]?|={2,}[>ox]?|\.-+[>ox]?|-{3,})(?=\s|[\p{L}\p{N}_"])/u.exec(s);
    if (inline) {
        const label = (inline[3] ?? "").trim();
        return { length: inline[0].length, ...(label ? { label } : {}) };
    }
    const arrow = /^[<ox]?(?:-{2,}|={2,}|-\.+-|~{3,})[>ox]?/.exec(s);
    if (!arrow)
        return undefined;
    let length = arrow[0].length;
    const rest = s.slice(length);
    const pipe = /^\s*\|([^|]*)\|/.exec(rest);
    if (pipe) {
        length += pipe[0].length;
        const label = unquote((pipe[1] ?? "").trim());
        return { length, ...(label ? { label } : {}) };
    }
    return { length };
}
function unquote(s) {
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"'))
        return s.slice(1, -1);
    return s;
}
/** One node at the start of `s`: its id, its label if it has one, and how much it used. */
function readNode(s) {
    const m = ID.exec(s);
    if (!m)
        return undefined;
    const id = m[0];
    let at = id.length;
    let label;
    for (const [open, closes] of SHAPES) {
        if (!s.startsWith(open, at))
            continue;
        let i = at + open.length;
        let text;
        if (s[i] === '"') {
            const end = s.indexOf('"', i + 1);
            if (end === -1)
                return { id, length: at };
            text = s.slice(i + 1, end);
            i = end + 1;
            const close = closes.find((c) => s.startsWith(c, i));
            if (!close)
                return { id, length: at };
            i += close.length;
        }
        else {
            let best = -1;
            let used = "";
            for (const c of closes) {
                const end = s.indexOf(c, i);
                if (end !== -1 && (best === -1 || end < best)) {
                    best = end;
                    used = c;
                }
            }
            if (best === -1)
                return { id, length: at };
            text = s.slice(i, best);
            i = best + used.length;
        }
        label = text.trim();
        at = i;
        break;
    }
    const cls = /^:::[\w-]+/.exec(s.slice(at));
    if (cls)
        at += cls[0].length;
    return { id, ...(label !== undefined && label !== "" ? { label } : {}), length: at };
}
/** Split on `;` outside quotes, so `a --> b; b --> c` is two statements. */
function statements(line) {
    const out = [];
    let quoted = false;
    let start = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"')
            quoted = !quoted;
        else if (ch === ";" && !quoted) {
            out.push(line.slice(start, i));
            start = i + 1;
        }
    }
    out.push(line.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
}
/** Read a flowchart's nodes, in order of first appearance, and its arrows. */
export function parseChart(text) {
    const nodes = new Map();
    const edges = [];
    const subgraphs = [];
    const see = (id, label) => {
        const known = nodes.get(id);
        if (!known)
            nodes.set(id, { id, label: label ?? id });
        else if (label !== undefined && known.label === id)
            known.label = label;
    };
    for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
        const line = raw.replace(/%%.*$/, "").trim();
        if (line === "" || HEADER.test(line))
            continue;
        for (const statement of statements(line)) {
            const group = /^subgraph\s+(.*)$/.exec(statement);
            if (group) {
                // `subgraph id [title]` or `subgraph id`; a bare title with spaces has no id to point at.
                const id = ID.exec(group[1])?.[0];
                if (id && !subgraphs.includes(id) && /^\s*(\[|$)/.test(group[1].slice(id.length)))
                    subgraphs.push(id);
                continue;
            }
            if (SKIP.test(statement))
                continue;
            let rest = statement;
            let previous;
            let pendingLabel;
            while (rest.length > 0) {
                // A group: `a & b & c`.
                const group = [];
                for (;;) {
                    const node = readNode(rest);
                    if (!node)
                        break;
                    see(node.id, node.label);
                    group.push(node.id);
                    rest = rest.slice(node.length).trimStart();
                    if (!rest.startsWith("&"))
                        break;
                    rest = rest.slice(1).trimStart();
                }
                if (group.length === 0)
                    break;
                if (previous) {
                    for (const from of previous) {
                        for (const to of group) {
                            edges.push({ from, to, ...(pendingLabel ? { label: pendingLabel } : {}) });
                        }
                    }
                }
                const link = readLink(rest);
                if (!link)
                    break;
                previous = group;
                pendingLabel = link.label;
                rest = rest.slice(link.length).trimStart();
            }
        }
    }
    return { nodes: [...nodes.values()], edges, subgraphs };
}
/** The ids reachable in one step from `id`, in chart order and without repeats. */
export function successorsOf(chart, id) {
    const out = [];
    for (const e of chart.edges)
        if (e.from === id && !out.includes(e.to))
            out.push(e.to);
    return out;
}
/** Each node's strongly connected component: nodes on a loop together share one. Tarjan's. */
export function components(ids, edges) {
    const out = new Map();
    const index = new Map();
    const low = new Map();
    const stack = [];
    let next = 0;
    let count = 0;
    const visit = (id) => {
        index.set(id, next);
        low.set(id, next);
        next++;
        stack.push(id);
        for (const [from, to] of edges) {
            if (from !== id)
                continue;
            if (!index.has(to)) {
                visit(to);
                low.set(id, Math.min(low.get(id), low.get(to)));
            }
            else if (!out.has(to)) {
                low.set(id, Math.min(low.get(id), index.get(to)));
            }
        }
        if (low.get(id) === index.get(id)) {
            let member;
            do {
                member = stack.pop();
                out.set(member, count);
            } while (member !== id);
            count++;
        }
    };
    for (const id of ids)
        if (!index.has(id))
            visit(id);
    return out;
}
/**
 * The nodes in the order a run goes through them: each after every node with an arrow into it.
 * A loop's nodes stay together, in chart order; ties keep chart order. A shortcut such as
 * `body --> post` therefore no longer pulls `post` ahead of the steps on the longer path.
 */
export function flowOrder(chart) {
    const ids = chart.nodes.map((n) => n.id);
    const at = new Map(ids.map((id, i) => [id, i]));
    const edges = chart.edges
        .filter((e) => at.has(e.from) && at.has(e.to))
        .map((e) => [e.from, e.to]);
    const scc = components(ids, edges);
    const groups = new Map();
    for (const id of ids) {
        const g = scc.get(id);
        groups.set(g, [...(groups.get(g) ?? []), id]);
    }
    const first = (g) => at.get(groups.get(g)[0]);
    const waiting = new Map([...groups.keys()].map((g) => [g, 0]));
    const after = new Map();
    for (const [a, b] of edges) {
        const ga = scc.get(a);
        const gb = scc.get(b);
        if (ga === gb || after.get(ga)?.has(gb))
            continue;
        after.set(ga, (after.get(ga) ?? new Set()).add(gb));
        waiting.set(gb, waiting.get(gb) + 1);
    }
    const ready = [...groups.keys()].filter((g) => waiting.get(g) === 0);
    const order = [];
    while (ready.length > 0) {
        ready.sort((x, y) => first(x) - first(y));
        const g = ready.shift();
        order.push(...groups.get(g));
        for (const h of after.get(g) ?? []) {
            const left = waiting.get(h) - 1;
            waiting.set(h, left);
            if (left === 0)
                ready.push(h);
        }
    }
    const byId = new Map(chart.nodes.map((n) => [n.id, n]));
    return order.map((id) => byId.get(id));
}
//# sourceMappingURL=chart.js.map