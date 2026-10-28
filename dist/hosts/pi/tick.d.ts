import { runTick, type TickSummary } from "../../tick.js";
import type { Root } from "../../types.js";
import type { RunScript, StartRun } from "../../core/contracts.js";
export interface PiTickOptions {
    stateDir: string;
    now?: Date;
    /** Supply one and this is a pass-through; omit it and the pi default is composed. */
    spawnFire?: StartRun;
    runScript?: RunScript;
    /** Restrict discovery. Production leaves it unset; tests must set it. See `runTick`. */
    roots?: Root[];
    host?: Parameters<typeof runTick>[0]["host"];
    modelResolver?: Parameters<typeof runTick>[0]["modelResolver"];
    tickedBy?: Parameters<typeof runTick>[0]["tickedBy"];
}
/**
 * Run one tick, composing the pi transport and script executor when the caller did not supply them.
 */
export declare function runPiTick(options: PiTickOptions): Promise<TickSummary | undefined>;
