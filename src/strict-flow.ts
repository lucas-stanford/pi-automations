// `flow: strict`: the body's flowchart and its `##` sections are one thing. Every step node has
// exactly one section, `## <label> {#<id>}`, in the chart's order, and a section that branches names
// where it can go. Pure: text in, problems out.

import { type Chart, components, parseChart } from "./chart.js";
import { isReservedNode } from "./nodes.js";

export interface FlowProblem {
  /** 1-based line in the text the caller numbered from `firstLine`; absent for chart-wide problems. */
  line?: number;
  /** `<what is wrong> — <what fixes it>`. */
  text: string;
}

interface Heading {
  /** Index into `lines`. */
  index: number;
  level: number;
  text: string;
}

interface Scan {
  lines: string[];
  /** Every heading outside a code fence, in order. */
  headings: Heading[];
  chart?: string;
}

interface Section {
  line: number;
  /** Everything under the heading up to the next `#` or `##` heading, code included. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Mermaid's `#quot;` / `#35;` codes and HTML's `&amp;` / `&#35;` / `&#x23;` as the characters they stand for. */
function decodeEntities(text: string): string {
  return text.replace(/&#x([0-9a-f]+);|(?:&#|#)(\d+);|[&#]([a-z]+);/gi, (whole, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const n = Number.parseInt((hex ?? dec) as string, hex !== undefined ? 16 : 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/** A label or heading as a reader sees it: entities decoded, no markup, no quotes, single spaces. */
export function plainText(text: string): string {
  return decodeEntities(text)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}])([*_])(.+?)\2(?=$|[^\p{L}\p{N}])/gu, "$1$3")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scan(body: string): Scan {
  const lines = body.split(/\r?\n/);
  const headings: Scan["headings"] = [];
  let chart: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1]!.startsWith("`") && open[2]!.includes("`"))) {
      const fence = open[1] as string;
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      let end = i + 1;
      while (end < lines.length && !close.test(lines[end] as string)) end++;
      if (chart === undefined && end < lines.length && /^mermaid$/i.test(open[2]!.trim().split(/\s+/)[0] ?? "")) {
        const content = lines.slice(i + 1, end);
        const first = content.map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("%%"));
        if (first !== undefined && /^(flowchart|graph)\b/i.test(first)) chart = content.join("\n");
      }
      i = end;
      continue;
    }
    const h = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (h) {
      const text = (h[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
      headings.push({ index: i, level: h[1]!.length, text });
    }
  }
  return { lines, headings, ...(chart !== undefined ? { chart } : {}) };
}

function quoted(text: string): string {
  return `"${text}"`;
}

function code(id: string): string {
  return `\`${id}\``;
}

