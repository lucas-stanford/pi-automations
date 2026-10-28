/** How much of the tail to read. Large enough for a long run's events, small enough to be free. */
export declare const FIRE_LOG_TAIL_BYTES: number;
/**
 * The last `maxBytes` of a fire log as lines; `[]` when missing. A partial first line is dropped.
 */
export declare function readFireLogTail(stateDir: string, key: string, maxBytes?: number): string[];
/** Diagnostics one run left behind. The fold lives in `run-view` so the replay can share it. */
export { foldRunProblems } from "./run-view.js";
/** The same, read from the automation's log tail. */
export declare function readRunProblems(stateDir: string, key: string, runId: string): string[];
