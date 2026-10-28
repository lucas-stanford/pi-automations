/** Exit and signal are separate fields, proven by driving the real completion path. */

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = null;
  stderr = null;
  unrefs = 0;
  unref() {
    this.unrefs++;
  }
}

vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new FakeChild();
    spawned.push(child);
    return child;
  },
}));

const { exitCodeForCompletion, launchLocalWorker } = await import("../src/providers/worker.js");

function launch() {
  return launchLocalWorker({
    entry: "node",
    args: [],
    detached: true,
    output: { kind: "ignore" },
  });
}

beforeEach(() => {
  spawned.length = 0;
});

describe("what a worker's completion reports", () => {
  it("forwards a signal with no exit code", async () => {
    const worker = launch();
    spawned[0]?.emit("close", null, "SIGTERM");

    const completion = await worker.completion;
    expect(completion).toEqual({ end: "signal", signal: "SIGTERM" });

    // The reason the two fields exist: `exit ?? 0` reads a terminated run as a clean one.
    expect(exitCodeForCompletion(completion)).toBe(0);
    expect(completion.end).toBe("signal");
  });

  it("forwards an exit code with no signal", async () => {
    const worker = launch();
    spawned[0]?.emit("close", 20, null);

    expect(await worker.completion).toEqual({ end: "exit", exit: 20 });
  });

  it("never reports both at once", async () => {
    for (const [code, signal] of [
      [0, null],
      [20, null],
      [null, "SIGKILL"],
    ] as const) {
      const worker = launch();
      spawned[spawned.length - 1]?.emit("close", code, signal);
      const c = await worker.completion;
      expect(c.end === "exit" ? "signal" in c : "exit" in c).toBe(false);
    }
  });

  it("rejects when the child could not start, rather than reporting an exit", async () => {
    const worker = launch();
    spawned[0]?.emit("error", new Error("ENOENT"));

    await expect(worker.completion).rejects.toThrow("ENOENT");
  });

  it("releases by unrefing, and still never terminates the child", async () => {
    const worker = launch();
    worker.release();

    expect(spawned[0]?.unrefs).toBe(1);
    // A released worker is still running; its completion only settles when the child says so.
    spawned[0]?.emit("close", 0, null);
    expect(await worker.completion).toEqual({ end: "exit", exit: 0 });
  });
});
