// The pi host's composition: the one place pi's defaults are chosen. Imports nothing from pi.

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";

import type { AutomationRuntime, LaunchWorker, ModelResolver, Notify, RunScript, StartFlowTracking, StartRun, WorkerEntry } from "../../core/contracts.js";
import { defaultSpawnFire } from "../../tick.js";
import { findPiModule, PI_MODULE_ENV } from "../../pi-module.js";
import { resolveModel } from "../../model.js";
import { desktopNotifier } from "../../notify.js";
import { agentDir, ensureDir, packageDir, stateDir, userRootsFor, type HostRoots } from "../../paths.js";
import { progressTracking } from "../../progress.js";
import { backendFor } from "../../detached/index.js";
import type { PlatformBackend } from "../../detached/types.js";
import { createPiRuntime, listPiModels, loadPiRuntime, type PiModelChoices } from "../../providers/pi/runtime.js";
import { runLocalScript } from "../../providers/scripts.js";
import { launchLocalWorker } from "../../providers/worker.js";
import type { Root } from "../../types.js";

export interface PiHostContext {
  /** The user directories this host discovers from. */
  readonly host: HostRoots;
  /** Where this host keeps consent, history and locks. */
  readonly stateDir: string;
  /** The user-scope roots those directories produce, nearest-first, existing only. */
  readonly userRoots: Root[];
}

/** The pi host's directories. `overrides` lets a test or embedding host say otherwise. */
export function piHostContext(overrides: Partial<HostRoots> = {}): PiHostContext {
  const host: HostRoots = {
    home: overrides.home ?? homedir(),
    agentDir: overrides.agentDir ?? agentDir(),
  };

  const state = overrides.agentDir
    ? path.join(overrides.agentDir, "pi-automations")
    : stateDir();
  if (overrides.agentDir) ensureDir(state);

  return { host, stateDir: state, userRoots: userRootsFor(host) };
}

/** Everything a pi-facing entrypoint is given. */
export interface PiServices extends PiHostContext {
  /** The runtime a run is fired with. Lazy: the SDK loads on first model resolution. */
  readonly runtime: AutomationRuntime;
  // Flowchart progress, via the core progress store that `pa` also writes.
  readonly startTracking: StartFlowTracking;
  /** Hook scripts run as local child processes. */
  readonly runScript: RunScript;
  /** Desktop notifications for failed runs. */
  readonly notify: Notify;
  /** The worker transport and entry (`node bin/fire.js`). */
  readonly launchWorker: LaunchWorker;
  readonly workerEntry: WorkerEntry;
  /** This platform's scheduler backend, or undefined (then `pa serve` is the alternative). */
  readonly scheduler: PlatformBackend | undefined;
  /** The tick's spawn path, composed once. */
  spawnFire(stateDirPath: string): StartRun;
  // The listing's model resolver, or undefined when pi cannot load.
  modelResolver(): Promise<ModelResolver | undefined>;
  /** The models pi can run, for a picker. Rejects with the reason when pi cannot be loaded. */
  modelChoices(cwd: string): Promise<PiModelChoices>;
}

/** The pi location to hand a worker when this process already knows it. */
function piModuleHint(): Record<string, string> | undefined {
  const dir = process.env[PI_MODULE_ENV] ?? findPiModule()?.dir;
  return dir ? { [PI_MODULE_ENV]: dir } : undefined;
}

export function createPiServices(overrides: Partial<HostRoots> = {}): PiServices {
  const context = piHostContext(overrides);

  // Only an explicit agent directory is forwarded; otherwise sessions ask pi.
  const runtime = createPiRuntime(
    overrides.agentDir ? { agentDir: overrides.agentDir } : {},
  );

  const fireScript = path.join(packageDir(), "bin", "fire.js");
  const workerEntry: WorkerEntry = { file: process.execPath, args: [fireScript] };

  return {
    ...context,
    runtime,
    startTracking: progressTracking,
    runScript: runLocalScript,
    notify: desktopNotifier(),
    launchWorker: launchLocalWorker,
    workerEntry,
    scheduler: backendFor(),
    spawnFire: (stateDirPath: string) => {
      const start = defaultSpawnFire(stateDirPath, launchLocalWorker, workerEntry, piModuleHint);
      // Node always exists; check the script, which only this host knows.
      return async (args) =>
        existsSync(fireScript)
          ? start(args)
          : { ok: false, reason: `the worker script does not exist: ${fireScript}` };
    },
    async modelResolver(): Promise<ModelResolver | undefined> {
      try {
        const catalog = await loadPiRuntime();
        return (spec) => resolveModel(spec, catalog);
      } catch {
        return undefined;
      }
    },
    modelChoices: (cwd: string) => listPiModels(cwd),
  };
}
