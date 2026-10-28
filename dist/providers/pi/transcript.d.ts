import { type SessionParseResult } from "../../transcript-lines.js";
/** The argument that identifies what a tool call acted on; the rest is noise in a small pane. */
export declare function toolSubject(args: unknown): string;
/** Parse complete transcript lines; the caller owns the partial tail. */
export declare function parseSessionLines(text: string): SessionParseResult;
/**
 * The pi host's reader table: the legacy format only. Anything tagged is reported as unsupported.
 */
export declare const piTranscriptReaders: {
    readonly legacy: typeof parseSessionLines;
};
