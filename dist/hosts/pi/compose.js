// The pi host's composition: the one place pi's defaults are chosen. Imports nothing from pi.
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { defaultSpawnFire } from "../../tick.js";
import { findPiModule, PI_MODULE_ENV } from "../../pi-module.js";
import { resolveModel } from "../../model.js";
import { desktopNotifier } from "../../notify.js";
import { agentDir, ensureDir, packageDir, stateDir, userRootsFor } from "../../paths.js";
import { progressTracking } from "../../progress.js";
import { backendFor } from "../../detached/index.js";
import { createPiRuntime, listPiModels, loadPiRuntime } from "../../providers/pi/runtime.js";
import { runLocalScript } from "../../providers/scripts.js";
import { launchLocalWorker } from "../../providers/worker.js";
/** The pi host's directories. `overrides` lets a test or embedding host say otherwise. */
export function piHostContext(overrides = {}) {
    const host = {
        home: overrides.home ?? homedir(),
        agentDir: overrides.agentDir ?? agentDir(),
    };
    const state = overrides.agentDir
        ? path.join(overrides.agentDir, "pi-automations")
        : stateDir();
    if (overrides.agentDir)
        ensureDir(state);
    return { host, stateDir: state, userRoots: userRootsFor(host) };
}
/** The pi location to hand a worker when this process already knows it. */
function piModuleHint() {
    const dir = process.env[PI_MODULE_ENV] ?? findPiModule()?.dir;
    return dir ? { [PI_MODULE_ENV]: dir } : undefined;
}
export function createPiServices(overrides = {}) {
    const context = piHostContext(overrides);
    // Only an explicit agent directory is forwarded; otherwise sessions ask pi.
    const runtime = createPiRuntime(overrides.agentDir ? { agentDir: overrides.agentDir } : {});
    const fireScript = path.join(packageDir(), "bin", "fire.js");
    const workerEntry = { file: process.execPath, args: [fireScript] };
    return {
        ...context,
        runtime,
        startTracking: progressTracking,
        runScript: runLocalScript,
        notify: desktopNotifier(),
        launchWorker: launchLocalWorker,
        workerEntry,
        scheduler: backendFor(),
        spawnFire: (stateDirPath) => {
            const start = defaultSpawnFire(stateDirPath, launchLocalWorker, workerEntry, piModuleHint);
            // Node always exists; check the script, which only this host knows.
            return async (args) => existsSync(fireScript)
                ? start(args)
                : { ok: false, reason: `the worker script does not exist: ${fireScript}` };
        },
        async modelResolver() {
            try {
                const catalog = await loadPiRuntime();
                return (spec) => resolveModel(spec, catalog);
            }
            catch {
                return undefined;
            }
        },
        modelChoices: (cwd) => listPiModels(cwd),
    };
}
//# sourceMappingURL=compose.js.map