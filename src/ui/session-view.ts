// Rendering a session transcript, and choosing which decoder reads a reference. Format-agnostic.

import { truncateToWidth, visibleWidth } from "./width.js";
import type { LineTheme, UiColor } from "./theme.js";
import type { SessionReference } from "../types.js";
import type { SessionLine, SessionParseResult, TranscriptDecoder } from "../transcript-lines.js";

/** The decoders a host composed: `legacy` (no tag) and at most one `alternative`. */
export interface TranscriptReaders {
  legacy: TranscriptDecoder;
  alternative?: { format: string; decode: TranscriptDecoder };
}

export type TranscriptRead =
  | { ok: true; parsed: SessionParseResult }
  | { ok: false; unsupported: string };

/** Choose a decoder from the reference alone, so an empty transcript still reports its format. */
export function decodeTranscript(
  text: string,
  ref: SessionReference | undefined,
  readers: TranscriptReaders,
): TranscriptRead {
  const format = ref?.format;

  if (format === undefined || format === "") {
    return { ok: true, parsed: readers.legacy(text) };
  }

  const alternative = readers.alternative;
  if (alternative && format === alternative.format) {
    return { ok: true, parsed: alternative.decode(text) };
  }

  return { ok: false, unsupported: format };
}

/** What the pane says about a format nothing here can read. */
export function unsupportedFormatLines(
  format: string,
  width: number,
  theme?: LineTheme,
): string[] {
  if (width <= 0) return [];
  const fg = theme?.fg ?? ((_c: UiColor, t: string) => t);
  return [
    fg("dim", truncateToWidth(`unsupported transcript format ${JSON.stringify(format)}`, width)),
    fg("dim", truncateToWidth(`use a host with a decoder for ${JSON.stringify(format)}`, width)),
  ];
}

const PREFIX: Record<SessionLine["kind"], string> = {
  partial: "  ",
  text: "  ",
  thinking: "  ",
  tool: "▸ ",
  result: "  ↳ ",
  user: "› ",
  note: "  ",
};

const COLOR: Record<SessionLine["kind"], UiColor> = {
  // Still arriving, but drawn as ordinary text: it is the newest thing that happened.
  partial: "text",
  text: "text",
  thinking: "dim",
  tool: "accent",
  result: "dim",
  user: "text",
  note: "dim",
};

export interface SessionPaneOptions {
  width: number;
  theme?: LineTheme;
  /** Hide the model's private reasoning, which is long and not what a watcher is looking for. */
  showThinking?: boolean;
}

/** One source line becomes one rendered line, so the pane does not reflow as it grows. */
export function buildSessionLines(
  lines: SessionLine[],
  opts: SessionPaneOptions,
): string[] {
  const theme = opts.theme ?? { fg: (_c: UiColor, t: string) => t };
  // No minimum width: a row with no room is not drawn.
  const width = opts.width;
  const out: string[] = [];

  for (const l of lines) {
    if (l.kind === "thinking" && opts.showThinking !== true) continue;
    const prefix = PREFIX[l.kind];
    const room = width - visibleWidth(prefix);
    if (room <= 0) continue;
    out.push(theme.fg(COLOR[l.kind], prefix + truncateToWidth(l.text, room)));
  }

  return out;
}