function named(id: string, label: string): string {
  return `${code(id)} (${quoted(label)})`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function mentions(text: string, id: string, label: string): boolean {
  const word = (s: string, flags: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}_-])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`, flags);
  if (word(id, "u").test(text)) return true;
  const want = plainText(label);
  return want !== "" && word(want, "iu").test(plainText(text));
}

/**
 * Check a body against its flowchart. `firstLine` is the number of the body's first line in the
 * file, so problems point at the file. Returns every problem, in a stable order.
 */
export function checkStrictFlow(body: string, firstLine = 1): FlowProblem[] {
  const { lines, headings, chart: chartText } = scan(body);
  if (chartText === undefined) {
    return [
      {
        text: "the body has no flowchart — add a ```mermaid block that starts with flowchart TD and has a node per step, or remove flow: strict",
      },
    ];
  }

  const chart: Chart = parseChart(chartText);
  const groups = new Set(chart.subgraphs ?? []);
  const steps = chart.nodes.filter((n) => !isReservedNode(n.id) && !groups.has(n.id));
  const labels = new Map(steps.map((n) => [n.id, plainText(n.label)]));
  const problems: FlowProblem[] = [];
  const sections = new Map<string, Section>();
  const at = (index: number) => index + firstLine;
  const BOUND = /^(.*?)[ \t]*\{#([^\s{}]+)\}$/;
  const claimed = new Set(headings.filter((h) => h.level === 2).map((h) => BOUND.exec(h.text)?.[2]));
  // An unbound heading that reads like an unclaimed step, numbered or not, is that step's section.
  const guessed = new Set<string>();

  headings.forEach((h, k) => {
    if (h.level !== 2) return;
    const line = at(h.index);
    const shown = `## ${h.text}`;
    const bound = BOUND.exec(h.text);
    if (!bound) {
      const plain = plainText(h.text);
      const like = steps.find((n) => {
        const label = labels.get(n.id) as string;
        return !claimed.has(n.id) && !guessed.has(n.id) && (plain === label || plain.replace(/^\d+[.)]\s*/, "") === label);
      });
      if (like) guessed.add(like.id);
      problems.push({
        line,
        text: like
          ? `${quoted(shown)} has no node id — write \`## ${labels.get(like.id)} {#${like.id}}\``
          : `${quoted(shown)} is not a step — end it with {#id} for its node on the chart, or make it a ### under a step`,
      });
      return;
    }
    const id = bound[2] as string;
    if (isReservedNode(id)) {
      problems.push({
        line,
        text: `${quoted(shown)} names ${code(id)}, which is ${id === "body" ? "the body" : "a hook"} and has no section — give it a step's id, or make it a ### under a step`,
      });
      return;
    }
    const label = labels.get(id);
    if (label === undefined) {
      const known = steps.map((n) => n.id);
      problems.push({
        line,
        text: `${quoted(shown)} names ${code(id)}, which is not on the chart — ${known.length > 0 ? `use one of ${known.join(", ")}, or add ${id} to the chart` : `add ${id} to the chart`}`,
      });
      return;
    }
    const before = sections.get(id);
    if (before) {
      problems.push({
        line,
        text: `${code(id)} has a second section — merge it into the one on line ${before.line}`,
      });
      return;
    }
    const title = plainText(bound[1] as string);
    if (title !== label) {
      problems.push({
        line,
        text: `heading ${quoted(title)} does not match node ${code(id)}'s label ${quoted(label)} — make them the same text`,
      });
    }
    let end = lines.length;
    for (const next of headings.slice(k + 1)) {
      if (next.level <= 2) {
        end = next.index;
        break;
      }
    }
    sections.set(id, { line, text: lines.slice(h.index + 1, end).join("\n") });
  });

  for (const n of steps) {
    if (!sections.has(n.id) && !guessed.has(n.id)) {
      problems.push({
        text: `node ${named(n.id, labels.get(n.id) as string)} has no section — add \`## ${labels.get(n.id)} {#${n.id}}\``,
      });
    }
  }

  const stepIds = steps.map((n) => n.id);
  const isStep = new Set(stepIds);
  const edges: [string, string][] = [];
  for (const e of chart.edges) {
    if (isStep.has(e.from) && isStep.has(e.to) && !edges.some(([a, b]) => a === e.from && b === e.to)) {
      edges.push([e.from, e.to]);
    }
  }
  // Arrows on a loop are not ordered. Every other arrow a → b orders the two loops (or single steps)
  // they join: every section of a's group comes before every section of b's.
  const scc = components(stepIds, edges);
  const members = (id: string) => stepIds.filter((s) => scc.get(s) === scc.get(id) && sections.has(s));

  for (const id of stepIds) {
    const to = sections.get(id);
    if (!to) continue;
    let late: { a: string; b: string; x: string } | undefined;
    for (const [a, b] of edges) {
      if (scc.get(a) === scc.get(b) || scc.get(b) !== scc.get(id)) continue;
      const x = members(a).find((s) => (sections.get(s) as Section).line > to.line);
      if (x) {
        late = { a, b, x };
        break;
      }
    }
    if (late) {
      const { a, b, x } = late;
      const from = sections.get(x) as Section;
      const loops = [
        ...(x !== a ? [`${code(x)} is on a loop with ${code(a)}`] : []),
        ...(id !== b ? [`${code(id)} is on a loop with ${code(b)}`] : []),
      ];
      problems.push({
        line: to.line,
        text: `section ${code(id)} comes before ${code(x)} (line ${from.line}), but the chart goes ${a} → ${b}${loops.length > 0 ? `, and ${loops.join(" and ")}` : ""} — move ${code(id)} below ${code(x)}`,
      });
    }
  }

  for (const id of stepIds) {
    const section = sections.get(id);
    if (!section) continue;
    const next = edges.filter(([a, b]) => a === id && b !== id).map(([, b]) => b);
    if (next.length < 2) continue;
    for (const b of next) {
      const label = labels.get(b) as string;
      if (mentions(section.text, b, label)) continue;
      problems.push({
        line: section.line,
        text: `section ${code(id)} branches to ${list(next.map(code))} but never mentions ${named(b, label)} — say when to go there, for example \`then go to ${b}\``,
      });
    }
  }

  // By line, chart-wide problems last; `sort` is stable, so each keeps its order within a line.
  const key = (p: FlowProblem) => p.line ?? Number.MAX_SAFE_INTEGER;
  return problems.sort((a, b) => key(a) - key(b));
}

/** One problem as a line: `line 12: <what> — <fix>`. */
export function flowProblemLine(p: FlowProblem): string {
  return p.line !== undefined ? `line ${p.line}: ${p.text}` : p.text;
}
