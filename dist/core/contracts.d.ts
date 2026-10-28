/**
 * Type-only contracts for replaceable runtime, process and host integrations. This module must emit
 * no runtime imports.
 */
import type { Scope, Trigger } from "../types.js";
import type { Automation, Config, ResolvedModel, RunProgress, RunRecord, SessionReference } from "../types.js";
import type { LiveWriter } from "../live.js";
import type { SessionHandle } from "../run.js";
/** Everything one run knows about itself, decided once and never mutated. */
export interface RunContext {
    readonly runId: string;
    readonly key: string;
    readonly name: string;
    readonly scope: Scope;
    readonly trigger: Trigger;
    readonly scheduledFor?: string;
    readonly late: boolean;
    readonly automationDir: string;
    readonly rootDir: string;
    /** The repository root, for a repository-scope automation inside a checkout. */
    readonly repositoryRoot?: string;
    /** Where this host keeps its state. Explicit, never derived from the home directory. */
    readonly stateDir: string;
}
/** Environment an integration contributes, as plain key/value data. */
export type EnvironmentOverlay = Readonly<Record<string, string>>;
export interface WorkspaceRequest {
    readonly context: RunContext;
    readonly baseCwd: string;
    readonly repositoryRoot?: string;
    readonly isolated: boolean;
}
export interface WorkspaceHandle {
    readonly cwd: string;
    /** Called exactly once, in the run's `finally`. Must never throw. */
    release(): Promise<void>;
}
/** Why a requested workspace could not be prepared. A typed failure, turned into a record. */
export interface WorkspacePreparationFailure {
    readonly kind: "workspace-preparation";
    readonly repository?: string;
    readonly intendedPath?: string;
    /** A bounded, safe excerpt of the underlying error. One line. */
    readonly detail: string;
}
export type WorkspacePreparation = {
    readonly ok: true;
    readonly workspace: WorkspaceHandle;
} | {
    readonly ok: false;
    readonly failure: WorkspacePreparationFailure;
};
export type PrepareWorkspace = (request: WorkspaceRequest) => Promise<WorkspacePreparation>;
/** Where a transcript is and what wrote it. */
export type { SessionReference };
/**
 * Reading a transcript is separate from running one: a decoder turns complete text into renderable
 * lines, so a host can read a history written by a runtime it does not have.
 */
export type { SessionLine, SessionParseResult, TranscriptDecoder, } from "../transcript-lines.js";
export type { TranscriptRead, TranscriptReaders } from "../ui/session-view.js";
/** Vendor, model id, thinking level and display identity: plain data a record can carry. */
export type ModelIdentity = ResolvedModel;
/**
 * A model a runtime resolved, as everything outside that runtime sees it. Each runtime maps this
 * reference (by object identity) to its native object, so a foreign or copied reference is refused.
 */
export type RuntimeModelRef = ModelIdentity;
/** Where a session writes what is happening while it happens. Optional throughout. */
export type SessionLiveSink = Pick<LiveWriter, "partial" | "thinking" | "message" | "tool">;
export type AutomationSession = SessionHandle;
export interface RuntimeSessionStart {
    readonly cwd: string;
    /** Must have come from THIS runtime's `resolveModel`. */
    readonly model: RuntimeModelRef;
    readonly signal: AbortSignal;
    readonly live?: SessionLiveSink;
    readonly context: RunContext;
    /**
     * Environment for the runtime to apply in its own process (and restore afterwards). Core never
     * writes it, because the host may be a long-lived process.
     */
    readonly env?: EnvironmentOverlay;
}
/**
 * Resolve the `model:` field, or the host default when it is absent. Rejects with a one-line,
 * actionable error whose wording belongs to the host.
 */
export type ModelResolver = (spec: string | undefined) => Promise<ModelIdentity>;
/**
 * Resolution and session startup in one integration, so the native model object never has to travel
 * between independently injected pieces.
 */
export interface AutomationRuntime {
    readonly resolveModel: (spec: string | undefined) => Promise<RuntimeModelRef>;
    readonly startSession: (start: RuntimeSessionStart) => Promise<AutomationSession>;
}
/**
 * What a run needs from whatever records its progress on a chart. Optional and best effort: a
 * tracker that fails records a problem and goes quiet; it never changes the outcome.
 */
export interface FlowTracking {
    /** Begin, returning the id the progress is kept under, or `undefined` when it could not start. */
    start(): string | undefined;
    next(node: string, message?: string): void;
    step(node: string, message?: string): void;
    mark(node: string, status: "done" | "failed" | "skipped", message?: string): void;
    say(text: string, node?: string): void;
    end(status: "ok" | "failed" | "cancelled"): RunProgress | undefined;
    /**
     * The environment one node's worker should be given, so anything it spawns reports in the right
     * place.
     */
    environment(node: string): EnvironmentOverlay;
    /** How the body should report, added to a tracked run's prompt, or nothing. */
    guide?(): string | undefined;
    /** False when the run keeps notes without a flowchart. Absent means tracked. */
    readonly charted?: boolean;
}
export interface FlowTrackingRequest {
    readonly context: RunContext;
    readonly automation: Automation;
    readonly config: Config;
    /** Track this one run even when the automation is not normally tracked. */
    readonly force?: boolean;
    /** Collects problems for the run record. Never thrown, never fatal. */
    readonly onProblem?: (message: string) => void;
}
/**
 * Start tracking, or answer `undefined` for "not tracked". A tracker that could not be built also
 * reports through `onProblem`.
 */
