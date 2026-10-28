// A tick that composes the pi transport and script executor when the caller passes none.
import { runTick } from "../../tick.js";
/** Imported lazily, so importing this module does not load the pi composition. */
async function piTransport(stateDir) {
    const { createPiServices } = await import("./compose.js");
    return createPiServices().spawnFire(stateDir);
}
async function piScripts() {
    const { createPiServices } = await import("./compose.js");
    return createPiServices().runScript;
}
/**
 * Run one tick, composing the pi transport and script executor when the caller did not supply them.
 */
export async function runPiTick(options) {
    const spawnFire = options.spawnFire ?? (await piTransport(options.stateDir));
    const runScript = options.runScript ?? (await piScripts());
    return runTick({ ...options, spawnFire, runScript });
}
//# sourceMappingURL=tick.js.map