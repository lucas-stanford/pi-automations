import type { Config, FireEvent, Located, RunMessage, RunNote, Trigger } from "../types.js";
import { type FlowNodeLike, type RunView } from "./run-view.js";
export interface RegistryEntry {
    id: string;
    view: RunView;
    /** Finished attached runs stay until dismissed; observed ones disappear with their lock. */
    dismissed?: boolean;
}
export interface RegistryDeps {
    stateDir: string;
    config: Config;
    now: () => Date;
    /** Ask the progress store where a tracked run has got to. Injected for tests. */
    progress?: (flow: {
        run: string;
    }) => {
        nodes: FlowNodeLike[];
        notes?: RunNote[];
        message?: RunMessage;
    } | undefined;
}
export declare class RunRegistry {
    private deps;
    private entries;
    private listeners;
    constructor(deps: RegistryDeps);
    /** Notified after every change. Returns an unsubscribe. */
    subscribe(fn: () => void): () => void;
    private changed;
    /** Register a run this process is about to start, with its full plan. */
    addAttached(args: {
        located: Located;
        trigger: Trigger;
        timeoutMs: number;
        pid?: number;
    }): string;
    /** Fold one parsed event into an attached run. Unknown ids are ignored, never created. */
    applyEvent(id: string, event: FireEvent): void;
    /** The child closed without a record. */
    crash(id: string, exitCode: number, stderrTail: string[]): void;
    /** Attach a pid once the child exists, so the window can name the process. */
    setPid(id: string, pid: number): void;
    refreshObserved(keys: string[]): void;
    /** Read and merge the progress of every running run, on the same 1 s tick. */
    refreshFlow(): void;
    /** Stop showing a finished run. Refuses while it is still going — that would hide live work. */
    dismiss(id: string): boolean;
    /** Drop every finished run at once. */
    dismissFinished(): void;
    /** Everything, running first, oldest first within each group. */
    all(): RegistryEntry[];
    running(): RegistryEntry[];
    finished(): RegistryEntry[];
    get size(): number;
    clear(): void;
}
