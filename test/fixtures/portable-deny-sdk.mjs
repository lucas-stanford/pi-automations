/** A real denial of the pi SDK, for proving portability. */
import { appendFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Unique, so a control can prove the refusal came from HERE and not from a missing file. */
export const DENIED_MARKER = "PORTABLE-SDK-DENIED-8f3a1c";

// Match SDK packages by scope, plus unscoped installs only under node_modules; this worktree itself
// can be named `pi-tui`.
const FORBIDDEN = /(^|[\\/])@earendil-works[\\/]|[\\/]node_modules[\\/](pi-coding-agent|pi-tui)([\\/]|$)/;

register(new URL("./portable-deny-sdk-hooks.mjs", import.meta.url).href, pathToFileURL("./"), {
  data: { marker: DENIED_MARKER, pattern: FORBIDDEN.source },
});

const entry = process.env.PORTABLE_SDK_ENTRY;
const receipt = process.env.PORTABLE_DENIAL_RECEIPT;

if (entry && receipt) {
  // Named after the script it is guarding, so a tick and the worker it spawns produce
  // distinguishable receipts without the parent having to thread a label through the env it does
  // not control.
  const label =
    process.env.PORTABLE_DENIAL_LABEL ?? path.basename(process.argv[1] ?? "unknown");
  let outcome;
  try {
    await import(pathToFileURL(entry).href);
    outcome = { denied: false, code: null, message: "the SDK entry imported successfully" };
  } catch (e) {
    const message = String(e?.message ?? e);
    outcome = { denied: message.includes(DENIED_MARKER), code: e?.code ?? null, message };
  }

  appendFileSync(receipt, `${JSON.stringify({ label, pid: process.pid, entry, ...outcome })}\n`);

  if (!outcome.denied) {
    process.stderr.write(`${label}: SDK denial is NOT active — ${outcome.message}\n`);
    process.exit(78);
  }
}
