#!/usr/bin/env node
// One run, as its own process. The attached path and the OS job both spawn this. stdout carries one
// NDJSON FireEvent per line, the last being the record; stderr is free-form.
//
// Usage:
//   node fire.js <key> [--scheduled-for <iso>] [--late] [--manual | --watch] [--run-id <id>]
import process from "node:process";

import {
  createPiServices,
  discover,
  fire,
  located,
  loadConfig,
  loadConfiguredPlugins,
  PI_MODULE_ENV,
  State,
  stateDir,
  Trust,
} from "../dist/index.js";

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function value(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const EXIT = { ok: 0, usage: 1, refused: 2, skipped: 10, failed: 20, aborted: 30 };

/** Ignore EPIPE: a viewer going away must never change a run's outcome. */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => {});
}

async function main() {
  const key = process.argv[2];
  if (!key || key.startsWith("--")) {
    process.stderr.write("usage: fire.js <key> [--scheduled-for <iso>] [--late] [--manual | --watch]\n");
    return EXIT.usage;
  }

  const dir = stateDir();
  const { config } = loadConfig(dir);
  const state = new State(dir);

  const found = discover({ extraRepoRoots: state.roots });
  const target = located(found).find((l) => l.key === key);

  if (!target) {
    // Not an error worth a stack trace: the automation was deleted between the tick and now.
    process.stderr.write(`no automation with key ${key}\n`);
    return EXIT.refused;
  }

  const emit = (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  // Publish `config.piModule` for `pi-module.ts`, since pi's loader aliases do not apply here.
  if (config.piModule && !process.env[PI_MODULE_ENV]) {
    process.env[PI_MODULE_ENV] = config.piModule;
  }

  // A missing pi becomes an ordinary record naming the fix, not a stack trace.
  const services = createPiServices();

  // Plugins hear about this run too; a broken one is a problem on the record.
  const plugins = await loadConfiguredPlugins({ config, stateDir: dir, where: "worker", cwd: () => process.cwd() }).catch(
    () => undefined,
  );

  const record = await fire(
    target,
    {
      // A watch that found something starts its run with --watch; the tick never passes both.
      trigger: flag("manual") ? "manual" : flag("watch") ? "watch" : "schedule",
      late: flag("late"),
      ...(value("scheduled-for") ? { scheduledFor: value("scheduled-for") } : {}),
      ...(value("run-id") ? { runId: value("run-id") } : {}),
      // --flow tracks this run on a flowchart even if the automation is not normally tracked.
      ...(flag("flow") ? { forceFlow: true } : {}),
      emit,
    },
    {
      config,
      stateDir: dir,
      trust: new Trust(dir),
      state,
      runtime: services.runtime,
      startTracking: services.startTracking,
      runScript: services.runScript,
      notify: services.notify,
      ...(plugins && plugins.loaded.length + plugins.warnings.length > 0 ? { observe: plugins } : {}),
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
