/**
 * Wrong transports, compiled against the REAL exported portable tick contract.
 *
 * Never imported by anything that runs. `tick-composition.test.ts` compiles it with a real `tsc`
 * and asserts the diagnostics, because vitest strips types without checking them — a
 * `@ts-expect-error` in a test file would prove nothing about whether the compiler agrees.
 *
 * The point of the whole slice is that the portable tick cannot be composed without a way to start
 * a run. `omittedTransport` is that case, and before this it compiled: `spawnFire` was optional and
 * silently defaulted.
 */

import { runTick } from "../../src/tick.js";

const roots = [{ path: "/nowhere", scope: "user" as const, kind: "agents" as const }];

/** No transport at all. */
export const omittedTransport = () => runTick({ stateDir: "/nowhere", roots });

/** A transport that answers nothing — the `void` an old fire-and-forget fake returned. */
export const voidTransport = () =>
  runTick({ stateDir: "/nowhere", roots, spawnFire: () => {} });

/** Synchronous, rather than resolving with an acknowledgment. */
export const syncTransport = () =>
  runTick({ stateDir: "/nowhere", roots, spawnFire: () => ({ ok: true, pid: 1 }) });

/** Resolves, but with something that is not an acknowledgment. */
export const wrongResult = () =>
  runTick({ stateDir: "/nowhere", roots, spawnFire: async () => true });
