/** Helpers for the automation page and cards: run outcomes, consent words and the watcher state. */
import type { Outcome, RunRecord, Status } from "../types.js";
import { type LineTheme } from "./theme.js";
export interface DetailsData {
    lastRecord?: RunRecord;
    flowSource?: "automation" | "file" | "config" | "none";
    /** The recent outcomes, oldest first. */
    history?: Outcome[];
    /** Recent records, oldest first, when the caller already read them. */
    records?: RunRecord[];
    /** The failed run a person dismissed with `d`; a newer failure shows again. */
    dismissedRunId?: string;
}
/** The watcher (the OS job): `on`, `stale` (quiet or another install's) or `off`. */
export interface WatcherFacts {
    state: "on" | "stale" | "off";
    /** ISO of the last tick, when there has been one. */
    lastTickAt?: string;
    /** Why it is stale, or where the ticks come from when it is not the OS job. */
    note?: string;
    /** False when the ticks come from something `w` cannot stop, such as `pa serve`. */
    controllable?: boolean;
}
/** A tick comes once a minute; five quiet minutes means nothing is ticking. */
export declare const WATCHER_QUIET_MS: number;
/** The watcher state; without the job, recent ticks mean "on" only when `serve` made them. */
export declare function classifyWatcher(job: {
    installed: boolean;
    stale: boolean;
}, lastTickAt: string | undefined, now: Date, lastTickBy?: string): WatcherFacts;
/** On, or registered for another install but still ticking (so nothing is on hold). */
export declare function watcherTicking(w: WatcherFacts | undefined, now: Date): boolean;
/** An armed automation that starts on its own: a schedule, or a watch that is not paused. */
export declare function startsOnItsOwn(s: Status): boolean;
/** The reason an automation is off. */
export declare function offWords(reason: string | undefined): string;
/**
 * `waiting for your consent` for an automation nobody has armed; its own reason otherwise.
 */
export declare function consentWords(reason: string | undefined): string;
/** `name` on the left and `● armed · user` on the right of one line. */
export declare function spread(left: string, right: string, width: number): string;
/** `✓ ok` in its colour. */
export declare function runMark(outcome: Outcome, t: LineTheme): string;
/** What a run said: its error when it failed, its summary otherwise. */
export declare function runSays(rec: RunRecord): string;
export declare function wrapWords(text: string, width: number): string[];
