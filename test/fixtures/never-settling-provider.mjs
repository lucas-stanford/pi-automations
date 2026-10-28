/** A real, standalone child whose provider never settles. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const stateDir = process.argv[2];
// `late` (the default) rejects after the bound; `forever` never settles at all.
const mode = process.argv[3] === "forever" ? "forever" : "late";
if (!stateDir) {
  process.stderr.write("usage: never-settling-provider.mjs <stateDir>\n");
  process.exit(64);
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const dist = path.join(here, "..", "..", "dist");

const { discover } = await import(pathToFileURL(path.join(dist, "discover.js")).href);
const { fire } = await import(pathToFileURL(path.join(dist, "run.js")).href);
const { Trust } = await import(pathToFileURL(path.join(dist, "trust.js")).href);
const { digestOf } = await import(pathToFileURL(path.join(dist, "digest.js")).href);
const { State } = await import(pathToFileURL(path.join(dist, "state.js")).href);
const { DEFAULTS } = await import(pathToFileURL(path.join(dist, "config.js")).href);
const { runLocalScript } = await import(pathToFileURL(path.join(dist, "providers", "scripts.js")).href);

const root = path.join(stateDir, "automations");
const dir = path.join(root, "never");
mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(dir, "AUTOMATION.md"),
  "---\nname: never\ndescription: A probe automation.\non:\n  manual: true\n---\n\nDo the thing.\n",
);

const located = discover({ roots: [{ path: root, scope: "user", kind: "agents" }] })[0];
if (!located?.ok) {
  process.stderr.write("probe automation did not parse\n");
  process.exit(65);
}
// Armed, as a person would have armed it: this probe is about the notifier, not consent.
new Trust(stateDir).arm(located.located, digestOf(located.located), {}, new Date(), 0);

const problems = [];
let lateRejectionHandled = false;

const runtime = {
  resolveModel: async () => ({ id: "fake", display: "fake" }),
  listModels: async () => [],
  // Fails on purpose: `notifyOnFailed` only raises for a FAILED run, so the notifier - the provider
  // this fixture is about - is only reached at all when the run itself failed.
  startSession: async () => {
    throw new Error("the body itself failed, which is what brings the notifier in");
  },
};

const record = await fire(
  located.located,
  {
    trigger: "manual",
    runId: "never-run-1",
    emit: (e) => {
      if (e.event === "problem") problems.push(e.message);
    },
  },
  {
    config: { ...DEFAULTS, notifyOnFailed: true },
    // A short bound so the child does not sit through the production 15s. The point is not the
    // duration; it is that the wait ENDS and its timer does not hold node open afterwards.
    providerTimeoutMs: 200,
    stateDir,
    trust: new Trust(stateDir),
    state: new State(stateDir),
    runtime,
    runScript: runLocalScript,
    // Two shapes, because they fail differently. `late` never resolves and then rejects long after
    // the bound gave up, which must be handled and must not change the result. `forever` never
    // settles at all and holds no timer, so nothing but the bound itself can end the wait.
    notify: () =>
      mode === "forever"
        ? new Promise(() => {})
        : new Promise((_resolve, reject) => {
            const t = setTimeout(() => {
              lateRejectionHandled = true;
              reject(new Error("the notifier failed, far too late to matter"));
            }, 500);
            // Unref'd deliberately: this is the provider's timer, and a provider must not be what
            // keeps the process alive either.
            t.unref?.();
          }),
  },
);

process.stdout.write(
  `${JSON.stringify({
    settled: true,
    result: record.outcome,
    errorKind: record.error?.kind ?? null,
    errorMessage: record.error?.message ?? null,
    problem: problems[0] ?? null,
    problems,
    mode,
    // Read after a tick, so the late rejection has had its chance to land and be handled.
    lateRejectionHandled: await new Promise((r) => setTimeout(() => r(lateRejectionHandled), 800)),
  })}\n`,
);

// No explicit `process.exit`. If node does not exit on its own here, something in the run is
// holding the event loop open — which is the defect this whole fixture exists to catch.
