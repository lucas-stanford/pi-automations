/** Strip every non-printing sequence, leaving exactly the characters a terminal shows. */
export declare function stripAnsi(s: string): string;
/** Remove control characters from outside text so it cannot start an escape sequence. */
export declare function stripControls(s: string, keepLines?: boolean): string;
/** Columns the string occupies once the terminal has consumed its escape sequences. */
export declare function visibleWidth(s: string): number;
/** Cut to `max` columns keeping colour intact; a straddling wide character is dropped. */
export declare function truncateToWidth(s: string, max: number): string;
/** Pad on the right to `n` columns. Never truncates — callers decide what may be cut. */
export declare function padTo(s: string, n: number): string;
/** Pad on the left to `n` columns. */
export declare function padLeft(s: string, n: number): string;
/** Truncate, then pad, so the result is exactly `n` columns wide. */
export declare function fitTo(s: string, n: number): string;
/** Hard-wrap into chunks of at most `n` columns, losing nothing (for data such as JSON). */
export declare function wrapHard(s: string, n: number): string[];
/** Cut to `max` columns and end with `…` when anything was cut. */
export declare function ellipsize(s: string, max: number): string;
/** Wrap at spaces with a hanging indent, so continuation lines start under the value. */
export declare function wrapHanging(s: string, width: number): string[];
