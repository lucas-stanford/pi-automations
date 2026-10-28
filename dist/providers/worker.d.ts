import type { LaunchWorker, WorkerCompletion } from "../core/contracts.js";
/** Node's `close` as a union; neither code nor signal is an abnormal end. */
export declare function completionFor(code: number | null, signal: NodeJS.Signals | null): WorkerCompletion;
/** Exit code for an ended worker: a signal is 0, an unreadable completion is not. */
export declare function exitCodeForCompletion(c: WorkerCompletion): number;
/** Read an untyped completion, or undefined. Contradictory results are refused. */
export declare function readCompletion(value: unknown): WorkerCompletion | undefined;
/** The local transport. `completion` always has a handler. */
export declare const launchLocalWorker: LaunchWorker;
