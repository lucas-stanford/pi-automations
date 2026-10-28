// A run's message for its reader, as every page shows it: its own `pa message`, else its notes,
// else what it answered. Links always come with it, and are kept before text when room is short.
// Pure.

import type { RunLink, RunRecord } from "../types.js";
import { wrapWords } from "./details.js";
import { linkLine } from "./graph.js";
import { type LineTheme, PLAIN_THEME } from "./theme.js";
import { ellipsize, stripControls, truncateToWidth, visibleWidth } from "./width.js";

export interface ShownMessage {
  /** Where it came from: the run's own message, its notes, or its final reply. */
  from: "message" | "notes" | "reply";
  text: string;
  links: RunLink[];
}

/** What a run left for its reader, by the fallback every surface shares. */
export function shownMessage(rec: RunRecord | undefined): ShownMessage | undefined {
  if (!rec) return undefined;
  if (rec.message) return withInlineLinks("message", rec.message.text, rec.message.links);
  const notes = rec.notes ?? [];
  if (notes.length > 0) {
    return withInlineLinks(
      "notes",
      notes.map((n) => n.text.trim()).filter(Boolean).join(" · "),
      notes.flatMap((n) => n.links),
    );
  }
  const reply = replyOf(rec);
  return reply ? withInlineLinks("reply", reply, []) : undefined;
}

const INLINE_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Links written into the text as `[label](https://…)` become link rows too, after the given ones. */
function withInlineLinks(from: ShownMessage["from"], text: string, links: readonly RunLink[]): ShownMessage {
  const inline: RunLink[] = [...text.matchAll(INLINE_LINK)].map((m) => ({ label: m[1]!.trim(), url: m[2]! }));
  return { from, text, links: uniqueLinks([...links, ...inline]) };
}

/**
 * Only what the run itself produced: a failure's error, else the lead line of its output. A run that
 * said nothing (ok without output, skipped, missed) has no reply, rather than a summary made up for it.
 */
function replyOf(rec: RunRecord): string | undefined {
  if (rec.outcome === "failed") return rec.error?.message?.trim() || undefined;
  const lead = (rec.output?.text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return lead || undefined;
}

function uniqueLinks(links: readonly RunLink[]): RunLink[] {
  const seen = new Set<string>();
  return links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
}

/**
 * Message text on one line, as a reader sees it: Markdown emphasis, code ticks and link targets
 * dropped (links show as their own rows), and nothing in it a terminal would act on.
 */
export function messageText(text: string): string {
  const plain = text
    .replace(INLINE_LINK, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1");
  return stripControls(plain.replace(/\s+/g, " ")).trim();
}

/** The most text lines and links the area under the list ever shows. */
const TEXT_MAX = 4;
const LINKS_MAX = 5;

export interface MessageAreaOptions {
  name: string;
  /** `today 08:01`: when the run ended, in the page's words. */
  when: string;
  shown: ShownMessage;
  width: number;
  /** Rows it may take, its blank separator and heading included. Unbounded when absent. */
  room?: number;
  theme?: LineTheme;
}

/**
 * The area under the list: a blank line, `── Last message · name · when ───`, the text, then each
 * link on its own row. Short of room, text is trimmed before any link; under three rows, nothing.
 */
export function messageAreaLines(opts: MessageAreaOptions): string[] {
  const t = opts.theme ?? PLAIN_THEME;
  const width = Math.max(1, opts.width);
  const indent = "    ";
  const textW = Math.max(8, width - indent.length);
  const text = messageText(opts.shown.text);
  const wrapped = text ? wrapWords(text, textW) : [];
  const links = opts.shown.links;
  const naturalLinks = links.length > LINKS_MAX ? LINKS_MAX : links.length;
  const natural = 2 + Math.min(TEXT_MAX, wrapped.length) + naturalLinks;
  const room = Math.min(natural, opts.room ?? natural);
  if (room < 3) return [];

  const k = room - 2;
  // Links first: text gets the rows they leave.
  const linkRows = Math.min(naturalLinks, k);
  const textRows = Math.min(TEXT_MAX, wrapped.length, k - linkRows);

  const out = ["", headingLine(opts.name, opts.when, width, t)];
  const shownText = wrapped.slice(0, textRows);
  if (textRows < wrapped.length && shownText.length > 0) {
    const last = shownText.length - 1;
    shownText[last] = ellipsize(`${shownText[last]} …`, textW);
  }
  for (const l of shownText) out.push(truncateToWidth(`${indent}${t.fg("text", l)}`, width));

  // Every link that fits; when some do not and there are rows enough, the last says how many more.
  const more = links.length - linkRows;
  const linkShown = more > 0 && linkRows >= 3 ? links.slice(0, linkRows - 1) : links.slice(0, linkRows);
  for (const l of linkShown) out.push(linkLine(l, width, indent, t));
  if (linkShown.length < linkRows) {
    out.push(truncateToWidth(`${indent}${t.fg("muted", `and ${links.length - linkShown.length} more links · l shows them`)}`, width));
  }
  return out;
}

function headingLine(name: string, when: string, width: number, t: LineTheme): string {
  const words = ellipsize(`Last message · ${stripControls(name)}${when ? ` · ${when}` : ""}`, Math.max(1, width - 6));
  const lead = `  ── ${words} `;
  const fill = Math.max(0, width - visibleWidth(lead));
  return truncateToWidth(`  ${t.fg("borderMuted", "──")} ${t.fg("muted", words)} ${t.fg("borderMuted", "─".repeat(fill))}`, width);
}
