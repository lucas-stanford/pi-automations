/** Consent for fixtures: every automation is off until armed, so tests about something else arm first. */

import { digestOf } from "../../src/digest.js";
import { discover, located } from "../../src/discover.js";
import { Trust } from "../../src/trust.js";
import type { Located } from "../../src/types.js";

/** Record consent for the automation's current bytes, as `pa arm --yes` would. No expiry. */
export function armForTest(l: Located, stateDir: string): void {
  new Trust(stateDir).arm(l, digestOf(l), {}, new Date(), 0);
}

/** Arm every valid automation in one user root, keyed as discovery will key it. */
export function armUserRoot(root: string, stateDir: string, kind: "agents" | "pi" = "agents"): void {
  for (const l of located(discover({ roots: [{ path: root, scope: "user", kind }] }))) {
    armForTest(l, stateDir);
  }
}
