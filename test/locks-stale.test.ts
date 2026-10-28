/** The short-lived file lock behind every progress write, when its holder is gone. */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { withFileLock } from "../src/locks.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

describe("an abandoned lock", () => {
  it("is broken when its owner is dead", () => {
    const dir = tempDir("pa-lock-");
    const lock = path.join(dir, "x.lock");
    writeFileSync(lock, JSON.stringify({ pid: 0, at: new Date().toISOString(), token: "gone" }));
    expect(withFileLock(lock, () => "in", { timeoutMs: 2000 })).toBe("in");
    expect(existsSync(lock)).toBe(false);
  });

  it("is broken when it was left empty, once it is older than a live writer could leave it", () => {
    const dir = tempDir("pa-lock-");
    const lock = path.join(dir, "x.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(withFileLock(lock, () => "in", { timeoutMs: 2000 })).toBe("in");
  });

  it("waits for a fresh empty lock to age rather than failing for ever", () => {
    const dir = tempDir("pa-lock-");
    const lock = path.join(dir, "x.lock");
    writeFileSync(lock, "");
    const t = Date.now();
    expect(withFileLock(lock, () => "in", { timeoutMs: 8000 })).toBe("in");
    expect(Date.now() - t).toBeGreaterThanOrEqual(1500);
  });

  it("leaves a live lock alone, and times out rather than breaking it", () => {
    const dir = tempDir("pa-lock-");
    const lock = path.join(dir, "x.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "mine" }));
    expect(() => withFileLock(lock, () => "in", { timeoutMs: 300 })).toThrow(/could not lock/);
    expect(existsSync(lock)).toBe(true);
  });

  it("never lets two processes in at once, while they race to break locks left by the dead", async () => {
    const dir = tempDir("pa-lock-race-");
    const hammer = path.join(import.meta.dirname, "helpers", "lock-hammer.mjs");
    setTimeout(() => writeFileSync(path.join(dir, "go"), ""), 1500);

    const outs = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<{ entered: number; overlaps: number }>((resolve, reject) => {
            const child = spawn(process.execPath, [hammer, dir, "60", "1"], {
              windowsHide: true,
              stdio: ["ignore", "pipe", "inherit"],
            });
            let out = "";
            child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
            child.on("error", reject);
            child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
          }),
      ),
    );

    expect(outs.reduce((a, o) => a + o.entered, 0)).toBe(480);
    expect(outs.reduce((a, o) => a + o.overlaps, 0)).toBe(0);
    // Nothing was left behind but the last dead owner's lock, if the last entry "died".
    expect(readdirSync(dir).filter((f) => f.endsWith(".break") || f === "inside")).toEqual([]);
  }, 90_000);
});
