import type { ErrorKind, ResolvedModel } from "./types.js";
/** pi's thinking levels (`pi-agent-core` `ThinkingLevel`). */
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** The closed `ErrorKind` list as a value, so a declared kind can be validated. */
export declare const ERROR_KINDS: readonly ["timeout", "model-unavailable", "hook", "agent", "host"];
export interface ModelLike {
    id: string;
    provider: string;
    /** `null` marks a level explicitly unsupported; a missing key means the provider default. */
    thinkingLevelMap?: Partial<Record<string, string | null>> | undefined;
}
/** The host default. `raw` never leaves the runtime that asked. */
export interface DefaultModelLike extends ModelLike {
    display?: string;
    raw?: unknown;
}
/** The slice of pi's ModelRuntime this needs: each error line is a direct question to it. */
export interface ModelRuntimeLike {
    /** Registered provider ids, for the "known: …" list. */
    providers(): string[];
    /** A specific model, or undefined when the provider does not have it. */
    getModel(provider: string, id: string): ModelLike | undefined;
    checkAuth(provider: string): Promise<boolean>;
    /** The host default, used when the automation names no model. */
    defaultModel(): DefaultModelLike | undefined;
}
/** A model and the catalog's own object for it. Only the runtime that asked holds `native`. */
export interface ModelSelection {
    identity: ResolvedModel;
    native: unknown;
}
/** Split `<provider>/<id>[:<thinking>]`. Shape is already validated by the parser. */
export declare function splitModelSpec(spec: string): {
    provider: string;
    id: string;
    thinking?: string;
};
/** The levels a model actually offers, for the "supported: …" list. */
export declare function supportedThinkingLevels(model: ModelLike): string[];
export declare function displayOf(provider: string, id: string, thinking?: string): string;
/** Resolve `model:` (or the default), reporting file problems before machine problems. */
export declare function selectModel(spec: string | undefined, rt: ModelRuntimeLike): Promise<ModelSelection>;
/** The same question for a caller that never starts a session: identity only. */
export declare function resolveModel(spec: string | undefined, rt: ModelRuntimeLike): Promise<ResolvedModel>;
/** How many providers the "known:" list names before it gives up and says "…". */
export declare const KNOWN_PROVIDERS_SHOWN = 8;
/** The "known: …" provider list, nearest names first, truncated. */
export declare function knownList(known: string[], typed: string): string;
/** Classify a run failure from its text; anything unrecognised is `agent`. */
export declare function classifyFireError(e: unknown): ErrorKind;
/** The runtime used when pi cannot be found: every run fails with a fix-naming record. */
export declare function unavailableRuntime(reason: string): ModelRuntimeLike;
