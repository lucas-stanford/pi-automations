/** The worker transport seam. */

import { existsSync, openSync, closeSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { WorkerHandle } from "../src/core/contracts.js";
import { defaultSpawnFire } from "../src/tick.js";
import { fireLogPath } from "../src/paths.js";
import { launchLocalWorker } from "../src/providers/worker.js";
import { readFireLogTail } from "../src/ui/firelog.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const CHILD = path.join(import.meta.dirname, "helpers", "worker-child.js");
const ENTRY = { file: process.execPath, args: [CHILD] as const };

/** Launch the fixture worker with the given arguments. */
function launch(args: string[], over: Record<string, unknown> = {}): WorkerHandle {
  return launchLocalWorker({
    entry: ENTRY.file,
    args: [...ENTRY.args, ...args],
    detached: false,
    output: { kind: "pipe" },
    ...over,
  } as Parameters<typeof launchLocalWorker>[0]);
}

/** Every complete line a handle's stdout produced. */
async function linesOf(handle: WorkerHandle): Promise<string[]> {
  const out: string[] = [];
  if (!handle.stdout) return out;
  const rl = createInterface({ input: handle.stdout });
  rl.on("line", (l) => out.push(l));
  await handle.completion;
  await new Promise((r) => setTimeout(r, 50));
  return out;
}

const waitFor = async (predicate: () => boolean, ms = 8000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
};

describe("a detached worker: started, released, never waited for", () => {
  it("returns as soon as the worker is DURABLY started, not when it finishes", async () => {
    const dir = tempDir("pi-worker-");
    const marker = path.join(dir, "done.txt");

    const started = Date.now();
    const worker = launchLocalWorker({
      entry: ENTRY.file,
      args: [...ENTRY.args, "--sleep", "700", "--touch", marker],
      detached: true,
      output: { kind: "ignore" },
    });
    worker.release();
    const returned = Date.now() - started;

    // The launch call itself does not block on the run. A tick that waited would serialise every
    // scheduled automation behind the slowest one.
    expect(returned).toBeLessThan(600);
    expect(worker.pid).toBeGreaterThan(0);

    // Durable, though: it really was started, and it really did finish its work. Waiting for the
    // CONTENT rather than the file: `appendFileSync` creates the file and then writes it, so a
    // reader that stops at `existsSync` can catch it empty.
    expect(
      await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8").includes("done")),
    ).toBe(true);
    expect(readFileSync(marker, "utf8")).toContain("done");
  });

  it("writes to the descriptor it was handed", async () => {
    const dir = tempDir("pi-worker-");
    const logFile = path.join(dir, "out.log");
    const fd = openSync(logFile, "a");

    const worker = launchLocalWorker({
      entry: ENTRY.file,
      args: [...ENTRY.args, "--lines", "2", "--stderr", "a warning"],
      detached: true,
      output: { kind: "file", fd },
    });
    await worker.completion;
    closeSync(fd);

    const text = readFileSync(logFile, "utf8");
    // Both streams, interleaved into one file — which is why the log reader expects noise.
    expect(text).toContain('"event":"line"');
    expect(text).toContain("a warning");
  });
});

describe("a waiting worker: the caller wants the exit code", () => {
  it("reports the code the worker chose", async () => {
    const worker = launch(["--exit", "10"]);
    const c = await worker.completion;
    expect(c).toEqual({ end: "exit", exit: 10 });
  });

  it("reports zero for a clean run", async () => {
    expect(await launch(["--exit", "0"]).completion).toEqual({ end: "exit", exit: 0 });
  });

  it("separates a signal from an exit code", async () => {
    const worker = launch(["--hang"]);
    expect(await waitFor(() => worker.pid !== undefined)).toBe(true);
    process.kill(worker.pid as number, "SIGKILL");

    const c = await worker.completion;
    // On POSIX this is {end: "signal", signal: "SIGKILL"}; Windows has no signals and reports an
    // exit code instead.
    expect(c.end === "exit" || c.end === "signal").toBe(true);
    if (c.end === "exit") expect(typeof c.exit).toBe("number");
    else expect(c.signal).toBeTruthy();

    const src = readFileSync(
      path.join(import.meta.dirname, "..", "src", "providers", "worker.ts"),
      "utf8",
    );
    // The property, not the line formatting: the completion is BUILT by the named translation
    // rather than assembled inline, which is what keeps the two variants from being confused.
    expect(src).toContain("settle(completionFor(code, signal))");
    expect(src).not.toMatch(/settle\(\{\s*exit:/);
  });

  it("rejects rather than hanging when the entrypoint does not exist", async () => {
    const worker = launchLocalWorker({
      entry: path.join(tempDir("pi-worker-"), "no-such-worker"),
      args: [],
      detached: false,
      output: { kind: "ignore" },
    });
    await expect(worker.completion).rejects.toBeTruthy();
  });
});

describe("an observed worker: the caller reads events while it runs", () => {
  it("hands back the streams and the caller parses them", async () => {
    const worker = launch(["--lines", "3"]);
    const lines = await linesOf(worker);

    expect(lines).toHaveLength(3);
    // The transport never parsed anything. It does not know what NDJSON is; the caller does.
    expect(JSON.parse(lines[0] as string)).toEqual({ event: "line", i: 0 });
  });

  it("keeps stderr separate from stdout", async () => {
    const worker = launch(["--lines", "1", "--stderr", "trouble"]);
    const err: string[] = [];
    if (worker.stderr) createInterface({ input: worker.stderr }).on("line", (l) => err.push(l));
    const out = await linesOf(worker);

    expect(out.every((l) => !l.includes("trouble"))).toBe(true);
    expect(err).toContain("trouble");
  });

  it("gives the worker the environment it was handed", async () => {
    const worker = launch(["--echo-env", "PI_WORKER_TEST"], {
      env: { ...process.env, PI_WORKER_TEST: "handed-down" },
    });
    const lines = await linesOf(worker);
    expect(JSON.parse(lines[0] as string).value).toBe("handed-down");
  });
});

describe("a printing worker: read every line AND wait for the code", () => {
  it("delivers all output before the completion resolves", async () => {
    const worker = launch(["--lines", "4", "--gap", "20", "--exit", "10"]);
    const seen: string[] = [];
    if (worker.stdout) createInterface({ input: worker.stdout }).on("line", (l) => seen.push(l));

    const { exit } = await worker.completion;
    await new Promise((r) => setTimeout(r, 100));

    expect(exit).toBe(10);
    expect(seen).toHaveLength(4);
  });
});

describe("release stops observing, never the worker", () => {
  it("leaves a released worker running after its observer goes away", async () => {
    const dir = tempDir("pi-worker-");
    const marker = path.join(dir, "survived.txt");

    const worker = launch(["--sleep", "600", "--touch", marker], { detached: true });
    // Exactly what a closing viewer, a `/reload` and a dead session all do.
    worker.release();

    expect(await waitFor(() => existsSync(marker))).toBe(true);
  });

  it("keeps the worker alive when its stdout is destroyed under it", async () => {
    const dir = tempDir("pi-worker-");
    const marker = path.join(dir, "broken-stdout.txt");

    const worker = launch(["--lines", "2", "--gap", "50", "--sleep", "400", "--touch", marker]);
    // A reader that goes away mid-run: the pipe breaks, and the worker must not.
    worker.stdout?.destroy();
    worker.release();

    expect(await waitFor(() => existsSync(marker))).toBe(true);
  });

  it("drains a stream nobody is reading, so a released worker cannot block on it", async () => {
    const dir = tempDir("pi-worker-");
    const marker = path.join(dir, "not-blocked.txt");

    // Far more than a pipe holds. Without draining, the worker stops at about 64 KB and waits for a
    // reader that is never coming — it does not crash, it simply never finishes, which is the worst
    // shape a background run can take.
    const worker = launch(["--lines", "4000", "--touch", marker]);
    worker.release();

    expect(await waitFor(() => existsSync(marker), 15_000)).toBe(true);
  });

  it("makes the real worker survive the same way, by handling EPIPE itself", () => {
    // The transport can only avoid CAUSING the tear-down; it cannot stop a caller from destroying a
    // pipe, and the resulting EPIPE lands inside the worker.
    const fireJs = readFileSync(path.join(import.meta.dirname, "..", "bin", "fire.js"), "utf8");
    expect(fireJs).toMatch(/for \(const stream of \[process\.stdout, process\.stderr\]\)/);
    expect(fireJs).toMatch(/stream\.on\("error", \(\) => \{\}\)/);
  });

  it("does not signal the worker and does not start a replacement", async () => {
    const dir = tempDir("pi-worker-");
    const marker = path.join(dir, "once.txt");

    const worker = launch(["--sleep", "300", "--touch", marker], { detached: true });
    const pid = worker.pid;
    worker.release();
    worker.release();
    worker.release();

    expect(await waitFor(() => existsSync(marker))).toBe(true);
    await new Promise((r) => setTimeout(r, 400));

    // One line, from ONE process. A transport that restarted a worker it thought had gone would run
    // somebody's automation twice, and the second run would have no claim behind it.
    const lines = readFileSync(marker, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(String(pid));
  });

  it("offers no way to terminate a worker at all", () => {
    const worker = launch(["--exit", "0"]);
    // Stopping a run is the stop file the run itself checks. A transport that could
    // also kill would be a second, racing answer to the same question — and a broad one, since it
    // knows nothing about which runs are safe to interrupt.
    expect(Object.keys(worker)).not.toContain("kill");
    expect(Object.keys(worker)).not.toContain("terminate");
    expect((worker as Record<string, unknown>).kill).toBeUndefined();
  });
});

describe("the tick's spawn path, composed from the transport", () => {
  it("writes to the authoritative fire-log path, and the reader finds it there", async () => {
    const stateDir = tempDir("pi-worker-state-");
    const key = "user:demo";

    const spawnFire = defaultSpawnFire(stateDir, launchLocalWorker, ENTRY);
    spawnFire([key, "--lines", "2", "--stderr", "note from the worker"]);

    const file = fireLogPath(stateDir, key);
    expect(await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes('"i":1'))).toBe(
      true,
    );

    // The path has ONE definition, and this is the proof that the writer and the reader agree on it
    // — a fixture that rebuilt `fire-<slug(key)>.log` by hand would write somewhere the reader
    // never opens, and the resulting "no step detail yet" reads as a bug in the reader.
    const tail = readFireLogTail(stateDir, key);
    expect(tail.some((l) => l.includes('"event":"line"'))).toBe(true);
    expect(tail.some((l) => l.includes("note from the worker"))).toBe(true);
  });

  it("passes the run's arguments after the host's entry", async () => {
    const stateDir = tempDir("pi-worker-state-");
    const key = "user:args";

    defaultSpawnFire(stateDir, launchLocalWorker, ENTRY)([key, "--echo-env", "PATH"]);

    const file = fireLogPath(stateDir, key);
    expect(await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes('"env"'))).toBe(
      true,
    );
  });

  it("returns without waiting, and never throws when the log cannot be opened", () => {
    const stateDir = tempDir("pi-worker-state-");
    const spawnFire = defaultSpawnFire(stateDir, launchLocalWorker, ENTRY);

    // A directory where the log file should be: openSync fails, and the tick carries on rather than
    // taking the whole tick down over one automation's log.
    const key = "user:blocked";
    const file = fireLogPath(stateDir, key);
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(file, { recursive: true });

    expect(() => spawnFire([key])).not.toThrow();
  });
});
