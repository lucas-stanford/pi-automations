import type { LineTheme } from "./theme.js";
import type { SessionReference } from "../types.js";
import type { SessionLine, SessionParseResult, TranscriptDecoder } from "../transcript-lines.js";
/** The decoders a host composed: `legacy` (no tag) and at most one `alternative`. */
export interface TranscriptReaders {
    legacy: TranscriptDecoder;
    alternative?: {
        format: string;
        decode: TranscriptDecoder;
    };
}
export type TranscriptRead = {
    ok: true;
    parsed: SessionParseResult;
} | {
    ok: false;
    unsupported: string;
};
/** Choose a decoder from the reference alone, so an empty transcript still reports its format. */
export declare function decodeTranscript(text: string, ref: SessionReference | undefined, readers: TranscriptReaders): TranscriptRead;
/** What the pane says about a format nothing here can read. */
export declare function unsupportedFormatLines(format: string, width: number, theme?: LineTheme): string[];
export interface SessionPaneOptions {
    width: number;
    theme?: LineTheme;
    /** Hide the model's private reasoning, which is long and not what a watcher is looking for. */
    showThinking?: boolean;
}
/** One source line becomes one rendered line, so the pane does not reflow as it grows. */
export declare function buildSessionLines(lines: SessionLine[], opts: SessionPaneOptions): string[];
