/** A worker that started is a different fact from a worker that finished. */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { defaultSpawnFire } from "../src/tick.js";
import { fireLogPath } from "../src/paths.js";
import { launchLocalWorker } from "../src/providers/worker.js";
import { within } from "./helpers/isolated-env.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

/** A worker that exits with a chosen code after a chosen delay. */
function workerScript(dir: string, body: string): string {
  const file = path.join(dir, `w-${Math.random().toString(36).slice(2, 8)}.js`);
  writeFileSync(file, body);
  return file;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("a worker that starts", () => {
  it("acknowledges with ok and a real pid", async () => {
    const dir = tempDir("pi-startup-");
    const entry = workerScript(dir, "setTimeout(() => process.exit(0), 150);\n");

    const w = launchLocalWorker({
      entry: process.execPath,
      args: [entry],
      detached: false,
      output: { kind: "ignore" },
    });

    const started = await w.started;
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.pid).toBeGreaterThan(0);
      // The same process the handle reports, so a caller can correlate them.
      expect(started.pid).toBe(w.pid);
    }

    await w.completion;
  });

  it("acknowledges before the run finishes", async () => {
    const dir = tempDir("pi-startup-");
    // Long enough that "started" and "finished" cannot be confused for one another.
    const entry = workerScript(dir, "setTimeout(() => process.exit(0), 1500);\n");

    const w = launchLocalWorker({
      entry: process.execPath,
      args: [entry],
      detached: false,
      output: { kind: "ignore" },
    });

    const order: string[] = [];
    const ack = w.started.then(() => order.push("started"));
    const done = w.completion.then(() => order.push("completed"));

    await ack;
    // Asserted while the worker is still running: a tick that awaited completion instead would be
    // sitting here for the whole run.
    expect(order).toEqual(["started"]);

    await done;
    expect(order).toEqual(["started", "completed"]);
  });
});

describe("a worker that cannot start", () => {
  it("acknowledges ok:false with an actionable reason", async () => {
    const dir = tempDir("pi-startup-");
    const missing = path.join(dir, "no-such-entry.js");
    expect(existsSync(missing)).toBe(false);

    const w = launchLocalWorker({
      entry: missing,
      args: [],
      detached: false,
      output: { kind: "ignore" },
    });

    const started = await w.started;
    expect(started.ok).toBe(false);
    if (!started.ok) {
      // The reason has to name the cause; "it failed" leaves the caller with nothing to record.
      expect(started.reason).toBeTruthy();
      expect(started.reason).toMatch(/ENOENT|not|spawn/i);
    }

    // It did not reject: a startup failure is an outcome, not an exception.
    await expect(w.completion).rejects.toBeTruthy();
  });

  it("resolves started WITHOUT the caller having to await completion", async () => {
    const dir = tempDir("pi-startup-");
    const w = launchLocalWorker({
      entry: path.join(dir, "also-missing.js"),
      args: [],
      detached: false,
      output: { kind: "ignore" },
    });

    // The failure must be observable from `started` alone. If it were only reachable through
    // `completion`, a detached caller would have to await the run it was trying not to await.
    const started = await Promise.race([
      w.started,
      new Promise((resolve) => setTimeout(() => resolve("TIMED-OUT"), 4000)),
    ]);
    expect(started).not.toBe("TIMED-OUT");

    w.completion.catch(() => {});
  });

  it("settles started exactly once, so a caller can never hang", async () => {
    const dir = tempDir("pi-startup-");
    const entry = workerScript(dir, "process.exit(7);\n");

    const w = launchLocalWorker({
      entry: process.execPath,
      args: [entry],
      detached: false,
      output: { kind: "ignore" },
    });

    // Awaited twice: a promise settles once, and the second await must return the same answer
    // rather than waiting for a second event that will never arrive.
    const a = await w.started;
    const b = await w.started;
    expect(a).toEqual(b);

    const c = await w.completion;
    expect(c).toEqual({ end: "exit", exit: 7 });
  });
});

describe("a fire log that cannot be opened", () => {
  it("is reported, not swallowed into a silent skip", async () => {
    const stateDir = tempDir("pi-logfail-");
    const key = "user:probe:blocked";

    // A read-only file exactly where the log belongs, so `openSync(…, "a")` fails with EACCES.
    const logFile = fireLogPath(stateDir, key);
    mkdirSync(path.dirname(logFile), { recursive: true });
    writeFileSync(logFile, "");
    chmodSync(logFile, 0o444);

    const entry = workerScript(stateDir, "process.exit(0);\n");

    let launched = 0;
    const spawnFire = defaultSpawnFire(
      stateDir,
      () => {
        launched += 1;
        throw new Error("the transport must never be reached");
      },
      { file: entry, args: [] },
    );

    // A refusal value rather than a throw: the tick reads it as a confirmed failure to start, which
    // is what produces the terminal record. A throw would have been indistinguishable from the
    // transport itself falling over, which is uncertainty, not failure.
    const ack = await spawnFire([key]);
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.reason).toMatch(/cannot open the run log/);
    // And it did not quietly reach the transport either.
    expect(launched).toBe(0);
  });
});

