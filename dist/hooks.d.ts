import type { EnvironmentOverlay, RunScript } from "./core/contracts.js";
import { type WhichFn } from "./interpreters.js";
import { type WatchCheck } from "./watch.js";
import type { Config, HookResult, Located, Outcome, Trigger } from "./types.js";
/** What a tracked run tells its hooks: the composed tracker's own environment operation. */
export interface HookFlowContext {
    readonly environment: (node: string) => EnvironmentOverlay;
}
export interface RunInfo {
    runId: string;
    trigger: Trigger;
    scheduledFor?: string;
    late: boolean;
}
/** Credential-like names, never passed to a hook, a watch script or a job file. */
export declare const SECRET_NAME: RegExp;
/** The hook environment. Defined by this host; Draft 0.2 does not specify one. */
export declare function hookEnv(l: Located, run: RunInfo, phase: "pre" | "post", index: number, outcome?: Outcome, reason?: string, 
/** The run's progress identity, given to every hook so its work shows on the chart. */
flow?: HookFlowContext): Record<string, string>;
/** Only the first non-empty line counts: exactly `skip`, or starting with `skip:`. */
export declare function detectSkip(answer: string): {
    skip: boolean;
    reason?: string;
};
export interface ScriptHookOptions {
    config: Config;
    platform?: NodeJS.Platform;
    which?: WhichFn;
    /** Overrides config.hookTimeout — used by tests to keep a sleeping script cheap. */
    timeoutMs?: number;
    /** The run's progress identity, when it is tracked. See hookEnv. */
    flow?: HookFlowContext;
    /** Required: a configured script with no executor must not look like success or a quiet skip. */
    runScript: RunScript;
    /** Stops the script early: a pre hook ends with the run's timeout or a stop. */
    signal?: AbortSignal;
}
export interface ScriptHookOutcome {
    result: HookResult;
    output: string;
    stderr: string;
}
/** Run one script hook to completion, or to its timeout. */
export declare function runScriptHook(l: Located, hook: {
    script: string;
}, phase: "pre" | "post", index: number, run: RunInfo, stdin: string | undefined, opts: ScriptHookOptions, outcomeForPost?: {
    outcome: Outcome;
    reason?: string;
}): Promise<ScriptHookOutcome>;
/** Run one prompt hook by asking the session. */
export declare function runPromptHook(hook: {
    prompt: string;
}, phase: "pre" | "post", index: number, oneTurn: (text: string) => Promise<string>): Promise<{
    result: HookResult;
    output: string;
}>;
/** What a watch script is told: the hook identity, plus `LAST_CHECKED` for "what changed since". */
export declare function watchEnv(l: Located, lastChecked?: string): Record<string, string>;
export interface WatchScriptOptions {
    config: Config;
    /** Optional, so a host that composed none gets a check that says so. */
    runScript?: RunScript;
    platform?: NodeJS.Platform;
    which?: WhichFn;
    /** Overrides config.hookTimeout. */
    timeoutMs?: number;
    /** ISO of the previous check, handed to the script as AUTOMATION_LAST_CHECKED. */
    lastChecked?: string;
}
/** Run an `on.watch` script once, like a script hook; `src/watch.ts` interprets the result. */
export declare function runWatchScript(l: Located, opts: WatchScriptOptions): Promise<WatchCheck>;
