import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AutomationRuntime, SessionLiveSink } from "../../core/contracts.js";
import { type ModelRuntimeLike } from "../../model.js";
import type { SessionHandle } from "../../run.js";
import type { ResolvedModel } from "../../types.js";
export declare function adaptPiRuntime(rt: ModelRuntime): ModelRuntimeLike;
interface PiSessionStart {
    cwd: string;
    model: ResolvedModel;
    native: unknown;
    signal: AbortSignal;
    live?: SessionLiveSink;
}
/** One pi owner: a catalog and a session opener closing over the same `ModelRuntime`. */
export interface PiOwner {
    readonly catalog: ModelRuntimeLike;
    openSession(start: PiSessionStart): Promise<SessionHandle>;
}
/** Create pi's ModelRuntime once, lazily, for both halves of the owner. */
/** `piModule` is the operator's `piModule` from config, tried after the parent's hint. */
export declare function loadPiOwner(agentDir?: string, piModule?: string): Promise<PiOwner>;
export declare function loadPiRuntime(piModule?: string): Promise<ModelRuntimeLike>;
export interface PiModelChoice {
    value: string;
    name?: string;
}
export interface PiModelChoices {
    /** Every model pi has credentials for: the list pi's own model picker shows. */
    available: PiModelChoice[];
    /** `enabledModels` from pi's settings, resolved the way `/scoped-models` resolves them. */
    enabled: PiModelChoice[];
}
/** The models pi can run, read fresh each call. */
export declare function listPiModels(cwd: string, piModule?: string): Promise<PiModelChoices>;
export interface PiRuntimeOptions {
    agentDir?: string;
    /** `piModule` from config, read when the SDK first loads. */
    piModule?: () => string | undefined;
    loadServices?: () => Promise<PiOwner>;
}
/** What a session start says when the model did not come from this runtime. */
export declare const FOREIGN_MODEL_MESSAGE = "this model was resolved by a different runtime \u2014 resolve and start the session with the same one";
/** One automation per pi worker makes the env overlay safe; a second session is refused. */
export declare const OVERLAPPING_SESSION_MESSAGE = "this worker already has a session open \u2014 one automation per pi worker, so a second session cannot start here";
/** A pi-backed {@link AutomationRuntime}. The SDK loads on the first `resolveModel`. */
export declare function createPiRuntime(options?: PiRuntimeOptions): AutomationRuntime;
export {};