export type StartFlowTracking = (request: FlowTrackingRequest) => FlowTracking | undefined;
export interface FlowReference {
    readonly run: string;
}
/**
 * Drawing a chart from the Mermaid plan and node states: text for a terminal or SVG, or a reason
 * why not. Never on the run path; callers fall back to the step list.
 */
export interface ChartRenderState {
    readonly nodes: Readonly<Record<string, string>>;
    readonly taken: readonly (readonly [string, string])[];
}
export type RenderChart = (args: {
    plan: string;
    state: ChartRenderState;
    format: "text" | "svg";
    timeoutMs?: number;
}) => {
    text: string;
} | {
    problem: string;
};
/**
 * One fully decided process to run: interpreter, environment and bounds are already resolved. The
 * executor does not know what a hook is.
 */
export interface ScriptCommand {
    readonly file: string;
    readonly args: readonly string[];
    readonly cwd: string;
    /** The COMPLETE environment for the child. An executor adds nothing and inherits nothing. */
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: string;
    /** After this, the process and everything it started are terminated. */
    readonly timeoutMs: number;
    /** Stdout is captured up to here and then flagged truncated; the child keeps running. */
    readonly maxOutputBytes: number;
    /**
     * The executor's own stop, distinct from stopping the run, so a stopped run's post hooks are
     * not killed before they deliver.
     */
    readonly signal?: AbortSignal;
}
/** How the process ended. `start-failed` means it never ran at all. */
export type ScriptEnd = "exit" | "timeout" | "cancelled" | "start-failed";
/** What every completion carries. Output is kept even on timeout or start failure. */
export interface ScriptOutput {
    readonly stdout: string;
    readonly stderr: string;
    readonly outputBytes: number;
    readonly truncated: boolean;
}
/**
 * How a script ended, with the data that ending requires. A union, so an executor cannot report
 * `exit` without an exit code.
 */
export type ScriptExecution = 
/** `signal` names the signal that ended the child; `exit` is then 0. */
({
    readonly end: "exit";
    readonly exit: number;
    readonly signal?: string;
} & ScriptOutput) | ({
    readonly end: "timeout";
} & ScriptOutput) | ({
    readonly end: "cancelled";
} & ScriptOutput)
/** `message` is why it could not start, and a start failure that cannot say why is useless. */
 | ({
    readonly end: "start-failed";
    readonly message: string;
} & ScriptOutput);
/**
 * Run one process to completion or timeout. Never throws: a process that could not start is a
 * reported outcome.
 */
export type RunScript = (command: ScriptCommand) => Promise<ScriptExecution>;
/**
 * `pipe` lets the caller read the stream; `file` hands the child an already-open descriptor, so a
 * background run keeps logging after everyone watching has gone.
 */
export type WorkerOutput = {
    readonly kind: "ignore";
} | {
    readonly kind: "inherit";
} | {
    readonly kind: "file";
    readonly fd: number;
} | {
    readonly kind: "pipe";
};
/**
 * One worker to launch. `entry` is supplied by the host; core never knows which file runs an
 * automation.
 */
export interface WorkerLaunch {
    readonly entry: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly detached: boolean;
    readonly output: WorkerOutput;
}
/**
 * Whether a worker actually started. `spawn` reports ENOENT asynchronously, so having a child
 * object proves nothing; a failure carries its reason.
 */
export type WorkerStartup = {
    readonly ok: true;
    readonly pid: number;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * How a worker ended. Exit and signal stay separate so a killed run never reads as a clean one. The
 * `?: never` members make contradictory shapes a type error even through variables.
 */
export type WorkerCompletion = {
    readonly end: "exit";
    readonly exit: number;
    readonly signal?: never;
} | {
    readonly end: "signal";
    readonly signal: NodeJS.Signals;
    readonly exit?: never;
};
/** A launched worker. `release` stops observing; it never stops the worker. */
export interface WorkerHandle {
    readonly pid?: number;
    readonly stdout?: NodeJS.ReadableStream;
    readonly stderr?: NodeJS.ReadableStream;
    /**
     * Settles before `completion`, so a detached caller can confirm a launch without waiting. Never
     * rejects: a startup failure is `{ ok: false, reason }`.
     */
    readonly started: Promise<WorkerStartup>;
    readonly completion: Promise<WorkerCompletion>;
    release(): void;
}
export type LaunchWorker = (launch: WorkerLaunch) => WorkerHandle;
/**
 * Start one run and say whether it started. Resolves on startup, never on completion, so a tick is
 * not serialised behind its slowest run.
 */
export type StartRun = (args: readonly string[]) => Promise<WorkerStartup>;
/** Which worker a host runs an automation with. `args` precede the run's own arguments. */
export interface WorkerEntry {
    readonly file: string;
    readonly args: readonly string[];
}
/**
 * Tell somebody a run failed. Core decides whether and what; this only delivers. Must never throw
 * or delay a run.
 */
export type Notify = (rec: RunRecord) => Promise<void>;
