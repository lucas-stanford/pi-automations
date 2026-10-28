import { type HostRoots } from "./paths.js";
import type { LaunchWorker, ModelResolver, RunScript, StartRun, WorkerEntry } from "./core/contracts.js";
import type { State } from "./state.js";
import type { Trust } from "./trust.js";
import type { Config, Located, Root, Schedule, Status, TickSource } from "./types.js";
export interface TickDecision {
    action: "none" | "wait" | "fire" | "missed";
    scheduledFor?: Date;
    late: boolean;
    /** How many due instants will never run. For `missed` this includes `scheduledFor` itself. */
    missedCount: number;
    missedUntil?: Date;
    waitingFrom?: Date;
}
export interface DecideTickArgs {
    schedule: Schedule;
    claimedIso?: string;
    lastTickAt?: Date;
    now: Date;
    staggerSec: number;
    graceMs: number;
    catchUpWindowMs: number;
}
/** What should happen to one automation now. The window starts after the last tick and claim. */
export declare function decideTick(a: DecideTickArgs): TickDecision;
export interface TickDeps {
    config: Config;
    stateDir: string;
    trust: Trust;
    state: State;
    now: Date;
    spawnFire: StartRun;
    statuses: Status[];
    /** How an `on.watch` script runs. Without one, a due watch is recorded as unable to run. */
    runScript?: RunScript;
    located?: ReadonlyMap<string, Located>;
    tickedBy?: TickSource;
}
export interface TickSummary {
    fired: string[];
    /** Due, claimed, and confirmed not to have started. One terminal record each. */
    failed: string[];
    uncertain: Array<{
        key: string;
        reason: string;
    }>;
    missed: string[];
    skipped: string[];
    swept: string[];
    waiting: string[];
    checked: string[];
    considered: number;
}
export declare function tick(deps: TickDeps): Promise<TickSummary>;
export declare function runTick(options: {
    stateDir: string;
    now?: Date;
    spawnFire: StartRun;
    roots?: Root[];
    modelResolver?: () => Promise<ModelResolver | undefined>;
    /** The user directories to discover from. Composes with registered repository roots. */
    host?: HostRoots;
    runScript?: RunScript;
    tickedBy?: TickSource;
}): Promise<TickSummary | undefined>;
/**
 * Spawn a detached worker logging to its fire log; resolves on startup. `workerEnv` comes from the
 * host.
 */
export declare function defaultSpawnFire(stateDirPath: string, launch: LaunchWorker, worker: WorkerEntry, workerEnv?: () => Record<string, string> | undefined): StartRun;
