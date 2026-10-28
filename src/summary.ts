// What happened in a run, said the same way on every surface.

import type { RunRecord } from "./types.js";

/** How much of a run's answer the record keeps. The session file is the complete copy. */
export const OUTPUT_MAX = 2000;

/** One line, for a surface that has one line. */
export const LINE_MAX = 240;

export interface ClippedOutput {
  text: string;
  truncated?: boolean;
}

/** What of the body's answer to keep; undefined when there is nothing. */
export function clipOutput(text: string | undefined): ClippedOutput | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length <= OUTPUT_MAX) return { text: trimmed };
  return { text: trimmed.slice(0, OUTPUT_MAX), truncated: true };
}

/** The first line worth reading: headings are skipped when prose follows. */
export function leadLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

  const isHeading = (l: string) =>
    /^#{1,6}\s/.test(l) || // # Markdown heading
    /^\*\*[^*]+\*\*$/.test(l) || // **bold as a title**
    /^__[^_]+__$/.test(l) || // __the same, underscored__
    /^[-*_]{3,}$/.test(l); // a horizontal rule

  // Prefer prose over bullets: the first bullet is rarely the point.
  const isListItem = (l: string) => /^([-*+]|\d{1,3}[.)])\s/.test(l);

  const body = lines.filter((l) => !isHeading(l));
  const prose = body.filter((l) => !isListItem(l));
  const pick = prose[0] ?? body[0] ?? lines[0] ?? "";
  return stripMarkup(pick).replace(/\s+/g, " ").trim();
}

/** Drop Markdown that means nothing on one terminal line, heading markers included. */
function stripMarkup(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,;:!?)]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}

const stripEmphasis = stripMarkup;

/** Cut to a length without ending mid-word, and say that it was cut. */
export function clipLine(text: string, max = LINE_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** One line describing any run, never empty. */
export function summaryLine(rec: RunRecord, max = LINE_MAX): string {
  switch (rec.outcome) {
    case "ok": {
      const text = rec.output?.text;
      if (text && text.trim() !== "") {
        const lead = leadLine(text);
        if (lead !== "") return clipLine(rec.output?.truncated ? `${lead}` : lead, max);
      }
      // Finished with nothing to read (all its work is in its hooks). Not a failure.
      const ranHooks = (rec.hooks ?? []).some((h) => h.status === "ok");
      return ranHooks ? "ok — no answer, hooks ran" : "ok — no answer";
    }

    case "skipped":
      return clipLine(rec.reason?.trim() || "skipped", max);

    case "failed": {
      const kind = rec.error?.kind;
      const message = rec.error?.message?.trim();
      if (kind && message) return clipLine(`${kind}: ${message}`, max);
      if (message) return clipLine(message, max);
      if (kind) return `${kind}`;
      return clipLine(rec.reason?.trim() || "failed", max);
    }

    case "missed": {
      const n = rec.count ?? 1;
      return n > 1 ? `missed ${n} scheduled runs` : "missed a scheduled run";
    }

    case "aborted":
      return clipLine(rec.reason?.trim() || "aborted", max);

    default:
      // Unreachable for the closed outcome list, but never render a blank.
      return String(rec.outcome);
  }
}

/** The produced text as lines for a pane, wrapped to a width. */
/** Wrap one paragraph on word boundaries; a word longer than the line is still broken. */
function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter((w) => w !== "")) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      out.push(line);
      line = word;
    }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/** The run's own output, wrapped to a pane with emphasis stripped. */
export function outputLines(rec: RunRecord, width: number, maxLines = 6): string[] {
  const text = rec.output?.text;
  if (!text || width <= 0) return [];

  const paragraphs = text
    .split("\n")
    .map((l) => stripEmphasis(l.replace(/\s+/g, " ").trim()))
    .filter((l) => l !== "");

  const out: string[] = [];
  let clipped = false;
  for (const p of paragraphs) {
    for (const l of wrapWords(p, width)) {
      if (out.length >= maxLines) {
        clipped = true;
        break;
      }
      out.push(l);
    }
    if (out.length >= maxLines) {
      clipped = true;
      break;
    }
  }

  if (out.length === maxLines && (clipped || rec.output?.truncated)) {
    const last = out[maxLines - 1] ?? "";
    out[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
  }
  return out;
}
