import {
  chmodSync,
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { FileContent, FileEntry, FileLanguage, FileListing } from "../plugins/types.js";
import type { Located } from "../types.js";
import { AUTOMATION_FILE, FLOW_FILE, HostServiceError, MAX_FILE_BYTES, SKIPPED_DIRS, sha256, stripBomBuffer } from "./compose.js";

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ADS = /:/;
const DECODER = new TextDecoder("utf-8", { fatal: true });

/** Whether two names refer to the same entry: Windows and macOS compare case-insensitively. */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
export function sameName(a: string, b: string): boolean {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function normalizeBrowserPath(input: string | null, opts: { allowEmpty: boolean; creating?: boolean } = { allowEmpty: true }): string {
  const raw = input ?? "";
  if (raw === "" && opts.allowEmpty) return "";
  if (raw === "" && !opts.allowEmpty) throw new HostServiceError("bad-request", "path is required");
  if (raw.includes("\0") || raw.includes("\\") || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("//")) {
    throw new HostServiceError("bad-request", "path must be a /-separated relative path");
  }
  const parts = raw.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || ADS.test(p))) {
    throw new HostServiceError("bad-request", "path must not contain empty, dot, dot-dot or colon segments");
  }
  if (opts.creating && parts.some((p) => RESERVED.test(p))) {
    throw new HostServiceError("bad-request", "path uses a Windows reserved name");
  }
  // Windows drops a trailing dot or space, so such names are refused everywhere.
  if (parts.some((p) => /[. ]$/.test(p))) {
    throw new HostServiceError("bad-request", "path segments must not end with a dot or a space");
  }
  return parts.join("/");
}

function assertNotSkipped(rel: string): void {
  for (const part of rel.split("/").filter(Boolean)) {
    if ((SKIPPED_DIRS as readonly string[]).some((dir) => sameName(dir, part))) {
      throw new HostServiceError("bad-request", `${part} is not browsed`);
    }
  }
}

// Is `file` AUTOMATION.md or flow.mmd under any spelling (case, trailing dot, 8.3 short name)?
function isMonitorDocument(located: Located, rel: string, file: string): boolean {
  if (sameName(rel, AUTOMATION_FILE) || sameName(rel, FLOW_FILE)) return true;
  if (!existsSync(file)) return false;
  const target = statSync(file);
  for (const name of [AUTOMATION_FILE, FLOW_FILE]) {
    const doc = path.join(located.dir, name);
    if (!existsSync(doc)) continue;
    const s = statSync(doc);
    if (s.ino === target.ino && s.dev === target.dev) return true;
  }
  return false;
}

export function resolveInside(root: string, rel: string, opts: { mustExist?: boolean; creating?: boolean } = {}): string {
  assertNotSkipped(rel);
  const full = path.resolve(root, ...rel.split("/").filter(Boolean));
  const rootReal = realpathSync(root);
  const parentRel = path.dirname(rel);
  const parent = parentRel === "." ? root : path.resolve(root, ...parentRel.split("/"));
  const parentReal = opts.creating && !existsSync(parent) ? realpathSync(nearestExisting(root, parent)) : realpathSync(parent);
  if (!inside(parentReal, rootReal)) throw new HostServiceError("bad-request", "path leaves the automation folder");
  if (existsSync(full)) {
    const real = realpathSync(full);
    if (!inside(real, rootReal) && real !== rootReal) throw new HostServiceError("bad-request", "path leaves the automation folder");
  } else if (opts.mustExist) {
    throw new HostServiceError("not-found", "file not found");
  }
  assertNoSymlinkSegments(root, rel, opts.creating);
  return full;
}

function nearestExisting(root: string, target: string): string {
  let cur = target;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur || !inside(parent, root)) return root;
    cur = parent;
  }
  return cur;
}

function assertNoSymlinkSegments(root: string, rel: string, creating?: boolean): void {
  let cur = root;
  const parts = rel.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i] as string);
    if (!existsSync(cur)) {
      if (creating) continue;
      throw new HostServiceError("not-found", "file not found");
    }
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) throw new HostServiceError("bad-request", "symbolic links are not browsed");
  }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function updatedAt(file: string): string | null {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

export function languageFor(rel: string): FileLanguage {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".md") return "markdown";
  if (ext === ".mmd") return "mermaid";
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if ([".ts", ".mts", ".cts"].includes(ext)) return "typescript";
  if ([".json", ".jsonc"].includes(ext)) return "json";
  if ([".yml", ".yaml"].includes(ext)) return "yaml";
  if (ext === ".toml") return "toml";
  if ([".sh", ".bash"].includes(ext)) return "shell";
  if ([".ps1", ".psm1"].includes(ext)) return "powershell";
  if (ext === ".py") return "python";
  return "text";
}

