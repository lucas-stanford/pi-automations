// Finding pi from a plain node process, where pi's loader aliases do not exist. Order: the parent's
// `PI_AUTOMATIONS_PI_MODULE`, `piModule` in config, resolution, `pi` on PATH, the npm global root.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** The one package name this module will ever load. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Env var carrying an exact path from a parent that already knows where pi is. */
export const PI_MODULE_ENV = "PI_AUTOMATIONS_PI_MODULE";

export type PiLocation = {
  /** Directory of the pi package — the one containing its `package.json`. */
  dir: string;
  /** How it was found; recorded so a run can explain itself. */
  via: "env" | "config" | "resolve" | "path" | "npm-root";
};

export type FindPiOptions = {
  env?: NodeJS.ProcessEnv;
  /** `piModule` from config, when the operator set one. */
  configured?: string | undefined;
  /** Injected for tests; defaults to running `npm root -g`. */
  npmRoot?: () => string | undefined;
  /** Injected for tests; defaults to looking up `pi` on PATH. */
  which?: (cmd: string) => string | undefined;
};

/** Is this directory really the pi package? Checked against `package.json`, never the path. */
export function isPiPackage(dir: string): boolean {
  try {
    const raw = readFileSync(path.join(dir, "package.json"), "utf8");
    return (JSON.parse(raw) as { name?: unknown }).name === PI_PACKAGE;
  } catch {
    return false;
  }
}

/** Walk up from a file to the pi package directory that contains it. */
function packageRootAbove(start: string, levels = 6): string | undefined {
  let dir = start;
  for (let i = 0; i < levels; i++) {
    if (isPiPackage(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** Follow a symlink chain, so a `pi` shim in `.bin` leads to the real file. */
function realTarget(file: string): string {
  let current = file;
  for (let i = 0; i < 10; i++) {
    try {
      if (!statSync(current).isSymbolicLink?.()) {
        const link = readlinkSync(current);
        current = path.resolve(path.dirname(current), link);
        continue;
      }
    } catch {
    }
    return current;
  }
  return current;
}

/** Launcher shims usually name their script relative to themselves; resolve it against the shim. */
function targetInsideShim(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8");
    if (text.length > 64 * 1024) return undefined;
    const hit = /([^"'\r\n]*?node_modules[\\/]@earendil-works[\\/]pi-coding-agent)/.exec(text);
    if (!hit?.[1]) return undefined;
    const raw = hit[1].replace(/^.*?%~dp0/, "").replace(/^\$basedir[\\/]/, "");
    return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(file), raw);
  } catch {
    return undefined;
  }
}

/** The npm layouts a launcher can sit in. */
function packageBesideLauncher(launcherDir: string): string | undefined {
  const parts = PI_PACKAGE.split("/");
  for (const base of [launcherDir, path.dirname(launcherDir), path.dirname(path.dirname(launcherDir))]) {
    const direct = path.join(base, "node_modules", ...parts);
    if (isPiPackage(direct)) return direct;
    const bare = path.join(base, ...parts);
    if (isPiPackage(bare)) return bare;
  }
  return undefined;
}

function defaultWhich(cmd: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of ["", ...exts]) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
      }
    }
  }
  return undefined;
}

function defaultNpmRoot(): string | undefined {
  try {
    const out = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.trim().split(/\r?\n/).pop();
    return line && line !== "" ? line : undefined;
  } catch {
    return undefined;
  }
}

