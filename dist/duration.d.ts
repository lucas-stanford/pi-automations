export declare const DURATION_RE: RegExp;
/** Parse a duration to milliseconds. `undefined` means "not a duration" — never throws. */
export declare function parseDuration(s: string, opts?: {
    allowDays?: boolean;
}): number | undefined;
/**
 * Format milliseconds the way the listing shows them. 45000 -> "45s" · 552000 -> "9m12s" · 3600000
 * -> "1h"
 */
export declare function formatDuration(ms: number): string;