describe("a worker script that does not exist", () => {
  it("is refused by the real pi composition before any launch", async () => {
    // Runs the shipped composition from a package copy that genuinely has no `bin/fire.js`, because
    // the host resolves its own package directory and a live package must not be broken.
    const pkg = mkdtempSync(path.join(repoRoot, "node_modules", ".pi-missing-script-probe-"));
    const stateDir = tempDir("pi-noscript-state-");
    const home = tempDir("pi-noscript-home-");
    cpSync(path.join(repoRoot, "dist"), path.join(pkg, "dist"), { recursive: true });
    expect(existsSync(path.join(pkg, "bin", "fire.js"))).toBe(false);

    let probe;
    try {
      probe = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, "test", "fixtures", "missing-script-host.mjs"),
          path.join(pkg, "dist"),
          stateDir,
          home,
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
          cwd: home,
          env: { ...process.env, HOME: home, USERPROFILE: home, PI_AGENT_DIR: path.join(home, "agent") },
        },
      );
    } finally {
      // Only this run's own copy, and only because we made it.
      rmSync(pkg, { recursive: true, force: true });
    }

    expect(probe.error ?? null, "the child did not run").toBeNull();
    expect(probe.status, probe.stderr).toBe(0);
    const out = JSON.parse(probe.stdout.trim());
    expect(out.executableExists).toBe(true);
    expect(out.scriptExists).toBe(false);
    expect(out.script).toMatch(/fire\.js$/);
    expect(out.ack.ok).toBe(false);
    expect(out.ack.reason).toMatch(/worker script does not exist/);
    expect(out.ack.reason).toMatch(/fire\.js$/);

    // What it actually resolved, not what it was told: everything under the owned home.
    expect(within(home, out.resolved.stateDir)).toBe(true);
    expect(within(home, out.resolved.host.agentDir)).toBe(true);
    expect(out.resolved.host.home).toBe(home);
  });

  it("keeps the executable and the script as different reasons", async () => {
    const stateDir = tempDir("pi-twocauses-");
    const script = workerScript(stateDir, "process.exit(0);\n");

    const noExe = defaultSpawnFire(
      stateDir,
      () => {
        throw new Error("never");
      },
      { file: path.join(stateDir, "absent-node.exe"), args: [script] },
    );
    const exeAck = await noExe(["user:probe:no-exe"]);

    expect(exeAck.ok).toBe(false);
    if (!exeAck.ok) {
      expect(exeAck.reason).toMatch(/worker executable does not exist/);
      expect(exeAck.reason).not.toMatch(/worker script/);
    }
  });

  it("launches an ordinary entry unchanged", async () => {
    const stateDir = tempDir("pi-plainentry-");
    const script = workerScript(stateDir, "process.exit(0);\n");

    let launched = 0;
    const spawnFire = defaultSpawnFire(
      stateDir,
      () => {
        launched += 1;
        return {
          started: Promise.resolve({ ok: true as const, pid: 4242 }),
          completion: Promise.resolve({ end: "exit" as const, exit: 0 }),
          release: () => {},
        };
      },
      { file: process.execPath, args: [script] },
    );

    const ack = await spawnFire(["user:probe:plain"]);
    expect(ack.ok).toBe(true);
    expect(launched).toBe(1);
  });
});

describe("a worker entrypoint that does not exist", () => {
  it("is refused by preflight, not acknowledged as started", async () => {
    const stateDir = tempDir("pi-nopreflight-");
    const missing = path.join(stateDir, "no-such-worker.js");
    expect(existsSync(missing)).toBe(false);

    let launched = 0;
    const spawnFire = defaultSpawnFire(
      stateDir,
      () => {
        launched += 1;
        throw new Error("the transport must never be reached");
      },
      { file: missing, args: [] },
    );

    const ack = await spawnFire(["user:probe:missing-entry"]);

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.reason).toMatch(/worker executable does not exist/);
    // Never launched. The `spawn` event cannot catch this: spawning `node` with a path that is not
    // there succeeds at the OS level and only then exits non-zero, so the check has to happen
    // before the launch.
    expect(launched).toBe(0);
  });

  it("is a different failure from a nonexistent EXECUTABLE", async () => {
    const dir = tempDir("pi-noexe-");
    // Here the executable itself is missing, which node reports asynchronously on `error` — the
    // acknowledgment path, not the preflight. Both end as `ok: false`; they are separate causes and
    // separate code paths, and conflating them is how one of them stops being tested.
    const w = launchLocalWorker({
      entry: path.join(dir, "not-an-executable.exe"),
      args: [],
      detached: false,
      output: { kind: "ignore" },
    });

    const ack = await w.started;
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.reason).toMatch(/ENOENT|not|spawn/i);
    w.completion.catch(() => {});
  });
});

describe("the launch call returning proves nothing", () => {
  it("returns a handle for an entry that does not exist", async () => {
    const dir = tempDir("pi-startup-");
    const w = launchLocalWorker({
      entry: path.join(dir, "definitely-not-here.js"),
      args: [],
      detached: false,
      output: { kind: "ignore" },
    });

    expect(w).toBeTruthy();
    expect(typeof w.release).toBe("function");

    // Only the acknowledgment tells the truth.
    expect((await w.started).ok).toBe(false);
    w.completion.catch(() => {});
  });
});
