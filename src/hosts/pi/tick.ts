// A tick that composes the pi transport and script executor when the caller passes none.

import { runTick, type TickSummary } from "../../tick.js";
import type { Root } from "../../types.js";
import type { RunScript, StartRun } from "../../core/contracts.js";

export interface PiTickOptions {
  stateDir: string;
  now?: Date;
  /** Supply one and this is a pass-through; omit it and the pi default is composed. */
  spawnFire?: StartRun;
  // How a watch script runs. Omitted, the pi host's local executor is composed, like the transport.
  runScript?: RunScript;
  /** Restrict discovery. Production leaves it unset; tests must set it. See `runTick`. */
  roots?: Root[];
  host?: Parameters<typeof runTick>[0]["host"];
  modelResolver?: Parameters<typeof runTick>[0]["modelResolver"];
  tickedBy?: Parameters<typeof runTick>[0]["tickedBy"];
}

/** Imported lazily, so importing this module does not load the pi composition. */
async function piTransport(stateDir: string): Promise<StartRun> {
  const { createPiServices } = await import("./compose.js");
  return createPiServices().spawnFire(stateDir);
}

async function piScripts(): Promise<RunScript> {
  const { createPiServices } = await import("./compose.js");
  return createPiServices().runScript;
}

/**
 * Run one tick, composing the pi transport and script executor when the caller did not supply them.
 */
export async function runPiTick(options: PiTickOptions): Promise<TickSummary | undefined> {
  const spawnFire = options.spawnFire ?? (await piTransport(options.stateDir));
  const runScript = options.runScript ?? (await piScripts());
  return runTick({ ...options, spawnFire, runScript });
}