function roleFor(rel: string, located: Located): FileEntry["role"] {
  if (sameName(rel, AUTOMATION_FILE)) return "automation";
  if (sameName(rel, FLOW_FILE)) return "flow";
  // Every script AUTOMATION.md can run, the watch included: `hook-script` means "runs as you".
  const scripts = new Set<string>();
  for (const phase of ["pre", "post"] as const) {
    for (const hook of located.automation.hooks[phase]) if ("script" in hook) scripts.add(hook.script.replace(/\\/g, "/"));
  }
  if (located.automation.on.watch) scripts.add(located.automation.on.watch.script.replace(/\\/g, "/"));
  return scripts.has(rel) ? "hook-script" : undefined;
}

export function listFiles(located: Located, rel: string): FileListing {
  const norm = normalizeBrowserPath(rel, { allowEmpty: true });
  const dir = resolveInside(located.dir, norm, { mustExist: true });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new HostServiceError("bad-request", "path is not a directory");
  const entries: FileEntry[] = [];
  const skipped: FileListing["skipped"] = [];
  const names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
  for (const name of names.slice(0, 500)) {
    const childRel = norm ? `${norm}/${name}` : name;
    if ((SKIPPED_DIRS as readonly string[]).some((dir) => sameName(dir, name))) {
      skipped.push({ name, reason: "skipped directory" });
      continue;
    }
    const full = path.join(dir, name);
    const lst = lstatSync(full);
    if (lst.isSymbolicLink()) {
      skipped.push({ name, reason: "symbolic link" });
      continue;
    }
    if (lst.isDirectory()) {
      entries.push({ name, path: childRel, kind: "dir", bytes: 0, updatedAt: updatedAt(full) });
    } else if (lst.isFile()) {
      const e: FileEntry = { name, path: childRel, kind: "file", bytes: lst.size, updatedAt: updatedAt(full) };
      const role = roleFor(childRel, located);
      if (role) e.role = role;
      entries.push(e);
    }
  }
  if (names.length > 500) skipped.push({ name: "…", reason: "entry limit" });
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { path: norm, entries, skipped };
}

export function readTextFile(located: Located, rel: string): FileContent {
  const norm = normalizeBrowserPath(rel, { allowEmpty: false });
  const file = resolveInside(located.dir, norm, { mustExist: true });
  const st = statSync(file);
  if (!st.isFile()) throw new HostServiceError("bad-request", "path is not a file");
  if (st.size > MAX_FILE_BYTES) throw new HostServiceError("too-large", "file is too large");
  const bytes = readFileSync(file);
  let decoded: string;
  try {
    decoded = DECODER.decode(bytes);
  } catch {
    throw new HostServiceError("unsupported", "file is not strict UTF-8 text");
  }
  if (decoded.includes("\0")) throw new HostServiceError("unsupported", "file contains NUL bytes");
  const { text, bom } = stripBomBuffer(bytes);
  const out: FileContent = {
    path: norm,
    text,
    bom,
    revision: sha256(bytes),
    bytes: bytes.length,
    updatedAt: updatedAt(file),
    language: languageFor(norm),
  };
  const role = roleFor(norm, located);
  if (role) out.role = role;
  return out;
}

export function atomicWriteText(file: string, text: string, bom = false): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let mode: number | undefined;
  try {
    mode = statSync(file).mode;
  } catch {
    mode = undefined;
  }
  writeFileSync(tmp, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]) : text);
  if (mode !== undefined && process.platform !== "win32") chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export function writeTextFile(located: Located, rel: string, body: { text: string; base: string | null; bom?: boolean }): FileContent {
  const norm = normalizeBrowserPath(rel, { allowEmpty: false, creating: true });
  if (Buffer.byteLength(body.text, "utf8") + (body.bom ? 3 : 0) > MAX_FILE_BYTES) {
    throw new HostServiceError("too-large", "file is too large");
  }
  const file = resolveInside(located.dir, norm, { creating: true });
  // AUTOMATION.md and flow.mmd are only written through the save, which runs the parser first.
  if (isMonitorDocument(located, norm, file)) {
    throw new HostServiceError("use-monitor", "AUTOMATION.md and flow.mmd are saved as the automation, which checks them first");
  }
  const exists = existsSync(file);
  if (body.base === null) {
    if (exists) throw new HostServiceError("conflict", "file already exists", { current: { file: sha256(readFileSync(file)) } });
  } else {
    if (!exists) throw new HostServiceError("conflict", "file is missing", { current: { file: null } });
    const current = readTextFile(located, norm);
    if (current.revision !== body.base) throw new HostServiceError("conflict", "file changed on disk", { current: { file: current.revision } });
  }
  const bom = body.bom ?? (exists ? readTextFile(located, norm).bom : false);
  atomicWriteText(file, body.text, bom);
  return readTextFile(located, norm);
}

export function writableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
