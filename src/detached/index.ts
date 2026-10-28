// The watcher: the OS job runs `bin/tick.js` every minute. `install` waits for a real tick.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { writeJsonAtomic, readJson } from "../jsonfile.js";
import { ensureDir, packageDir, statePaths, stateDir } from "../paths.js";
import { readPausedWatches, readWatchStates } from "../state.js";
import type { DetachedFile } from "../types.js";
import { linuxBackend } from "./linux.js";
import { macosBackend } from "./macos.js";
import type { Command, PlatformBackend } from "./types.js";
import { windowsBackend } from "./windows.js";

export { snapshotEnv, SECRET_NAME } from "./env.js";
export { taskXml, tickVbs } from "./windows.js";
export { plist } from "./macos.js";
export { serviceUnit, timerUnit, crontabLine } from "./linux.js";
export { serve } from "./serve.js";
export type { JobPaths, PlatformBackend } from "./types.js";

export function backendFor(platform: NodeJS.Platform = process.platform): PlatformBackend | undefined {
  if (platform === "win32") return windowsBackend;
  if (platform === "darwin") return macosBackend;
  if (platform === "linux") return linuxBackend;
  return undefined;
}

function detachedFile(dir: string): string {
  return statePaths(dir).detached;
}

export function installed(dir: string = stateDir()): boolean {
  return existsSync(detachedFile(dir));
}

/** What the installed job was registered against, or undefined when there is none. */
export function installedPaths(dir: string = stateDir()): DetachedFile | undefined {
  return readJson<DetachedFile>(detachedFile(dir));
}

function run(cmd: Command): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? err?.message ?? ""),
      });
    });
  });
}

export interface InstallResult {
  ok: boolean;
  lines: string[];
  method?: DetachedFile["method"];
}

export async function install(options: {
  dir?: string;
  platform?: NodeJS.Platform;
  now?: Date;
  /** Injected in tests so nothing is registered and nothing is waited for. */
  exec?: (cmd: Command) => Promise<{ code: number; stdout: string; stderr: string }>;
  verifySeconds?: number;
  /** Which scheduler registers the job; omitted uses this platform's. */
  backend?: PlatformBackend;
}): Promise<InstallResult> {
  const dir = options.dir ?? stateDir();
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? run;
  const now = options.now ?? new Date();

  const backend = options.backend ?? backendFor(platform);
  if (!backend) {
    return {
      ok: false,
      lines: [
        `the watcher is not available on ${platform} — use pa serve instead`,
      ],
    };
  }

  const nodePath = process.execPath;
  const pkg = packageDir();
  const paths = backend.defaultPaths(dir, nodePath, pkg);

  if (!existsSync(nodePath)) return { ok: false, lines: [`node was not found at ${nodePath}`] };
  if (!existsSync(paths.tickPath)) {
    return { ok: false, lines: [`tick.js was not found at ${paths.tickPath}`] };
  }

  const lines: string[] = [];

  if (paths.env.refused.length > 0) {
    lines.push(
      `not carried into the job file: ${paths.env.refused.join(", ")} — credentials never are`,
    );
  }

  for (const f of backend.files(paths)) ensureDir(path.dirname(f.path));
  ensureDir(statePaths(dir).logs);
  backend.write(paths);

  const registered = await exec(backend.installCommand(paths));
  if (registered.code !== 0) {
    return {
      ok: false,
      lines: [
        ...lines,
        `could not register the job — ${firstLine(registered.stderr || registered.stdout)}`,
      ],
    };
  }

  const record: DetachedFile = {
    platform,
    jobName: backend.jobName,
    nodePath,
    packageDir: pkg,
    tickPath: paths.tickPath,
    installedAt: now.toISOString(),
    method: backend.method,
    ...(paths.shimPath ? { shimPath: paths.shimPath } : {}),
  };
  writeJsonAtomic(detachedFile(dir), record);

  lines.push(`watcher: on (${backend.method}) · ${backend.jobName}`);

  // Registering is not evidence. Trigger one real tick and wait for state.json to move.
  const verifySeconds = options.verifySeconds ?? 90;
  if (verifySeconds > 0) {
    const before = lastTickAt(dir);
    await exec(backend.testCommand(paths));
    const moved = await waitForTick(dir, before, verifySeconds * 1000);
    lines.push(
      moved
        ? "first tick ok"
        : `first tick did not arrive within ${verifySeconds}s — check ${path.join(statePaths(dir).logs, "tick.log")} and pa watcher status`,
    );
    if (!moved) return { ok: false, lines, method: backend.method };
  }

  return { ok: true, lines, method: backend.method };
}

