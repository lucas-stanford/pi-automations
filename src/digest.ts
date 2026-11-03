// The consent pin: one hash over AUTOMATION.md, every script and the local modules those scripts
// import (paths included), so any edit disarms.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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

/** Scripts whose local imports run with them, so consent covers those files too. */
const MODULE_SCRIPTS = new Set([".mjs", ".js", ".cjs"]);

/**
 * The local files the scripts import, directly or through each other: what `import … from`,
 * `import(…)`, `export … from` and `require(…)` name with a `./` or `../` path in a `.mjs`, `.js`
 * or `.cjs` file. Relative paths written with `/`, never a script itself, in the order aat hashes
 * them. A package (`node:fs`, `yaml`), a file outside the automation directory and a file that does
 * not exist are left out.
 */
export function moduleFiles(l: Located): string[] {
  const scripts = new Set(
    scriptFiles(l).flatMap((s) => resolveInside([], s.script) ?? []),
  );
  const found = new Set<string>();
  const queue = [...scripts];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (!MODULE_SCRIPTS.has(path.posix.extname(file))) continue;
    let source: string;
    try {
      source = readFileSync(path.join(l.dir, file), "utf8");
    } catch {
      continue;
    }
    for (const spec of localSpecifiers(source)) {
      const base = resolveInside(file.split("/").slice(0, -1), spec);
      if (base === undefined) continue;
      // `require("./lib")` may leave the extension out.
      const target = ["", ".js", ".mjs", ".cjs"]
        .map((ext) => base + ext)
        .find((p) => isFile(path.join(l.dir, p)));
      if (target === undefined || scripts.has(target) || found.has(target)) continue;
      found.add(target);
      queue.push(target);
    }
  }
  // Part by part, as aat sorts them, so both hosts hash the same bytes.
  return [...found].sort((a, b) => comparePaths(a.split("/"), b.split("/")));
}

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as string) < (b[i] as string) ? -1 : 1;
  }
  return a.length - b.length;
}

/** `p` (with `/` or `\`) taken from the directory `from`, or undefined when it climbs out. */
function resolveInside(from: string[], p: string): string | undefined {
  const parts = [...from];
  for (const part of p.split(/[/\\]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The `./` and `../` paths a JavaScript source imports. Comments are skipped, a string ends on its
 * own line, and it counts only right after `from`, `import`, `import(` or `require(`.
 */
export function localSpecifiers(source: string): string[] {
  const lineEnd = (from: number): number => {
    const n = source.indexOf("\n", from);
    return n === -1 ? source.length : n;
  };
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      i = lineEnd(i);
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      const close = source.slice(i + 1, lineEnd(i + 1)).indexOf(c);
      if (close === -1) {
        i += 1;
        continue;
      }
      const literal = source.slice(i + 1, i + 1 + close);
      if ((literal.startsWith("./") || literal.startsWith("../")) && followsImport(source.slice(0, i))) {
        out.push(literal);
      }
      i += close + 2;
    } else {
      i += 1;
    }
  }
  return out;
}

function followsImport(before: string): boolean {
  let head = before.trimEnd();
  if (head.endsWith("(")) head = head.slice(0, -1).trimEnd();
  return ["from", "import", "require"].some(
    (word) => head.endsWith(word) && !/[\p{L}\p{N}_$.]$/u.test(head.slice(0, -word.length)),
  );
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

/**
 * `"sha256:<hex>"` over AUTOMATION.md plus every script it can run, in order, then every module
 * those scripts import. Without imports it is the digest it always was.
 */
export function digestOf(l: Located): string {
  const h = createHash("sha256");
  h.update(readOrRefuse(l.file, "AUTOMATION.md", "AUTOMATION.md"));
  const add = (rel: string, bytes: Buffer): void => {
    h.update(rel, "utf8");
    h.update(NUL);
    h.update(bytes);
    h.update(NUL);
  };

  for (const s of scriptFiles(l)) {
    add(s.script, readOrRefuse(path.resolve(l.dir, s.script), s.field, JSON.stringify(s.script)));
  }
  for (const module of moduleFiles(l)) {
    // Found a moment ago; one removed since is simply no longer imported.
    try {
      add(module, readFileSync(path.join(l.dir, module)));
    } catch {
      continue;
    }
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
  for (const module of moduleFiles(l)) {
    out[module] = hashFile(path.join(l.dir, module));
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
