#!/usr/bin/env node
// The `pa` command line, also installed as `pi-automations`: the `/automations` verbs plus `tick`,
// `fire`, `serve`, the in-run verbs (`step`, `next`, `say`, `note`, `status`) and plugin actions.
//
// Exit codes: 0 ok · 1 usage · 2 refused · 10 run skipped · 20 run failed · 30 run aborted
import { homedir } from "node:os";
import process from "node:process";

import {
  applyArm,
  createPiServices,
  handleArm,
  handleCheck,
  handleDisarm,
  handleEnable,
  handleList,
  handleLog,
  handleReport,
  handleRun,
  handleRunning,
  handleWatch,
  helpLines,
  IN_RUN_VERBS,
  inRunHelpLines,
  loadConfig,
  loadConfiguredPlugins,
  ambiguousLine,
  notFoundLine,
  resolveName,
  runAction,
  SUBS,
  progressCli,
  exitCodeForCompletion,
  parseArgs,
  readCompletion,
  refresh,
  runTick,
  State,
  stateDir,
  Trust,
} from "../dist/index.js";

const EXIT = { ok: 0, usage: 1, refused: 2, skipped: 10, failed: 20, aborted: 30 };

function out(lines) {
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
}

function flagValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function spawnFire(args, opts) {
  const services = createPiServices();
  const worker = services.launchWorker({
    entry: services.workerEntry.file,
    args: [...services.workerEntry.args, ...args],
    detached: opts?.attached === false,
    output: { kind: opts?.attached === false ? "ignore" : "inherit" },
  });

  if (opts?.attached === false) {
    // Released, not awaited: the CLI returns as soon as the run is durably started.
    worker.release();
    return Promise.resolve(0);
  }

  return worker.completion.then(
    (completion) => {
      // A worker ended by a signal reports 0; an unreadable completion is the failure.
      const read = readCompletion(completion);
      return read ? exitCodeForCompletion(read) : EXIT.failed;
    },
    () => EXIT.failed,
  );
}

// `pa help`: the management verbs as the CLI spells them, then the CLI-only ones, then the in-run
// ones.
function cliHelpLines(plugins) {
  const edit = plugins?.action("edit");
  return [
    "pa — the pi-automations command line (also installed as pi-automations)",
    "",
    // Every line loses the same ten columns, so the descriptions stay aligned.
    ...helpLines({
      edit: edit ? `${edit.action.label} (${edit.plugin} plugin)` : "open its AUTOMATION.md in $VISUAL, $EDITOR or VS Code",
      actions: (plugins?.actions ?? []).map((a) => ({ id: a.action.id, label: `${a.action.label} (${a.plugin} plugin)` })),
    }).map((l) => (l.startsWith("/automations") ? `pa${l.slice(12)}` : l.slice(10))),
    "pa tick               run what is due, once",
    "pa fire <key>         run one automation by its key, attached",
    "pa serve              tick every minute, in the foreground",
    "",
    ...inRunHelpLines(),
    "",
    "Plugins load from ~/.pi/agent/pi-automations/config.json: \"plugins\": [\"manager\", \"/abs/path/plugin.js\"].",
    "\"manager\" is the bundled Automation Manager: pa edit <name> then opens it in your browser.",
    ...(plugins?.warnings ?? []).map((w) => `  ${w}`),
  ];
}

// The configured plugins, for the verbs that use them. Never for `list` or `run`, which must stay
// quick.
function cliPlugins(config, dir, cwd) {
  return loadConfiguredPlugins({ config, stateDir: dir, where: "cli", cwd: () => cwd });
}

