// Find the automations. Never throws: a malformed file is reported as `invalid`.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { AutomationError, oneLine } from "./errors.js";
import { scriptFiles } from "./digest.js";
import { parseAutomation } from "./parse.js";
import { findRepoRoot, key as makeKey, repoRoots, rootsForRegistered, userRoots, userRootsFor, type HostRoots } from "./paths.js";
import type { Discovered, Located, Root } from "./types.js";

export interface DiscoverOptions {
  /** Working directory used for repository-scope discovery. Omit for user scope only. */
  cwd?: string;
  /** Registered repository roots, used at tick time when there is no meaningful cwd. */
  extraRepoRoots?: string[];
  /** The user directories this host uses. Omitted means the ambient answer. */
  host?: HostRoots;
  /** Injected for tests. */
  roots?: Root[];
}

export function discover(opts: DiscoverOptions = {}): Discovered[] {
  const roots = opts.roots ?? collectRoots(opts);
  const seen = new Set<string>();
  const out: Discovered[] = [];

  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name)
        .sort();
    } catch {
      // A root that vanished between listing and reading contributes nothing.
      continue;
    }

    const repoRoot = root.scope === "repository" ? findRepoRoot(root.path) : undefined;

    for (const name of entries) {
      const dir = path.resolve(root.path, name);
      const file = path.join(dir, "AUTOMATION.md");
      const key = makeKey(root.scope, root.path, name);

      if (seen.has(key)) continue;

      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        // A directory without an AUTOMATION.md is not an automation; skip it silently.
        if (code === "ENOENT") continue;
        seen.add(key);
        out.push({
          ok: false,
          dir,
          file,
          root,
          key,
          error: `AUTOMATION.md: cannot read — ${code ?? "unknown error"}`,
        });
        continue;
      }

      seen.add(key);

      try {
        const automation = parseAutomation(text, name);
        const located: Located = { automation, dir, file, root, key };
        if (repoRoot) located.repoRoot = repoRoot;

        const escape = findEscapingScript(located);
        if (escape) {
          out.push({ ok: false, dir, file, root, key, error: escape });
          continue;
        }

        out.push({ ok: true, located });
      } catch (e) {
        out.push({
          ok: false,
          dir,
          file,
          root,
          key,
          error: e instanceof AutomationError ? e.message : oneLine(e),
          ...(e instanceof AutomationError && e.problems ? { problems: e.problems } : {}),
        });
      }
    }
  }

  return out;
}

function collectRoots(opts: DiscoverOptions): Root[] {
  const roots: Root[] = [...(opts.host ? userRootsFor(opts.host) : userRoots())];
  if (opts.cwd) roots.push(...repoRoots(opts.cwd).roots);
  for (const extra of opts.extraRepoRoots ?? []) {
    roots.push(...rootsForRegistered(extra));
  }
  return roots;
}

// Refuse a script that resolves outside its folder, e.g. through a symlink.
function findEscapingScript(l: Located): string | undefined {
  let realDir: string;
  try {
    realDir = realpathSync(l.dir);
  } catch {
    return undefined;
  }

  for (const s of scriptFiles(l)) {
    const abs = path.resolve(l.dir, s.script);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      // Missing scripts are reported later, by the digest, with a better message.
      continue;
    }

    if (!isInside(real, realDir)) {
      return `${s.field}: ${JSON.stringify(s.script)} resolves outside the automation directory`;
    }
  }
  return undefined;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Only the automations that parsed. */
export function located(found: Discovered[]): Located[] {
  return found.filter((d): d is { ok: true; located: Located } => d.ok).map((d) => d.located);
}

/** Find one discovered automation by key. */
export function byKey(found: Discovered[], key: string): Discovered | undefined {
  return found.find((d) => (d.ok ? d.located.key : d.key) === key);
}
