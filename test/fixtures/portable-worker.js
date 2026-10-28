#!/usr/bin/env node
/** The worker a host that is not pi composes. */
import process from "node:process";
import { pathToFileURL } from "node:url";

const EXIT = { ok: 0, usage: 1, refused: 2, skipped: 10, failed: 20, aborted: 30 };

function value(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`portable worker requires ${name}`);
  return v;
}

async function main() {
  const key = process.argv[2];
  if (!key || key.startsWith("--")) {
    process.stderr.write("usage: portable-worker.js <key>\n");
    return EXIT.usage;
  }

  const core = await import(pathToFileURL(need("PORTABLE_CORE")).href);
  const { portableRuntime } = await import(pathToFileURL(need("PORTABLE_RUNTIME")).href);

  const stateDirPath = need("PORTABLE_STATE");
  const found = core.discover({
    roots: [{ path: need("PORTABLE_ROOT"), scope: "user", kind: "agents" }],
  });
  const target = core.located(found).find((l) => l.key === key);
  if (!target) {
    process.stderr.write(`no automation with key ${key}\n`);
    return EXIT.refused;
  }

  const record = await core.fire(
    target,
    {
      trigger: "schedule",
      ...(value("scheduled-for") ? { scheduledFor: value("scheduled-for") } : {}),
      ...(value("run-id") ? { runId: value("run-id") } : {}),
      emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    },
    {
      config: { ...core.DEFAULTS, notifyOnFailed: false },
      stateDir: stateDirPath,
      trust: new core.Trust(stateDirPath),
      state: new core.State(stateDirPath),
      runtime: portableRuntime({
        sessionDir: need("PORTABLE_SESSIONS"),
        answers: ["the detached answer"],
        ...(process.env.PORTABLE_GATE ? { gateFile: process.env.PORTABLE_GATE } : {}),
      }),
      runScript: core.runLocalScript,
    },
  );

  return EXIT[record.outcome] ?? EXIT.ok;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`${e?.stack ?? String(e)}\n`);
    process.exit(EXIT.failed);
  });