/** Wait for Ctrl+C: a plugin action (the Automation Manager) is serving from this process. */
function stayUntilInterrupted(plugins) {
  return new Promise((resolve) => {
    const stop = () => {
      void plugins.shutdown().finally(() => resolve(EXIT.ok));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** `pa edit <name>` and `pa <plugin action> <name>`. */
async function cliAction(id, name, deps, r, plugins) {
  let status;
  if (name) {
    const match = resolveName(r.statuses, name);
    if (match.kind !== "one") {
      out([match.kind === "ambiguous" ? ambiguousLine(name, match.matches, deps.home) : notFoundLine(name)]);
      return EXIT.refused;
    }
    status = match.status;
  }
  for (const w of plugins.warnings) process.stderr.write(`${w}\n`);
  const result = await runAction({ id, plugins, status, where: "cli", open: !process.argv.includes("--no-open") });
  out(result.lines);
  if (result.keepAlive && !result.exitCode) {
    out(["serving until Ctrl+C"]);
    return stayUntilInterrupted(plugins);
  }
  return result.exitCode ?? EXIT.ok;
}

async function main() {
  const argv = process.argv.slice(2);
  const cwd = flagValue("cwd") ?? process.cwd();
  const json = argv.includes("--json");

  // Reporting from inside a run: no discovery, no pi, just the run's progress file.
  if (IN_RUN_VERBS.has(argv[0] ?? "")) {
    const r = progressCli(argv);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return r.code;
  }

  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    out(cliHelpLines(await cliPlugins(loadConfig(stateDir()).config, stateDir(), cwd)));
    return EXIT.ok;
  }

  // `fire` is a thin passthrough so the CLI and the tick spawn the identical process.
  if (argv[0] === "fire") {
    return spawnFire(argv.slice(1), { attached: true });
  }

  if (argv[0] === "tick") {
    const services = createPiServices();
    const summary = await runTick({
      stateDir: stateDir(),
      host: services.host,
      spawnFire: services.spawnFire(stateDir()),
      runScript: services.runScript,
      modelResolver: () => services.modelResolver(),
      tickedBy: "cli",
    });
    if (!summary) {
      out(["another tick is already running"]);
      return EXIT.ok;
    }
    out([
      json
        ? JSON.stringify(summary)
        : [
            `fired ${summary.fired.length}`,
            // Only when non-zero, so a quiet tick prints the same line as before.
            ...(summary.failed.length ? [`failed ${summary.failed.length}`] : []),
            ...(summary.uncertain.length ? [`uncertain ${summary.uncertain.length}`] : []),
            `missed ${summary.missed.length}`,
            `skipped ${summary.skipped.length}`,
            `swept ${summary.swept.length}`,
            `considered ${summary.considered}`,
            ...(summary.checked?.length ? [`checked ${summary.checked.length}`] : []),
          ].join(" · "),
      // The reason, because an uncertain launch has no record to look it up in.
      ...(json ? [] : summary.uncertain.map((u) => `  uncertain ${u.key}: ${u.reason}`)),
    ]);
    return EXIT.ok;
  }

  if (argv[0] === "serve") {
    const { serve } = await import("../dist/detached/serve.js");
    const services = createPiServices();
    await serve({
      stateDir: stateDir(),
      host: services.host,
      spawnFire: services.spawnFire(stateDir()),
      runScript: services.runScript,
      modelResolver: () => services.modelResolver(),
    });
    return EXIT.ok;
  }

  // `detached` is the old name for `watcher`, still accepted.
  if (argv[0] === "watcher" || argv[0] === "detached") {
    const { detachedCli } = await import("../dist/detached/index.js");
    // Select the scheduler once so start, stop and status agree.
    const scheduler = createPiServices().scheduler;
    const result = await detachedCli(argv.slice(1), {
      stateDir: stateDir(),
      json,
      ...(scheduler ? { backend: scheduler } : {}),
    });
    out(result.lines);
    return result.exitCode ?? EXIT.ok;
  }

  const parsed = parseArgs(argv.filter((a) => a !== "--json").join(" "));
  const dir = stateDir();
  const { config } = loadConfig(dir);
  // `edit`, and any verb this package does not have, may belong to a plugin.
  const pluginVerb = argv[0] && !argv[0].startsWith("-") && (argv[0] === "edit" || !SUBS.has(argv[0])) ? argv[0] : undefined;
  const plugins = pluginVerb ? await cliPlugins(config, dir, cwd) : undefined;
  // A host that cannot reach pi still lists automations, without model re-checks.
  const services = createPiServices();
  const resolveModel = await services.modelResolver();

  const deps = {
    config,
    stateDir: dir,
    trust: new Trust(dir),
    state: new State(dir),
    now: () => new Date(),
    home: homedir(),
    cwd,
    spawnFire: (args, opts) => spawnFire(args, opts),
    runScript: services.runScript,
    ...(resolveModel ? { resolveModel } : {}),
    ...(process.stdout.columns ? { width: process.stdout.columns } : {}),
  };

  const r = await refresh(deps);
  let result;

  if (plugins && (pluginVerb === "edit" || plugins.action(pluginVerb))) {
    const name = argv.slice(1).find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--cwd");
    return cliAction(pluginVerb, name, deps, r, plugins);
  }

  switch (parsed.sub) {
    case "list":
      result = await handleList(deps, r);
      break;
    case "run":
      result = await handleRun(deps, r, parsed.name);
      break;
    case "running":
      result = await handleRunning(deps, r);
      break;
    case "arm":
      result = await handleArm(deps, r, parsed.name);
      break;
    case "disarm":
      result = await handleDisarm(deps, r, parsed.name);
      break;
    case "enable":
      result = await handleEnable(deps, r, parsed.name, true);
      break;
    case "disable":
      result = await handleEnable(deps, r, parsed.name, false);
      break;
    case "log":
    case "runs":
      result = await handleLog(deps, r, parsed.name, parsed.n ?? 10, json);
      break;
    case "check":
      result = await handleCheck(deps, r, parsed.name);
      break;
    case "watch":
      result = await handleWatch(deps, r, parsed.name, parsed.verb);
      break;
    case "report":
      result = await handleReport(deps, r, argv.includes("--open"));
      break;
    case "help":
      result = { lines: cliHelpLines(plugins) };
      break;
    default:
      result = { lines: cliHelpLines(plugins), exitCode: EXIT.usage };
  }

  // Arming needs a person: print what would be agreed to and refuse.
  if (result.consent) {
    if (process.argv.includes("--yes")) {
      out(result.consent.preview);
      out(applyArm(deps, result.consent.located));
      if (result.consent.andRun) {
        return spawnFire([result.consent.located.key, "--manual"], { attached: true });
      }
      return EXIT.ok;
    }
    out(result.consent.preview);
    out(["", "not armed — re-run with --yes to accept, or use /automations arm inside pi"]);
    return EXIT.refused;
  }

  out(result.lines);
  return result.exitCode ?? EXIT.ok;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`${e?.stack ?? String(e)}\n`);
    process.exit(EXIT.failed);
  });
