/** The test-only loader the detached proof runs `bin/tick.js` under. */
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkg = process.env.PORTABLE_PKG;
if (!pkg) throw new Error("portable tick loader requires PORTABLE_PKG");

const TARGET = pathToFileURL(path.join(pkg, "dist", "hosts", "pi", "compose.js")).href;

/** The fixture host. */
const SOURCE = `
import path from "node:path";
import { defaultSpawnFire } from "../../tick.js";
import { ensureDir } from "../../paths.js";
import { launchLocalWorker } from "../../providers/worker.js";

export function createPiServices() {
  const agentDir = process.env.PORTABLE_AGENT_DIR;
  const stateDirPath = path.join(agentDir, "pi-automations");
  ensureDir(stateDirPath);

  // The worker runs under the SAME denial as everything else, and PORTABLE_DENIAL_LABEL makes its
  // receipt distinguishable from the tick's. Without this the worker — the process that actually
  // runs the automation — would be the one place the SDK was still reachable.
  const workerEntry = {
    file: process.execPath,
    args: ["--import", process.env.PORTABLE_DENY_URL, process.env.PORTABLE_WORKER],
  };

  return {
    host: { home: process.env.PORTABLE_HOME, agentDir },
    stateDir: stateDirPath,
    spawnFire: (dir) => defaultSpawnFire(dir, launchLocalWorker, workerEntry),
    modelResolver: async () => undefined,
  };
}
`;

registerHooks({
  load(url, context, nextLoad) {
    if (url !== TARGET) return nextLoad(url, context);
    return { format: "module", source: SOURCE, shortCircuit: true };
  },
});
