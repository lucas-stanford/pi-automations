import type { AutomationRuntime, LaunchWorker, ModelResolver, Notify, RunScript, StartFlowTracking, StartRun, WorkerEntry } from "../../core/contracts.js";
import { type HostRoots } from "../../paths.js";
import type { PlatformBackend } from "../../detached/types.js";
import { type PiModelChoices } from "../../providers/pi/runtime.js";
import type { Root } from "../../types.js";
export interface PiHostContext {
    /** The user directories this host discovers from. */
    readonly host: HostRoots;
    /** Where this host keeps consent, history and locks. */
    readonly stateDir: string;
    /** The user-scope roots those directories produce, nearest-first, existing only. */
    readonly userRoots: Root[];
}
/** The pi host's directories. `overrides` lets a test or embedding host say otherwise. */
export declare function piHostContext(overrides?: Partial<HostRoots>): PiHostContext;
/** Everything a pi-facing entrypoint is given. */
export interface PiServices extends PiHostContext {
    /** The runtime a run is fired with. Lazy: the SDK loads on first model resolution. */
    readonly runtime: AutomationRuntime;
    readonly startTracking: StartFlowTracking;
    /** Hook scripts run as local child processes. */
    readonly runScript: RunScript;
    /** Desktop notifications for failed runs. */
    readonly notify: Notify;
    /** The worker transport and entry (`node bin/fire.js`). */
    readonly launchWorker: LaunchWorker;
    readonly workerEntry: WorkerEntry;
    /** This platform's scheduler backend, or undefined (then `pa serve` is the alternative). */
    readonly scheduler: PlatformBackend | undefined;
    /** The tick's spawn path, composed once. */
    spawnFire(stateDirPath: string): StartRun;
    modelResolver(): Promise<ModelResolver | undefined>;
    /** The models pi can run, for a picker. Rejects with the reason when pi cannot be loaded. */
    modelChoices(cwd: string): Promise<PiModelChoices>;
}
export declare function createPiServices(overrides?: Partial<HostRoots>): PiServices;
