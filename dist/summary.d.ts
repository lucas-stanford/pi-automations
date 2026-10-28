import type { RunRecord } from "./types.js";
/** How much of a run's answer the record keeps. The session file is the complete copy. */
export declare const OUTPUT_MAX = 2000;
/** One line, for a surface that has one line. */
export declare const LINE_MAX = 240;
export interface ClippedOutput {
    text: string;
    truncated?: boolean;
}
/** What of the body's answer to keep; undefined when there is nothing. */
export declare function clipOutput(text: string | undefined): ClippedOutput | undefined;
/** The first line worth reading: headings are skipped when prose follows. */
export declare function leadLine(text: string): string;
/** Cut to a length without ending mid-word, and say that it was cut. */
export declare function clipLine(text: string, max?: number): string;
/** One line describing any run, never empty. */
export declare function summaryLine(rec: RunRecord, max?: number): string;
/** The run's own output, wrapped to a pane with emphasis stripped. */
export declare function outputLines(rec: RunRecord, width: number, maxLines?: number): string[];
