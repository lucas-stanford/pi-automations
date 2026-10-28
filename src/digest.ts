// The consent pin: one hash over AUTOMATION.md and every script (paths included), so any edit
// disarms.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AutomationError } from "./errors.js";
import type { Hook, Located } from "./types.js";

/** Every script hook, in the order the run will execute them. */
export function scriptHooks(l: Located): Array<{ phase: "pre" | "post"; index: number; script: string }> {
  const out: Array<{ phase: "pre" | "post"; index: number; script: string }> = [];
  for (const phase of ["pre", "post"] as const) {
    l.automation.hooks[phase].forEach((hook: Hook, index: number) => {
      if ("script" in hook) out.push({ phase, index, script: hook.script });
    });
  }
  return out;
}

/** Every script this automation can run: the watch script first, then hooks in run order. */
export function scriptFiles(l: Located): Array<{ field: string; script: string }> {
  const out: Array<{ field: string; script: string }> = [];
  if (l.automation.on.watch) out.push({ field: "on.watch.script", script: l.automation.on.watch.script });
  for (const s of scriptHooks(l)) {
    out.push({ field: `hooks.${s.phase}[${s.index}].script`, script: s.script });
  }
  return out;
}

function readOrRefuse(file: string, field: string, shown: string): Buffer {
  try {
    return readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new AutomationError(field, `${shown} not found`);
    throw new AutomationError(field, `${shown} cannot be read — ${code ?? "unknown error"}`);
  }
}

/** `"sha256:<hex>"` over AUTOMATION.md plus every script it can run, in order. */
export function digestOf(l: Located): string {
  const h = createHash("sha256");
  h.update(readOrRefuse(l.file, "AUTOMATION.md", "AUTOMATION.md"));

  for (const s of scriptFiles(l)) {
    const abs = path.resolve(l.dir, s.script);
    h.update(s.script, "utf8");
    h.update(NUL);
    h.update(readOrRefuse(abs, s.field, JSON.stringify(s.script)));
    h.update(NUL);
  }

  return `sha256:${h.digest("hex")}`;
}

const NUL = Buffer.from([0]);

/** Per-file hashes, so a mismatch can name the file. A missing file is `null`. */
export function fileHashesOf(l: Located): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  out["AUTOMATION.md"] = hashFile(l.file);
  for (const s of scriptFiles(l)) {
    out[s.script] = hashFile(path.resolve(l.dir, s.script));
  }
  return out;
}

function hashFile(file: string): string | null {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  } catch {
    return null;
  }
}
