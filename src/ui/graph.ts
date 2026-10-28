// A run's chart: fm's text graph coloured by glyph from pi's theme, or the step list. Pure.

import { FLOW_GLYPH, type FlowNodeStatus } from "../flow-plan.js";
import type { RunLink, RunNote } from "../types.js";
import { GLYPH } from "./glyphs.js";
import { type LineTheme, PLAIN_THEME, type UiColor } from "./theme.js";
import { stripControls, truncateToWidth, visibleWidth } from "./width.js";

/** The theme colour each status is drawn in. */
const STATUS_COLOR: Record<FlowNodeStatus, UiColor> = {
  done: "success",
  active: "accent",
  waiting: "warning",
  failed: "error",
  skipped: "dim",
  interrupted: "warning",
  unknown: "warning",
  pending: "muted",
};

/** Glyph → colour, derived from the two maps so they cannot drift apart. */
const GLYPH_COLOR: [string, UiColor][] = (
  Object.keys(FLOW_GLYPH) as FlowNodeStatus[]
).map((status) => [FLOW_GLYPH[status], STATUS_COLOR[status]]);

/** Does this line already carry colour? Then it is the renderer's to own. */
function hasAnsi(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\u001B\[/.test(s);
}

/** Colour only the glyph, not the text after it, so colour never bleeds across a box border. */
export function colorGraphLine(line: string, theme?: LineTheme): string {
  const t = theme ?? PLAIN_THEME;
  if (hasAnsi(line)) return line;
  let out = "";
  for (const [index, ch] of [...line].entries()) {
    const hit = GLYPH_COLOR.find(([g]) => g === ch);
    const previous = line[index - 1];
    const next = line[index + 1];
    const isStatusGlyph =
      ch !== FLOW_GLYPH.unknown || (!/\w/.test(previous ?? "") && !/\w/.test(next ?? ""));
    out += hit && isStatusGlyph ? t.fg(hit[1], ch) : ch;
  }
  return out;
}

export interface GraphLinesOptions {
  /** The text graph, already split into lines. */
  lines: string[];
  /** The pane this must fit in. */
  width: number;
  theme?: LineTheme;
}

/** The coloured graph, or undefined when it does not fit (never clipped). */
export function buildGraphLines(opts: GraphLinesOptions): string[] | undefined {
  const t = opts.theme ?? PLAIN_THEME;
  const width = graphWidth(opts.lines);
  if (width > opts.width) return undefined;
  return opts.lines.map((l) => truncateToWidth(colorGraphLine(l.replace(/\s+$/, ""), t), opts.width));
}

/** The widest line in the graph, ignoring the padding a renderer adds to square it off. */
export function graphWidth(lines: string[]): number {
  return lines.reduce((w, l) => Math.max(w, visibleWidth(l.replace(/\s+$/, ""))), 0);
}

/** What to say when the graph will not fit, with its actual width. */
export function graphTooWideLine(width: number, pane: number, theme?: LineTheme): string {
  const t = theme ?? PLAIN_THEME;
  return t.fg(
    "muted",
    `└ flowchart is ${width} columns wide and the pane is ${pane} — showing the steps instead`,
  );
}

/** One node of a step list: what the progress store or a record says about it. */
export interface StepListNode {
  id: string;
  label: string;
  status: string;
  text?: string | null;
}

/** The run's chart as a list, one node per line, for when there is no graph to show. */
export function buildStepListLines(nodes: readonly StepListNode[], width: number, theme?: LineTheme): string[] {
  const t = theme ?? PLAIN_THEME;
  // Labels come from a chart and messages from an agent: neither may carry a control character.
  const labels = nodes.map((n) => stripControls(n.label));
  const labelW = Math.min(36, Math.max(4, ...labels.map((l) => visibleWidth(l))));
  return nodes.map((n, i) => {
    const status = (n.status in FLOW_GLYPH ? n.status : "unknown") as FlowNodeStatus;
    const glyph = t.fg(STATUS_COLOR[status], FLOW_GLYPH[status]);
    const label = t.fg(status === "pending" ? "muted" : "text", padRight(truncateToWidth(labels[i] as string, labelW), labelW));
    const said = stripControls((n.text ?? "").replace(/\s+/g, " ")).trim();
    const text = said ? t.fg("muted", ` · ${said}`) : "";
    return truncateToWidth(`${glyph} ${label}  ${t.fg(STATUS_COLOR[status], status.padEnd(11))}${text}`, width);
  });
}

function padRight(s: string, n: number): string {
  const w = visibleWidth(s);
  return w >= n ? s : s + " ".repeat(n - w);
}

/** A terminal hyperlink (OSC 8); control characters are stripped from both halves. */
export function hyperlink(url: string, label: string = url): string {
  return `\u001B]8;;${stripControls(url)}\u001B\\${stripControls(label)}\u001B]8;;\u001B\\`;
}

/** `label ↗ https://…`, clickable, and cut to `width` without ever cutting the link in half. */
export function linkLine(raw: RunLink, width: number, indent: string, theme?: LineTheme): string {
  const t = theme ?? PLAIN_THEME;
  const link: RunLink = {
    url: stripControls(raw.url),
    ...(raw.label !== undefined ? { label: stripControls(raw.label) } : {}),
  };
  const room = Math.max(8, width - visibleWidth(indent) - 2);
  if (!link.label || link.label === link.url) {
    const shown = truncateToWidth(link.url, room);
    return `${indent}${t.fg("accent", "↗")} ${t.fg("accent", hyperlink(link.url, shown))}`;
  }
  const label = truncateToWidth(link.label, Math.max(4, Math.floor(room / 2)));
  const rest = room - visibleWidth(label) - 1;
  const url = rest >= 8 ? ` ${t.fg("muted", hyperlink(link.url, truncateToWidth(link.url, rest)))}` : "";
  return `${indent}${t.fg("accent", "↗")} ${t.fg("accent", hyperlink(link.url, label))}${url}`;
}

/** A run's notes: each note's text, then its links underneath, newest last. */
export function noteLines(notes: readonly RunNote[], width: number, theme?: LineTheme, indent = "  "): string[] {
  const t = theme ?? PLAIN_THEME;
  const out: string[] = [];
  for (const note of notes) {
    const text = stripControls(note.text.replace(/\s+/g, " ")).trim();
    out.push(truncateToWidth(`${indent}${t.fg("text", text)}`, width));
    for (const link of note.links) out.push(linkLine(link, width, `${indent}  `, theme));
  }
  return out;
}

/** Notes as a small table: text, then links in one column. No colour. */
export function noteRows(notes: readonly RunNote[], width: number, indent = ""): string[] {
  const texts = notes.map((n) => stripControls(n.text.replace(/\s+/g, " ")).trim());
  const room = Math.max(1, width - visibleWidth(indent));
  const textW = Math.min(Math.max(0, ...texts.map((t) => visibleWidth(t))), Math.max(8, Math.floor(room * 0.55)));
  return notes.map((note, i) => {
    const links = (note.links ?? []).map((raw) => {
      const url = stripControls(raw.url);
      const label = raw.label ? stripControls(raw.label).replace(/\s+/g, " ").trim() : "";
      return `${GLYPH.link} ${hyperlink(url, ellipsizePlain(label || url.replace(/^https?:\/\//, ""), 40))}`;
    });
    const text = texts[i] as string;
    if (links.length === 0) return truncateToWidth(`${indent}${ellipsizePlain(text, room)}`, width);
    const tail = links.join("  ");
    const head = padRight(ellipsizePlain(text, textW), textW);
    return truncateToWidth(`${indent}${head}${textW > 0 ? "   " : ""}${tail}`, width);
  });
}

function ellipsizePlain(s: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(s) <= max) return s;
  return max === 1 ? "…" : `${truncateToWidth(s, max - 1)}…`;
}