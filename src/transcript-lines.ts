// The line shape between transcript decoders and renderers.

/** One renderable thing that happened in the session. */
export interface SessionLine {
  kind: "text" | "thinking" | "tool" | "result" | "user" | "note" | "partial";
  /** Already flattened to a single line; the renderer wraps or truncates. */
  text: string;
  /** Milliseconds since the epoch, when the source line carried one. */
  at?: number;
}

/** What a caller needs to keep between reads to follow a growing file. */
export interface SessionParseResult {
  lines: SessionLine[];
  /** The session id, when the file has declared one. */
  id?: string;
}

/** Turn complete transcript lines into renderable ones. Never throws or reads a file. */
export type TranscriptDecoder = (text: string) => SessionParseResult;

/** Collapse to one line: a pane shows shape, and the full text is in the session file. */
export function flattenText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Successive drafts collapse to one line, and a settled line replaces its draft. */
export function collapseSessionLines(lines: SessionLine[]): SessionLine[] {
  const out: SessionLine[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(l);
      continue;
    }

    const sameDraft = (l.kind === "partial" || l.kind === "thinking") && prev.kind === l.kind;
    const settles =
      (l.kind === "text" && prev.kind === "partial") ||
      (l.kind === "thinking" && prev.kind === "thinking");

    if ((sameDraft || settles) && (l.text === prev.text || l.text.startsWith(prev.text))) {
      out[out.length - 1] = l;
      continue;
    }
    out.push(l);
  }
  return out;
}
