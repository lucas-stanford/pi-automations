import type { FireEvent, Located, RunLockInfo, RunMessage, RunNote, RunRecord, SessionReference, Trigger } from "../types.js";
/** UI-only; `Outcome` and `HookResult["status"]` are closed lists. */
export type StepState = "pending" | "active" | "done" | "skipped" | "failed";
export interface Step {
    id: string;
    label: string;
    state: StepState;
    durationMs?: number;
    reason?: string;
    /** The latest message reported for this node. Advisory; never affects `state`. */
    note?: string;
    extra?: boolean;
}
export type RunPhase = "starting" | "running" | "finished" | "crashed";
/** `attached`: spawned here; `observed`: rebuilt from the lock and log. */
export type RunSource = "attached" | "observed";
export interface RunView {
    key: string;
    name: string;
    trigger: Trigger;
    source: RunSource;
    pid?: number;
    runId?: string;
    startedAt: string;
    timeoutMs: number;
    steps: Step[];
    phase: RunPhase;
    scheduledFor?: string;
    late?: boolean;
    flow?: {
        run: string;
    };
    flowPath?: FlowPath;
    notes?: RunNote[];
    /** The run's message for its reader, while it runs; the record has it after. */
    message?: RunMessage;
    /** The session this run's body opened, from the `session` event or the run lock. */
    session?: SessionReference;
    record?: RunRecord;
    /** Optional integrations that failed without changing what the run did. */
    problems?: string[];
    exitCode?: number;
    stderrTail: string[];
}
export declare const STDERR_TAIL_MAX = 50;
export declare function nameFromKey(key: string): string;
/** The full plan, every step pending, so the window shows it from frame one. */
export declare function planFor(located: Located): Step[];
export declare function startingView(args: {
    located: Located;
    trigger: Trigger;
    startedAt: string;
    timeoutMs: number;
    source?: RunSource;
    pid?: number;
}): RunView;
export declare function observedView(lock: RunLockInfo): RunView;
export declare function mergeObservedReplay(base: RunView, replayed: RunView | undefined): RunView;
/** Fold one event into the view. Pure. Events for a different `runId` are ignored. */
export declare function applyFireEvent(view: RunView, event: FireEvent): RunView;
/** The child closed without a `record`; the stderr tail is the only evidence. */
export declare function markCrashed(view: RunView, exitCode: number, stderrTail: string[]): RunView;
/** One stdout line from `bin/fire.js`, or undefined. Most fire-log lines are interleaved stderr. */
export declare function parseFireLine(line: string): FireEvent | undefined;
/** Diagnostics for one run: tagged ones by tag, untagged ones by window. Duplicates collapse. */
export declare function foldRunProblems(lines: readonly string[], runId: string): string[];
/** Replay after the last matching start, stopping at the next run; undefined if nothing matches. */
export declare function replayFireLog(base: RunView, lines: string[], runId: string): RunView | undefined;
export declare function activeStep(view: RunView): Step | undefined;
export declare function isRunning(view: RunView): boolean;
export declare function elapsedMs(view: RunView, now: Date): number;
export interface FlowNodeLike {
    id: string;
    label: string;
    status: string;
    text: string | null;
    successors?: string[];
}
/** Where the run is on its chart, including which way it can go next. */
export interface FlowPath {
    done: string[];
    current?: {
        label: string;
        status: string;
    };
    next: string[];
}
/**
 * Merge store progress: own events stay authoritative; the store adds labels, text and extra nodes.
 */
export declare function mergeFlowNodes(view: RunView, raw: FlowNodeLike[]): RunView;
export declare function mergeProgress(view: RunView, progress: {
    nodes: FlowNodeLike[];
    notes?: RunNote[];
    message?: RunMessage;
}): RunView;
