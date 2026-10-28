import type { RunObservers } from "./plugins/loader.js";
import type { State } from "./state.js";
import type { Trust } from "./trust.js";
import type { AutomationRuntime, PrepareWorkspace, Notify, RunScript, StartFlowTracking } from "./core/contracts.js";
import type { Config, FireEvent, Located, RunRecord, Trigger } from "./types.js";
export interface SessionHandle {
    prompt(text: string): Promise<string>;
    file: string;
    id: string;
    format?: string;
    dispose(): Promise<void> | void;
}
export interface FireOptions {
    trigger: Trigger;
    scheduledFor?: string;
    late?: boolean;
    runId?: string;
    now?: () => Date;
    emit?: (e: FireEvent) => void;
    /** Track this run on a flowchart even if the automation would not normally be. */
    forceFlow?: boolean;
}
export interface FireDeps {
    config: Config;
    stateDir: string;
    trust: Trust;
    /** Tick bookkeeping: claiming the covered instant stops catch-up from firing a duplicate. */
    state: State;
    /** Resolves the model and opens the session, so both come from the same SDK instance. */
    runtime: AutomationRuntime;
    prepareWorkspace?: PrepareWorkspace;
    startTracking?: StartFlowTracking;
    /** Runs hook scripts. Required, so a host that composed nothing never spawns processes. */
    runScript: RunScript;
    notify?: Notify;
    platform?: NodeJS.Platform;
    /** Overrides the hook timeout; tests use it to keep a sleeping script cheap. */
    hookTimeoutMs?: number;
    /** Bound for post-record integrations (workspace release, notification). Tests shorten it. */
    providerTimeoutMs?: number;
    /** Plugins told about this run. Their problems go on the record and never change the run. */
    observe?: RunObservers;
}
export declare const CANCEL_POLL_MS = 500;
/** Not "host stopped": that is what the stale-lock sweep writes. */
export declare const CANCEL_REASON = "stopped by request";
export declare function fire(l: Located, opts: FireOptions, deps: FireDeps): Promise<RunRecord>;
/** The one-line refusal: cause, fix, then repository, path and git's line. */
export declare function workspaceRefusalMessage(args: {
    key: string;
    repository?: string;
    intended?: string;
    detail: string;
}): string;