/** Where is pi? `undefined` when no copy can be proven. */
export function findPiModule(opts: FindPiOptions = {}): PiLocation | undefined {
  const env = opts.env ?? process.env;
  const which = opts.which ?? defaultWhich;
  const npmRoot = opts.npmRoot ?? defaultNpmRoot;

  // 1. An exact path from a parent that already knew.
  const fromEnv = env[PI_MODULE_ENV];
  if (fromEnv && fromEnv !== "" && isPiPackage(fromEnv)) return { dir: fromEnv, via: "env" };

  // 2. An operator override.
  if (opts.configured && opts.configured !== "" && isPiPackage(opts.configured)) {
    return { dir: opts.configured, via: "config" };
  }

  // 3. Ordinary resolution. Resolve the entry, not `package.json`, which pi's `exports` map hides.
  try {
    const url = import.meta.resolve?.(PI_PACKAGE);
    if (url) {
      const entry = fileURLToPath(url);
      const root = packageRootAbove(path.dirname(entry), 8);
      if (root) return { dir: root, via: "resolve" };
    }
  } catch {
    // Not resolvable from here, which is the normal case — keep looking.
  }

  // 4. The `pi` on PATH. A failed lookup means keep looking, never crash.
  try {
    const launcher = which("pi");
    if (launcher) {
      const launcherDir = path.dirname(realTarget(launcher));
      const beside = packageBesideLauncher(launcherDir);
      if (beside) return { dir: beside, via: "path" };

      const above = packageRootAbove(launcherDir);
      if (above) return { dir: above, via: "path" };

      const shimmed = targetInsideShim(launcher);
      if (shimmed) {
        const root = isPiPackage(shimmed) ? shimmed : packageRootAbove(shimmed, 8);
        if (root) return { dir: root, via: "path" };
      }
    }
  } catch {
  }

  // 5. The npm global root.
  try {
    const root = npmRoot();
    if (root) {
      const candidate = path.join(root, ...PI_PACKAGE.split("/"));
      if (isPiPackage(candidate)) return { dir: candidate, via: "npm-root" };
    }
  } catch {
    // Nothing left to try.
  }

  return undefined;
}

/** What a person sees when pi cannot be found: what is wrong, then the fix. */
export const PI_MISSING_MESSAGE =
  `pi: cannot find ${PI_PACKAGE} from a background run — ` +
  `install pi globally, or set piModule in ~/.pi/agent/pi-automations/config.json to its package directory`;

let cached: { key: string; mod: unknown } | undefined;

/** Import pi from wherever it is, cached per resolved directory. */
export async function importPi(opts: FindPiOptions = {}): Promise<Record<string, unknown>> {
  const found = findPiModule(opts);
  if (!found) throw new Error(PI_MISSING_MESSAGE);
  if (cached?.key === found.dir) return cached.mod as Record<string, unknown>;

  const url = pathToFileURL(path.join(found.dir, "package.json")).href;
  const pkg = JSON.parse(readFileSync(new URL(url), "utf8")) as {
    main?: string;
    exports?: unknown;
    engines?: { node?: unknown };
  };
  // An older node fails inside pi with an unhelpful SyntaxError; say what is wrong instead.
  const needs = minimumNode(pkg.engines?.node);
  if (needs && olderThan(process.versions.node, needs)) {
    throw new Error(`pi needs Node ${needs} or newer, and this is Node ${process.versions.node}`);
  }
  const entry =
    typeof pkg.exports === "string"
      ? pkg.exports
      : entryFromExports(pkg.exports) ?? pkg.main ?? "index.js";
  const mod = (await import(pathToFileURL(path.join(found.dir, entry)).href)) as Record<
    string,
    unknown
  >;
  cached = { key: found.dir, mod };
  return mod;
}

/** `22.19.0` from an `engines.node` of `>=22.19.0`; undefined for any other form. */
export function minimumNode(range: unknown): string | undefined {
  if (typeof range !== "string") return undefined;
  const m = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range);
  return m ? `${m[1]}.${m[2] ?? "0"}.${m[3] ?? "0"}` : undefined;
}

/** True when version `have` is below `need`. Both are `major.minor.patch`. */
export function olderThan(have: string, need: string): boolean {
  const a = have.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = need.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** Pull the default import condition out of an `exports` map, without pretending to be node. */
function entryFromExports(exports: unknown): string | undefined {
  if (!exports || typeof exports !== "object") return undefined;
  const root = (exports as Record<string, unknown>)["."] ?? exports;
  if (typeof root === "string") return root;
  if (!root || typeof root !== "object") return undefined;
  for (const key of ["import", "module", "default", "require"]) {
    const value = (root as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const nested = entryFromExports({ ".": value });
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Test seam — forget the cached module. */
export function resetPiCache(): void {
  cached = undefined;
}
