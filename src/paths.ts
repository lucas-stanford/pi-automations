// Where everything lives. Plain node: pi's agent directory is injected via `setAgentDir`.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fnv1a } from "./stagger.js";
import type { Root, Scope } from "./types.js";

let agentDirOverride: string | undefined;

/** Called by the extension with pi's own `getAgentDir()` so both processes agree. */
export function setAgentDir(dir: string | undefined): void {
  agentDirOverride = dir ? path.resolve(dir) : undefined;
}

/** pi's agent directory, e.g. `~/.pi/agent`. */
export function agentDir(): string {
  if (agentDirOverride) return agentDirOverride;
  const fromEnv = process.env.PI_AGENT_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(homedir(), ".pi", "agent");
}

/** All plugin state: mode 0700, never inside a repository. */
export function stateDir(): string {
  const dir = path.join(agentDir(), "pi-automations");
  ensureDir(dir);
  return dir;
}

/** mkdir -p with 0700, tolerating an existing directory. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directories a host decides, so a non-pi host or a test needs no particular home directory.
 */
export interface HostRoots {
  /** The user's home directory. `~/.agents/automations` is built from this. */
  readonly home: string;
  /** pi's agent directory, or whatever a non-pi host uses in its place. */
  readonly agentDir: string;
}

/** The ambient answer: the environment and the documented defaults. */
export function ambientHostRoots(): HostRoots {
  return { home: homedir(), agentDir: agentDir() };
}

/** User-scope roots, nearest first. The order and `kind` labels are part of the state keys. */
export function userRootsFor(host: HostRoots): Root[] {
  const candidates: Root[] = [
    { path: path.resolve(path.join(host.home, ".agents", "automations")), scope: "user", kind: "agents" },
    { path: path.resolve(path.join(host.agentDir, "automations")), scope: "user", kind: "pi" },
  ];
  return candidates.filter((r) => isDir(r.path));
}

/** User-scope roots for this process. */
export function userRoots(): Root[] {
  return userRootsFor(ambientHostRoots());
}

/** Walk up from `cwd` to the first directory with a `.git` entry (clone or worktree). */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Repository-scope roots from `cwd` up to the git root, nearest first, existing only. */
export function repoRoots(cwd: string): { repoRoot?: string; roots: Root[] } {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return { roots: [] };

  const roots: Root[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    for (const [rel, kind] of [
      [path.join(".agents", "automations"), "agents"],
      [path.join(".pi", "automations"), "pi"],
    ] as const) {
      const p = path.resolve(path.join(dir, rel));
      if (isDir(p)) roots.push({ path: p, scope: "repository", kind });
    }
    if (dir === repoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { repoRoot, roots };
}

/** The roots contributed by an explicitly registered repository root (used at tick time). */
export function rootsForRegistered(repoRoot: string): Root[] {
  const roots: Root[] = [];
  for (const [rel, kind] of [
    [path.join(".agents", "automations"), "agents"],
    [path.join(".pi", "automations"), "pi"],
  ] as const) {
    const p = path.resolve(path.join(repoRoot, rel));
    if (isDir(p)) roots.push({ path: p, scope: "repository", kind });
  }
  return roots;
}

/**
 * Stable identity built from `path.resolve`, so different spellings of a directory give one key.
 */
export function key(scope: Scope, rootPath: string, name: string): string {
  return `${scope}:${path.resolve(rootPath)}:${name}`;
}

/** Filesystem-safe, collision-resistant name for per-automation files. */
export function slug(k: string): string {
  const base = k
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base}-${fnv1a(k).toString(16).padStart(8, "0")}`;
}

/** The installed package root — `dist/..`, which is also `src/..` when running from source. */
export function packageDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Sub-paths under the state directory. Kept here so nothing else spells them. */
export function statePaths(dir: string = stateDir()) {
  return {
    dir,
    config: path.join(dir, "config.json"),
    trust: path.join(dir, "trust.json"),
    state: path.join(dir, "state.json"),
    detached: path.join(dir, "detached.json"),
    runs: path.join(dir, "runs"),
    locks: path.join(dir, "locks"),
    logs: path.join(dir, "logs"),
    reports: path.join(dir, "reports"),
    /** One small events file per tracked run while it is going. See `src/progress.ts`. */
    progress: path.join(dir, "progress"),
    tickLock: path.join(dir, "locks", "tick.lock"),
    /** Held for each read-change-write of trust.json. See `src/trust.ts`. */
    trustLock: path.join(dir, "locks", "trust.lock"),
  };
}

/** One automation's run log: a background run's stdout and stderr. Always build the path here. */
export function fireLogPath(stateDir: string, key: string): string {
  return path.join(statePaths(stateDir).logs, `fire-${slug(key)}.log`);
}

/** Replace the home directory prefix with `~` for display. Never used to build a real path. */
export function tildify(p: string, home: string = homedir()): string {
  const resolved = path.resolve(p);
  const h = path.resolve(home);
  if (resolved === h) return "~";
  if (resolved.toLowerCase().startsWith(h.toLowerCase() + path.sep)) {
    return "~" + resolved.slice(h.length).split(path.sep).join("/");
  }
  return resolved.split(path.sep).join("/");
}
