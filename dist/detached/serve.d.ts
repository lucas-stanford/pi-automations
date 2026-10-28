/** `pa serve`: ticks in the foreground, for containers and shells with no scheduler. */
import type { ModelResolver } from "../core/contracts.js";
import type { HostRoots } from "../paths.js";
import type { Root } from "../types.js";
export interface ServeOptions {
    stateDir: string;
    intervalSec?: number;
    /** Stops the loop. Used by tests, and by a signal handler in the CLI. */
    signal?: AbortSignal;
    log?: (line: string) => void;
    /** Restrict discovery. Production leaves it unset; tests must set it. See runTick. */
    roots?: Root[];
    /** Forwarded to every tick, so each one gets a fresh catalog. See runTick. */
    modelResolver?: () => Promise<ModelResolver | undefined>;
    spawnFire?: import("../core/contracts.js").StartRun;
    /** How each tick runs a watch script. Composed by the host, like `spawnFire`. */
    runScript?: import("../core/contracts.js").RunScript;
    /** The host's user directories, forwarded to every tick. See runTick. */
    host?: HostRoots;
}
export declare function serve(opts: ServeOptions): Promise<void>;
