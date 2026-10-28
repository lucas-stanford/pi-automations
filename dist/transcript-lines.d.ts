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
export declare function flattenText(s: string): string;
/** Successive drafts collapse to one line, and a settled line replaces its draft. */
export declare function collapseSessionLines(lines: SessionLine[]): SessionLine[];
