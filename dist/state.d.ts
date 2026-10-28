import type { TickSource, WatchState } from "./types.js";
export declare class State {
    private readonly file;
    lastTickAt?: string;
    lastTickBy?: TickSource;
    claimed: Record<string, string>;
    roots: string[];
    watches: Record<string, WatchState>;
    /** key -> ISO of when a person paused that automation's watch. */
    pausedWatches: Record<string, string>;
    /** key -> run id of the failed run dismissed from the triage list. */
    dismissedRuns: Record<string, string>;
    /** The command-owned fields this copy has changed since it last loaded or saved. */
    private changedHere;
    constructor(dir?: string);
    load(): void;
    save(): void;
    claim(key: string, iso: string): boolean;
    claimOf(key: string): string | undefined;
    claimPersisted(key: string, iso: string): boolean;
    update(change: (state: State) => void): void;
    registerRoot(repoRoot: string): void;
    unregisterRoot(repoRoot: string): void;
    pruneClaims(liveKeys: Iterable<string>): string[];
    watchOf(key: string): WatchState | undefined;
    recordWatch(key: string, check: WatchState): void;
    /** ISO of when this automation's watch was paused, or undefined while it is running. */
    watchPausedAt(key: string): string | undefined;
    pauseWatch(key: string, at: Date): boolean;
    /** Run this automation's watch again from the next tick. Returns false when it was not paused. */
    resumeWatch(key: string): boolean;
    dismissedRunOf(key: string): string | undefined;
    dismissRun(key: string, runId: string): boolean;
}
/** The last check of one automation's watch, read without taking any lock. */
export declare function readWatchState(dir: string, key: string): WatchState | undefined;
/** Every automation's last watch check, read once for a whole listing. */
export declare function readWatchStates(dir: string): Record<string, WatchState>;
/** Every paused watch, key -> since when, read without taking any lock. */
export declare function readPausedWatches(dir: string): Record<string, string>;
/** Every dismissed failed run, key -> run id, read without taking any lock. */
export declare function readDismissedRuns(dir: string): Record<string, string>;
