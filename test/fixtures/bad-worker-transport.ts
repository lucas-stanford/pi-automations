/**
 * Worker transports that are WRONG, kept so a compiler can say so.
 *
 * Never imported by anything that runs — it exists to be compiled by `tsc` from
 * `worker-completion.test.ts`, which asserts the diagnostics. vitest strips types without checking
 * them, so a `@ts-expect-error` inside a test file would prove nothing about whether the compiler
 * actually rejects these.
 *
 * Each one is a transport a host could plausibly write, and each states an ending it cannot back
 * up. Before `WorkerCompletion` became a discriminated union, the first one compiled cleanly and
 * every caller read it as a clean exit.
 */

import type { LaunchWorker } from "../../src/core/contracts.js";

const handle = { release: () => {} };

/** The shape the old interface allowed: ended, and the transport cannot say how. */
export const neitherEndNorSignal: LaunchWorker = () => ({
  ...handle,
  completion: Promise.resolve({ exit: null, signal: null }),
});

/** Claims an exit without a code. */
export const exitWithoutCode: LaunchWorker = () => ({
  ...handle,
  completion: Promise.resolve({ end: "exit" }),
});

/** Claims a signal without naming it. */
export const signalWithoutName: LaunchWorker = () => ({
  ...handle,
  completion: Promise.resolve({ end: "signal" }),
});

/** Both at once, which is not something a process can do. */
export const bothAtOnce: LaunchWorker = () => ({
  ...handle,
  completion: Promise.resolve({ end: "exit", exit: 0, signal: "SIGTERM" }),
});

/** An exit code that is not a number. */
export const stringExit: LaunchWorker = () => ({
  ...handle,
  completion: Promise.resolve({ end: "exit", exit: "0" }),
});

const exitCarryingSignal = { end: "exit" as const, exit: 0, signal: "SIGTERM" as NodeJS.Signals };
const signalCarryingExit = { end: "signal" as const, signal: "SIGTERM" as NodeJS.Signals, exit: 1 };

/** Claims an exit while also naming a signal, through a variable. */
export const contradictoryExitViaVariable: LaunchWorker = () => ({
  ...handle,
  completion: Promise.resolve(exitCarryingSignal),
});

/** Claims a signal while also carrying an exit code, through a variable. */
export const contradictorySignalViaVariable: LaunchWorker = () => ({
  ...handle,
  completion: Promise.resolve(signalCarryingExit),
});