function lastTickAt(dir: string): string | undefined {
  return readJson<{ lastTickAt?: string }>(statePaths(dir).state)?.lastTickAt;
}

async function waitForTick(dir: string, before: string | undefined, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = lastTickAt(dir);
    if (now && now !== before) return true;
  }
  return false;
}

export async function uninstall(options: {
  dir?: string;
  platform?: NodeJS.Platform;
  purge?: boolean;
  exec?: (cmd: Command) => Promise<{ code: number; stdout: string; stderr: string }>;
  // Omitted uses this platform's scheduler.
  backend?: PlatformBackend;
}): Promise<InstallResult> {
  const dir = options.dir ?? stateDir();
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? run;
  const backend = options.backend ?? backendFor(platform);
  const lines: string[] = [];

  if (backend) {
    const paths = backend.defaultPaths(dir, process.execPath, packageDir());
    const removed = await exec(backend.uninstallCommand(paths));
    lines.push(
      removed.code === 0
        ? `job removed (${backend.method})`
        : `job may already be gone — ${firstLine(removed.stderr || removed.stdout)}`,
    );

    for (const f of backend.files(paths)) {
      try {
        rmSync(f.path, { force: true });
      } catch {
        /* nothing useful to do */
      }
    }
  }

  try {
    rmSync(detachedFile(dir), { force: true });
  } catch {
    /* nothing useful to do */
  }

  if (options.purge) {
    // Purge removes this package's state only, never automations.
    lines.push(`removing ${dir}`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      lines.push(`could not remove ${dir} — ${(e as Error).message}`);
    }
    lines.push("~/.agents/automations and every repository were left untouched");
  }

  return { ok: true, lines };
}

export interface DetachedStatus {
  installed: boolean;
  lines: string[];
  stale: boolean;
}

export async function status(options: {
  dir?: string;
  platform?: NodeJS.Platform;
  now?: Date;
  exec?: (cmd: Command) => Promise<{ code: number; stdout: string; stderr: string }>;
  // Omitted uses this platform's scheduler.
  backend?: PlatformBackend;
}): Promise<DetachedStatus> {
  const dir = options.dir ?? stateDir();
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? run;
  const now = options.now ?? new Date();

  const record = installedPaths(dir);
  if (!record) {
    return {
      installed: false,
      stale: false,
      lines: [
        // Nothing ticks without the job: no schedule fires and no watch is checked.
        "watcher: off — no schedule fires and no watch is checked on its own",
        "  start it with: pa watcher start",
        "  or keep this running in a terminal: pa serve",
      ],
    };
  }

  const lines = [`watcher: on (${record.method}) · ${record.jobName}`];
  let stale = false;

  // A moved package or replaced node leaves a job that fails every minute.
  if (record.nodePath !== process.execPath) {
    stale = true;
    lines.push(`  stale: registered for node ${record.nodePath}, now running ${process.execPath}`);
  }
  if (record.packageDir !== packageDir()) {
    stale = true;
    lines.push(`  stale: registered for ${record.packageDir}, now at ${packageDir()}`);
  }
  if (!existsSync(record.tickPath)) {
    stale = true;
    lines.push(`  stale: ${record.tickPath} is missing`);
  }
  if (stale) lines.push("  restart it: pa watcher start");

  const last = lastTickAt(dir);
  if (last) {
    const ageMs = now.getTime() - Date.parse(last);
    lines.push(`  last tick: ${last} (${Math.round(ageMs / 1000)}s ago)`);
    if (ageMs > 10 * 60_000) {
      lines.push("  the last tick is over ten minutes old — the job may not be running");
    }
  } else {
    lines.push("  last tick: never");
  }

  // The watches this job runs, by when each last looked.
  const paused = readPausedWatches(dir);
  const watches = Object.entries(readWatchStates(dir))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, w]) => {
      const ago = Math.max(0, Math.round((now.getTime() - Date.parse(w.checkedAt)) / 1000));
      const result = w.problem ? "could not check" : `exit ${w.exit}`;
      return `${key.slice(key.lastIndexOf(":") + 1)} ${ago}s ago (${result}${paused[key] ? ", paused" : ""})`;
    });
  if (watches.length > 0) lines.push(`  watches: ${watches.join(" · ")}`);

  const backend = options.backend ?? backendFor(platform);
  if (backend) {
    const paths = backend.defaultPaths(dir, record.nodePath, record.packageDir);
    const q = await exec(backend.queryCommand(paths));
    lines.push(
      q.code === 0
        ? "  job: present"
        : `  job: NOT found by the scheduler — ${firstLine(q.stderr || q.stdout)}`,
    );

    if (platform === "linux") {
      lines.push(
        "  note: on a server without a login session, enable lingering: loginctl enable-linger $USER",
      );
    }
  }

  const log = path.join(statePaths(dir).logs, "tick.log");
  if (existsSync(log)) {
    const tail = readFileSync(log, "utf8").split("\n").filter(Boolean).slice(-3);
    for (const line of tail) lines.push(`  log: ${line}`);
  }

  return { installed: true, stale, lines };
}

