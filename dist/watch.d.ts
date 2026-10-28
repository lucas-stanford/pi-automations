import type { Watch, WatchState } from "./types.js";
/** A check counts as due slightly early, so tick jitter does not add a minute. */
export declare const WATCH_SLACK_MS = 30000;
/** The longest `said` line kept in state and shown in a listing. */
export declare const WATCH_SAID_MAX = 200;
/** The longest a watch script may run: under the tick lock's five-minute staleness. */
export declare const WATCH_TIMEOUT_MAX_MS: number;
/** `every` in milliseconds. Parsing already refused anything this cannot read. */
export declare function everyMs(watch: Watch): number;
/** Is the watch due a check at `now`? */
export declare function watchDue(prev: WatchState | undefined, watch: Watch, now: Date): boolean;
/** When the next check is due; can be in the past (overdue). Never checked means due now. */
export declare function nextCheckAt(prev: WatchState | undefined, watch: Watch, now: Date): Date;
/** What one run of the script came to, from whoever ran it. */
export interface WatchCheck {
    /** The exit code. Absent when the script never exited; then `problem` says why. */
    exit?: number;
    problem?: string;
    stdout: string;
    stderr: string;
    durationMs: number;
}
export interface WatchDecision {
    /** Start a run now. */
    fire: boolean;
    /** Why, in a few words, for a listing and a dry run. */
    because: string;
    /** What to remember about this check. */
    next: WatchState;
}
/** `sha256:<hex>` of what the script printed, ignoring surrounding whitespace. */
export declare function fingerprint(output: string): string;
/**
 * One line of what a check said: stdout's first line when it found something, else stderr's last.
 */
export declare function saidLine(check: WatchCheck): string | undefined;
/**
 * What a finished check means:
 * - exit 0 with output different from the last run's finding: start a run;
 * - exit 0 with the same output: no run;
 * - another exit code: no run, and the last finding is forgotten;
 * - no exit (timeout, signal, start failure): no run, nothing forgotten.
 */
export declare function decideWatch(prev: WatchState | undefined, check: WatchCheck, now: Date): WatchDecision;
