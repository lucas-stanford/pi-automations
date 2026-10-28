#!/usr/bin/env node
/**
 * A real run, in a real isolated worker, reporting what everything downstream actually inherited.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createPiRuntime,
  DEFAULTS,
  digestOf,
  discover,
  fire,
  progressEnvironment,
  importPi,
  runLocalScript,
  State,
  Trust,
} from "../../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(30);
}

const ID = arg("id") ?? die("--id is required");
const ROOT = arg("root") ?? die("--root is required");
const STATE = arg("state") ?? die("--state is required");
const SESSION = arg("session") ?? die("--session is required");
const BARRIER = arg("barrier");
const PEER = arg("peer");
const OUT = arg("out");

// Which reporting child the session spawns.
//
// Overridable for one reason: to point it at something that cannot start, and prove that a failed
// child makes this worker FAIL rather than emit a report describing a run it could not observe.
const CHILD = arg("child") ?? path.join(HERE, "env-worker.js");

/** Keys a hook child and an SDK child are asked to report. */
const WATCHED = [
  "AUTOMATION_RUN",
  "AUTOMATION_NODE",
  "AUTOMATION_STATE_DIR",
  "AUTOMATION_NAME",
  "AUTOMATION_RUN_ID",
  "AUTOMATION_PHASE",
  "AUTOMATION_OUTCOME",
  "WORKER_API_KEY",
  "WORKER_TOKEN",
  "WORKER_SECRET",
  "WORKER_ORDINARY",
];

