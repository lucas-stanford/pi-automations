import type { ChartRenderState, EnvironmentOverlay, StartFlowTracking } from "./core/contracts.js";
import type { RunLink, RunMessage, RunNote, RunProgress, RunRecord, StepStatus } from "./types.js";
/** How much text one message or note keeps. Longer is cut, with a warning, never refused. */
export declare const TEXT_MAX = 4000;
/** The states `pa step --status` may set. `pending` and `interrupted` belong to the run. */
export declare const SETTABLE: readonly StepStatus[];
/** Every way a progress write can be refused, as a stable code a script can branch on. */
export type ProgressCode = "USAGE" | "NO_RUN" | "UNKNOWN_RUN" | "RUN_CLOSED" | "NO_CHART" | "UNKNOWN_NODE" | "AMBIGUOUS_NODE" | "AMBIGUOUS_ACTIVE" | "NO_ACTIVE" | "NOT_AN_EDGE" | "BAD_LINK" | "LOCK_TIMEOUT" | "IO";
export declare class ProgressError extends Error {
    readonly code: ProgressCode;
    readonly suggestions: string[];
    constructor(code: ProgressCode, message: string, suggestions?: string[]);
}
export interface ProgressNode {
    id: string;
    label: string;
    status: StepStatus;
    /** The last message, or null. Null rather than absent so it fits the chart readers' shape. */
    text: string | null;
    startedAt?: string;
    endedAt?: string;
    successors: string[];
}
export interface ProgressSnapshot {
    run: string;
    key: string;
    name: string;
    chart: string;
    /** `flow: strict`: `pa next` must follow an arrow of the flowchart, except between hooks and the body. */
    strict?: true;
    openedAt: string;
    nodes: ProgressNode[];
    taken: [string, string][];
    notes: RunNote[];
    /** The last `pa message`; a later one replaces it. */
    message?: RunMessage;
    closed: boolean;
    /** How many events have been applied. Moves on every change, so it keys a render cache. */
    revision: number;
}
export interface ProgressResult {
    /** False when the write was a retry of something already recorded, and nothing was appended. */
    changed: boolean;
    warnings: string[];
    snapshot: ProgressSnapshot;
    /** The node the write landed on, when it was about one. */
    node?: ProgressNode;
    /** For `next`: the node it came from. */
    from?: ProgressNode;
}
type Event = {
    t: "open";
    run: string;
    key: string;
    name: string;
    at: string;
    chart: string;
    strict?: true;
} | {
    t: "step";
    node: string;
    status: StepStatus;
    text?: string;
    at: string;
} | {
    t: "next";
    from: string;
    to: string;
    text?: string;
    at: string;
} | {
    t: "say";
    node: string;
    text: string;
    rid?: string;
    at: string;
} | {
    t: "note";
    text: string;
    links: RunLink[];
    rid?: string;
    at: string;
} | {
    t: "message";
    text: string;
    links: RunLink[];
    rid?: string;
    at: string;
} | {
    t: "close";
    outcome: string;
    at: string;
};
/** A run id is used as a file name, so it is held to the shape `newRunId` produces and no more. */
export declare function validRunId(runId: string): boolean;
export declare function progressFile(stateDir: string, runId: string): string;
/** Replay the events into where the run is now. `undefined` when there is no `open`. */
export declare function foldEvents(events: readonly Event[]): ProgressSnapshot | undefined;
export declare function readProgress(stateDir: string, runId: string): ProgressSnapshot | undefined;
export declare function chartState(snap: ProgressSnapshot): ChartRenderState;
export declare function progressOf(snap: ProgressSnapshot): RunProgress;
/** Put what a run reported onto its record. Empty lists, and a chart it never had, are left off. */
export declare function withProgress(rec: RunRecord, progress: RunProgress): RunRecord;
/** A finished run's progress rebuilt from its record, so history draws like a live run. */
export declare function snapshotFromRecord(rec: RunRecord): ProgressSnapshot | undefined;
export declare function resolveNode(snap: ProgressSnapshot, ref: string): ProgressNode;
/** Open a run's progress, once, before anything reports. Refuses an existing file. */
export declare function openProgress(stateDir: string, args: {
    runId: string;
    key: string;
    name: string;
    chart: string;
    strict?: boolean;
    now?: Date;
}): ProgressSnapshot;
export declare function progressStep(stateDir: string, runIdIn: string | undefined, args: {
    node: string;
    status?: StepStatus;
    text?: string;
    now?: Date;
}): ProgressResult;
export declare function progressNext(stateDir: string, runIdIn: string | undefined, args: {
    to: string;
    from?: string;
    envNode?: string;
    text?: string;
    now?: Date;
}): ProgressResult;
export declare function progressSay(stateDir: string, runIdIn: string | undefined, args: {
    text: string;
    node?: string;
    envNode?: string;
    requestId?: string;
    now?: Date;
}): ProgressResult;
/**
 * One link from the command line: `URL` or `label=URL`, split on the first `=` only when an http(s)
 * URL follows. The parsed `href` is kept, so control characters are percent-encoded.
 */
export declare function parseLink(raw: string): RunLink;
export declare function progressNote(stateDir: string, runIdIn: string | undefined, args: {
    text: string;
    links?: readonly string[];
    requestId?: string;
    now?: Date;
}): ProgressResult;
/** The run's one message for its reader. A later message replaces this one. */
export declare function progressMessage(stateDir: string, runIdIn: string | undefined, args: {
    text: string;
    links?: readonly string[];
    requestId?: string;
    now?: Date;
}): ProgressResult;
export declare function progressStatus(stateDir: string, runIdIn: string | undefined): ProgressSnapshot;
/** Close a run's progress and return the fold. Removing the file is best effort. */
export declare function closeProgress(stateDir: string, runId: string, outcome: string, now?: Date): RunProgress | undefined;
/** Fold an abandoned run's progress into the `aborted` record the lock sweeper wrote for it. */
export declare function foldAbandoned(stateDir: string, rec: RunRecord, now?: Date): RunRecord;
/** Remove week-old tombstones and events files whose run already closed. */
export declare function sweepTombstones(stateDir: string, now?: Date): void;
/** The environment that lets anything a run starts report to it (no node without a chart). */
export declare function progressEnvironment(args: {
    runId: string;
    stateDir: string;
    node?: string;
}): EnvironmentOverlay;
/** Follow a run: notes always; chart moves when tracked. */
export declare const progressTracking: StartFlowTracking;
export declare function notesGuide(): string;
export declare function progressGuide(chart: string, strict?: boolean): string;
export {};
