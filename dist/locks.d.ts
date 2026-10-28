import type { Config, RunLockInfo, RunRecord, Trigger } from "./types.js";
/** `EPERM` means the process exists but belongs to someone else, so it is alive. */
export declare function isAlive(pid: number): boolean;
/** Take the tick lock, or undefined when held. A dead or stale lock is replaced. */
export declare function acquireTickLock(dir: string, staleMs: number, now?: Date): (() => void) | undefined;
export declare function runLockFile(dir: string, key: string): string;
/** Why a short-lived file lock could not be taken. */
export declare class LockTimeoutError extends Error {
    readonly code = "LOCK_TIMEOUT";
}
/**
 * Run `fn` while holding a short-lived exclusive lock file, for check-then-write sequences. Unlike
 * the run lock it is waited for briefly. Abandoned locks (dead owner, older than `staleMs`, or
 * unreadable) are broken under the breaker, and only if still the same file.
 */
export declare function withFileLock<T>(file: string, fn: () => T, opts?: {
    timeoutMs?: number;
    staleMs?: number;
}): T;
export type RunLockResult = {
    ok: true;
    release(): void;
} | {
    ok: false;
    held: RunLockInfo;
};
/** Take the run lock for one automation, or report who holds it. */
export declare function acquireRunLock(dir: string, info: RunLockInfo): RunLockResult;
export declare function readRunLock(dir: string, key: string): RunLockInfo | undefined;
/** Update the run lock this process holds (temp file plus rename). Owner only; best effort. */
export declare function updateRunLock(dir: string, key: string, patch: Partial<RunLockInfo>): boolean;
/** Where a stop request for an automation lives. */
export declare function cancelFile(dir: string, key: string): string;
/**
 * Ask the process running this automation to stop, via a file it polls: on Windows SIGTERM kills
 * the child outright. The file names its run, so a late request cannot stop the next run.
 */
export declare function requestCancel(dir: string, key: string, runId: string): boolean;
/** False for a request aimed at a different run, which is cleared. */
export declare function cancelRequested(dir: string, key: string, runId: string): boolean;
/** Remove a stop request. The child does this on the way out, whatever the outcome. */
export declare function clearCancel(dir: string, key: string): void;
/** Abandoned: the process is gone, or it outlived its timeout plus hook budgets and slack. */
export declare function isRunLockStale(info: RunLockInfo, hookTimeoutMs: number, now: Date): boolean;
/** Clear abandoned run locks, writing `aborted: host stopped` for each. */
export declare function sweepStaleRunLocks(dir: string, config: Config, now: Date, onRecord: (rec: RunRecord) => void): RunRecord[];
/** Build the lock payload for a run that is about to start. */
export declare function runLockInfo(args: {
    key: string;
    runId: string;
    timeoutMs: number;
    postHooks: number;
    trigger: Trigger;
    scheduledFor?: string;
    now: Date;
    pid?: number;
}): RunLockInfo;
