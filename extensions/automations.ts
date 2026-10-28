// The pi extension entry point: registration only, plus what to do when `dist/` is older than this
// file. pi re-transpiles this file on `/reload` while `dist/index.js` stays cached, so a new
// extension can meet an old dist. Imports only `dist/index.js` so that case can still be reported.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createAutomationsExtension } from "../dist/index.js";

// One line, carrying the symbol that was missing and the one thing that fixes it.
//
// One rather than two: a person reading a warning strip gets the cause and the remedy together, and
// a second line only pushes the first one off.
const RESTART =
  "pi-automations was reloaded but its compiled library is still the one this session started with" +
  " (createAutomationsExtension is not available from it) — restart pi to pick it up";

/** Say it once per session. Headless goes to stderr, since `--json` callers parse stdout. */
export function registerUnavailable(pi: ExtensionAPI): void {
  let said = false;
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (said) return;
    said = true;
    if (!ctx.hasUI) {
      process.stderr.write(`${RESTART}\n`);
      return;
    }
    try {
      ctx.ui.notify(RESTART, "warning");
    } catch {
      // A context belonging to a dead session throws. There is nothing further to try.
    }
  });
}

export default function (pi: ExtensionAPI): void {
  if (typeof createAutomationsExtension !== "function") {
    // Register nothing else: a half-live session that silently does nothing is worse.
    registerUnavailable(pi);
    return;
  }

  // pi's own agent directory and key matcher, injected so `src/` stays loadable without the SDK.
  createAutomationsExtension(pi, { agentDir: getAgentDir(), matchesKey });
}