/** Should the tick remove its own job? Returns the reason, or undefined when the job is valid. */
export function selfUnregisterReason(
  record: DetachedFile | undefined,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (!record) return undefined;
  if (!exists(record.packageDir)) {
    return `package is gone (${record.packageDir}) — removing the scheduled job`;
  }
  if (!exists(record.tickPath)) {
    return `tick.js is gone (${record.tickPath}) — removing the scheduled job`;
  }
  if (!exists(record.nodePath)) {
    return `node is gone (${record.nodePath}) — removing the scheduled job`;
  }
  return undefined;
}

/** Remove a job whose package is gone (after `pi remove`). Called by `bin/tick.js`. */
export async function selfUnregister(
  reason: string,
  options: {
    dir?: string;
    exec?: (cmd: Command) => Promise<{ code: number; stdout: string; stderr: string }>;
    log?: (line: string) => void;
  } = {},
): Promise<boolean> {
  const dir = options.dir ?? stateDir();
  const exec = options.exec ?? run;
  const record = installedPaths(dir);
  if (!record) return false;

  const backend = backendFor(record.platform);
  if (backend) {
    const paths = backend.defaultPaths(dir, record.nodePath, record.packageDir);
    await exec(backend.uninstallCommand(paths));
    for (const f of backend.files(paths)) {
      try {
        rmSync(f.path, { force: true });
      } catch {
        /* nothing useful to do */
      }
    }
  }

  try {
    rmSync(detachedFile(dir), { force: true });
  } catch {
    /* nothing useful to do */
  }

  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  log(`${new Date().toISOString()} detached job removed: ${reason}`);
  return true;
}

function firstLine(s: string): string {
  return (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "no output";
}

/** `pa watcher <verb>` (and its old name, `pa detached <verb>`). */
export async function detachedCli(
  argv: string[],
  options: {
    stateDir: string;
    json?: boolean;
    /** The scheduler this host composed; omitted uses this platform's. */
    backend?: PlatformBackend;
  },
): Promise<{ lines: string[]; exitCode: number }> {
  const verb = argv[0] ?? "status";
  const dir = options.stateDir;
  const chosen = options.backend ? { backend: options.backend } : {};

  if (verb === "install" || verb === "start") {
    const r = await install({ dir, ...chosen });
    return { lines: r.lines, exitCode: r.ok ? 0 : 2 };
  }
  if (verb === "uninstall" || verb === "remove" || verb === "stop") {
    const r = await uninstall({ dir, purge: argv.includes("--purge"), ...chosen });
    return { lines: r.lines, exitCode: 0 };
  }
  if (verb === "status") {
    const r = await status({ dir, ...chosen });
    if (options.json) {
      return { lines: [JSON.stringify(r)], exitCode: 0 };
    }
    return { lines: r.lines, exitCode: 0 };
  }

  return {
    lines: [`unknown verb ${JSON.stringify(verb)} — start, stop [--purge], status`],
    exitCode: 1,
  };
}