/** This process's own view of the keys that matter, so before/after can be compared. */
function ownEnv() {
  const out = {};
  for (const k of ["AUTOMATION_RUN", "AUTOMATION_NODE", "AUTOMATION_STATE_DIR"]) {
    out[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : null;
  }
  return out;
}

/** Wait until the peer has reached the same point, or fail. Never silently continues. */
function barrier(stage) {
  if (!BARRIER || !PEER) return { used: false };
  mkdirSync(BARRIER, { recursive: true });

  // Written atomically.
  const own = path.join(BARRIER, `${ID}.${stage}`);
  const tmp = `${own}.${process.pid}.tmp`;
  writeFileSync(tmp, String(process.pid), "utf8");
  renameSync(tmp, own);

  const peerFile = path.join(BARRIER, `${PEER}.${stage}`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // Arrival is a readable pid, not a filename: belt and braces, so this cannot regress if the
    // write above is ever made non-atomic again.
    const pid = readPid(peerFile);
    if (pid > 0) return { used: true, peerPid: pid };
    // A real synchronous sleep. This is a synchronous point inside an async session start, and the
    // whole claim is that BOTH workers are sitting here wearing their overlays at once, so it must
    // not yield to this worker's own event loop.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  die(`barrier timed out at ${stage}: ${PEER} never arrived`);
  return { used: true };
}

/** The peer's pid, or 0 when it has not arrived yet — including a file that exists but is empty. */
function readPid(file) {
  if (!existsSync(file)) return 0;
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** Run the reporting child with NO environment of its own. */
function spawnInheritingChild(label) {
  const r = spawnSync(process.execPath, [CHILD, ...WATCHED], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.error) die(`${label} child could not start: ${r.error.message}`);
  if (r.status !== 0) die(`${label} child exited ${r.status}: ${(r.stderr || "").trim()}`);
  try {
    return JSON.parse(r.stdout).self;
  } catch (e) {
    die(`${label} child output was not a report: ${e.message} — ${(r.stdout || "").trim()}`);
  }
  return null;
}

async function main() {
  let sdkPresent = false;
  let sdkDetail = "";
  try {
    await importPi();
    sdkPresent = true;
  } catch (e) {
    sdkDetail = String(e?.message ?? e).slice(0, 200);
  }
  const injected = { catalogLoads: 0, sessionStarts: 0, promptsAsked: 0 };

  const before = ownEnv();

  // ---- 2. one automation, in an explicit temporary root ------------------------------------
  const dir = path.join(ROOT, "joined");
  mkdirSync(dir, { recursive: true });

  const hookScript =
    `import { writeFileSync } from "node:fs";\n` +
    `import path from "node:path";\n` +
    `const keys = ${JSON.stringify(WATCHED)};\n` +
    `const out = {};\n` +
    `for (const k of keys) out[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : null;\n` +
    `const phase = process.env.AUTOMATION_PHASE ?? "unknown";\n` +
    `const index = process.env.AUTOMATION_HOOK_INDEX ?? "0";\n` +
    `writeFileSync(path.join(${JSON.stringify(STATE)}, \`hook-\${phase}\${index}.json\`), JSON.stringify(out), "utf8");\n` +
    `process.stdout.write("hook ok");\n`;
  writeFileSync(path.join(dir, "report.mjs"), hookScript, "utf8");

  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    "---\n" +
      "name: joined\n" +
      "description: A joined-proof automation.\n" +
      "on:\n  manual: true\n" +
      "hooks:\n" +
      "  pre:\n    - script: report.mjs\n" +
      "  post:\n    - script: report.mjs\n" +
      "---\n\nDo the thing.\n",
    "utf8",
  );

  const roots = [{ path: ROOT, scope: "user", kind: "agents" }];
  const found = discover({ roots });
  const first = found[0];
  if (!first?.ok) die(`fixture did not parse: ${first ? first.error : "not found"}`);
  const located = first.located;
  new Trust(STATE).arm(located, digestOf(located), {}, new Date(), 0);

  // ---- 3. the identity's ONLY origin: tracking ---------------------------------------------
  const startTracking = () => ({
    start: () => SESSION,
    next() {},
    step() {},
    mark() {},
    say() {},
    end() {
      return undefined;
    },
    environment: (node) => progressEnvironment({ runId: SESSION, stateDir: STATE, node }),
  });

  // ---- 4. a session that spawns while the overlay is live ----------------------------------
  let duringSession = null;
  let sdkChild = null;
  let barrierResult = { used: false };

  const runtime = createPiRuntime({
    // ONE owner, as production has: the catalog and the session opener are the same object, so a
    // fake cannot pair a catalog from one place with a session from another either.
    loadServices: async () => {
      injected.catalogLoads++;
      return {
        // No network, no credentials, no model list that can move. Nothing here can cost anything.
        catalog: {
          providers: () => ["anthropic"],
          getModel: (provider, id) => ({ id, provider }),
          checkAuth: async () => true,
          defaultModel: () => ({ provider: "anthropic", id: "default", display: "anthropic/default" }),
        },
        openSession: async () => {
          injected.sessionStarts++;
          // The adapter applied the overlay before calling this, so THIS is what an SDK sees.
          duringSession = ownEnv();
          barrierResult = barrier("session");
          sdkChild = spawnInheritingChild("sdk");
          return {
            file: path.join(STATE, "session.jsonl"),
            id: `${ID}-session`,
            prompt: async () => {
              injected.promptsAsked++;
              return "done";
            },
            dispose: () => {},
          };
        },
      };
    },
  });

  const record = await fire(
    located,
    { trigger: "manual", now: () => new Date("2026-09-17T14:00:00.000Z") },
    {
      config: { ...DEFAULTS, notifyOnFailed: false },
      stateDir: STATE,
      trust: new Trust(STATE),
      state: new State(STATE),
      runtime,
      runScript: runLocalScript,
      startTracking,
      hookTimeoutMs: 15_000,
      // No `notify`: this host tells nobody, so no desktop path exists here at all.
    },
  );

  const after = ownEnv();

  const readHook = (name) => {
    const f = path.join(STATE, `hook-${name}.json`);
    if (!existsSync(f)) die(`hook ${name} left no report — it did not run`);
    return JSON.parse(readFileSync(f, "utf8"));
  };

  const report = {
    id: ID,
    pid: process.pid,
    sdkPresent,
    sdkDetail,
    injected,
    before,
    duringSession,
    after,
    sdkChild,
    pre: readHook("pre0"),
    post: readHook("post0"),
    barrier: barrierResult,
    record: {
      outcome: record.outcome,
      reason: record.reason ?? null,
      hooks: (record.hooks ?? []).map((h) => ({ phase: h.phase, index: h.index, status: h.status })),
    },
  };

  const text = `${JSON.stringify(report)}\n`;
  if (OUT) writeFileSync(OUT, text, "utf8");
  process.stdout.write(text);
}

main().catch((e) => {
  process.stderr.write(`worker failed: ${e?.stack ?? e}\n`);
  process.exit(31);
});
