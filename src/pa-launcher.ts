// `pa` launchers in `<state>/bin`, one per shell, put first on a run's PATH.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { packageDir } from "./paths.js";

const ensured = new Set<string>();

export function paLauncherDir(stateDir: string): string {
  return path.join(stateDir, "bin");
}

function writeIfChanged(file: string, text: string, mode?: number): void {
  let current: string | undefined;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== text) writeFileSync(file, text);
  if (mode !== undefined) chmodSync(file, mode);
}

/**
 * Write the launchers once per process; a failure leaves the run without `pa`, never without a run.
 */
export function ensurePaLauncher(stateDir: string, opts: { node?: string; script?: string } = {}): string | undefined {
  const dir = paLauncherDir(stateDir);
  if (ensured.has(dir) && existsSync(path.join(dir, "pa"))) return dir;
  const node = opts.node ?? process.execPath;
  const script = opts.script ?? path.join(packageDir(), "bin", "pi-automations.js");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const slash = (p: string) => p.replace(/\\/g, "/");
    writeIfChanged(path.join(dir, "pa"), `#!/bin/sh\nexec "${slash(node)}" "${slash(script)}" "$@"\n`, 0o755);
    if (process.platform === "win32") {
      writeIfChanged(path.join(dir, "pa.cmd"), `@"${node}" "${script}" %*\r\n`);
    }
    ensured.add(dir);
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * `{ PATH: <launchers>;<PATH> }` under the name this process already uses (Windows keeps `Path`).
 */
export function paPathOverlay(stateDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const dir = ensurePaLauncher(stateDir);
  if (!dir) return {};
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key] ?? "";
  const parts = current.split(path.delimiter).filter((p) => p !== "" && path.resolve(p) !== path.resolve(dir));
  return { [key]: [dir, ...parts].join(path.delimiter) };
}
