/** A test-only host substitution that lets a default-path run reach its pre hooks. */
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkg = process.env.DEFAULT_HOST_PKG;
if (!pkg) throw new Error("default host loader requires DEFAULT_HOST_PKG");

// A record left behind reports that a worker ran, not that it finished. The worker is detached, so
// its exit is observable only from inside it; this is inherited through NODE_OPTIONS, which is how
// the same file reaches both the tick and the worker it spawns.
const exitReceipt = process.env.WORKER_EXIT_RECEIPT;
if (exitReceipt) {
  const label = path.basename(process.argv[1] ?? "unknown");
  process.on("exit", (code) => {
    try {
      appendFileSync(exitReceipt, `${JSON.stringify({ label, pid: process.pid, code })}\n`);
    } catch {
      // A receipt that cannot be written must not change what the process under test does.
    }
  });
}

const TARGET = pathToFileURL(path.join(pkg, "dist", "hosts", "pi", "compose.js")).href;
// A query the hook does not match, so the substitute can load the module it is substituting.
const REAL = `${TARGET}?real`;

/** Unique, so a test can prove a refusal came from here and not from a missing dependency. */
export const DENIED_SESSION = "DEFAULT-HOST-SESSION-DENIED-7c42";
export const DENIED_NOTIFY = "DEFAULT-HOST-NOTIFY-DENIED-7c42";

const SOURCE = `
import { createPiServices as real, piHostContext } from ${JSON.stringify(REAL)};
export { piHostContext };

export function createPiServices(overrides) {
  const services = real(overrides);
  return {
    ...services,
    runtime: {
      resolveModel: async (spec) => ({
        provider: "fixture",
        id: spec ?? "fixture-model",
        display: spec ?? "fixture/model",
      }),
      startSession: async () => {
        throw new Error(${JSON.stringify(DENIED_SESSION)});
      },
    },
    notify: async () => {
      throw new Error(${JSON.stringify(DENIED_NOTIFY)});
    },
    scheduler: undefined,
  };
}
`;

registerHooks({
  load(url, context, nextLoad) {
    if (url !== TARGET) return nextLoad(url, context);
    return { format: "module", source: SOURCE, shortCircuit: true };
  },
});
