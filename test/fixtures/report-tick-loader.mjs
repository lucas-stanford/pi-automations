/** A test-only loader that makes the tick's transport answer in a chosen way. */
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkg = process.env.REPORT_PKG;
const mode = process.env.REPORT_MODE;
if (!pkg) throw new Error("report tick loader requires REPORT_PKG");
if (mode !== "failed" && mode !== "uncertain") {
  throw new Error(`report tick loader requires REPORT_MODE of failed|uncertain, got ${mode}`);
}

const TARGET = pathToFileURL(path.join(pkg, "dist", "hosts", "pi", "compose.js")).href;

/** The marker a test looks for, so a matching string cannot arrive from anywhere else. */
export const FAILED_REASON = "REPORT-FIXTURE-CONFIRMED-FAILURE-4b21";

const SOURCE = `
import path from "node:path";
import { agentDir, ensureDir, userRootsFor } from "../../paths.js";

const MODE = process.env.REPORT_MODE;

export function createPiServices() {
  const dir = agentDir();
  const stateDirPath = path.join(dir, "pi-automations");
  ensureDir(stateDirPath);
  const home = process.env.HOME ?? process.env.USERPROFILE;

  return {
    host: { home, agentDir: dir },
    stateDir: stateDirPath,
    workerEntry: { file: process.execPath, args: [] },
    // Never spawns. The question here is what the tick REPORTS about an answer, so a real child
    // would add nothing and could only make the test slower and less deterministic.
    spawnFire: () => async () =>
      MODE === "failed"
        ? { ok: false, reason: ${JSON.stringify(FAILED_REASON)} }
        : { ok: true },
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
