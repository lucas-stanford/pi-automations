// The two files that let one process ask another to stop, and let a running process say where its
// session is.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  acquireRunLock,
  cancelFile,
  cancelRequested,
  clearCancel,
  readRunLock,
  requestCancel,
  runLockFile,
  updateRunLock,
} from "../src/locks.js";
import type { RunLockInfo } from "../src/types.js";
import { tempDir } from "./helpers/temp.js";

const KEY = "user:/r:daily-briefing";

function stateDir(): string {
  return tempDir("pa-locks-");
}

function info(over: Partial<RunLockInfo> = {}): RunLockInfo {
  return {
    pid: process.pid,
    runId: "20260917-000000-aaaa",
    key: KEY,
    startedAt: new Date().toISOString(),
    timeoutMs: 60_000,
    postHooks: 0,
    trigger: "manual",
    ...over,
  };
}

describe("updateRunLock", () => {
  it("adds to the lock the run already holds", () => {
    const dir = stateDir();
    acquireRunLock(dir, info());
    expect(updateRunLock(dir, KEY, { session: { file: "/s.jsonl", id: "s1" } })).toBe(true);
    expect(readRunLock(dir, KEY)?.session).toEqual({ file: "/s.jsonl", id: "s1" });
  });

  it("keeps everything it was not asked to change", () => {
    const dir = stateDir();
    const original = info({ postHooks: 3, scheduledFor: "2026-09-17T07:00:00.000Z" });
    acquireRunLock(dir, original);
    updateRunLock(dir, KEY, { session: { file: "/s.jsonl", id: "s1" } });

    const after = readRunLock(dir, KEY);
    expect(after?.pid).toBe(original.pid);
    expect(after?.runId).toBe(original.runId);
    expect(after?.postHooks).toBe(3);
    expect(after?.scheduledFor).toBe("2026-09-17T07:00:00.000Z");
  });

  it("refuses to change the identity the lock is about", () => {
    // pid is what staleness is judged by, and key is what the file is named for. An update that
    // could rewrite either would let a run adopt someone else's lock.
    const dir = stateDir();
    acquireRunLock(dir, info());
    updateRunLock(dir, KEY, { pid: 999_999, key: "user:/r:something-else" } as Partial<RunLockInfo>);

    const after = readRunLock(dir, KEY);
    expect(after?.pid).toBe(process.pid);
    expect(after?.key).toBe(KEY);
  });

  it("does NOT recreate a lock that has been released", () => {
    // The run is over and its lock is gone. Writing one now would show a finished run as still
    // going, for ever — nothing would ever release it.
    const dir = stateDir();
    const lock = acquireRunLock(dir, info());
    if (lock.ok) lock.release();
    expect(existsSync(runLockFile(dir, KEY))).toBe(false);

    expect(updateRunLock(dir, KEY, { session: { file: "/s.jsonl", id: "s1" } })).toBe(false);
    expect(existsSync(runLockFile(dir, KEY))).toBe(false);
  });

  it("does not recreate a lock that never existed", () => {
    const dir = stateDir();
    expect(updateRunLock(dir, KEY, { session: { file: "/s.jsonl", id: "s1" } })).toBe(false);
    expect(readRunLock(dir, KEY)).toBeUndefined();
  });

  it("leaves no temporary file behind", () => {
    const dir = stateDir();
    acquireRunLock(dir, info());
    updateRunLock(dir, KEY, { session: { file: "/s.jsonl", id: "s1" } });
    const leftovers = readFileSync(runLockFile(dir, KEY), "utf8");
    expect(leftovers.startsWith("{")).toBe(true);
    expect(existsSync(`${runLockFile(dir, KEY)}.${process.pid}.tmp`)).toBe(false);
  });

  it("never throws on an unreadable lock", () => {
    const dir = stateDir();
    acquireRunLock(dir, info());
    writeFileSync(runLockFile(dir, KEY), "not json at all");
    expect(() => updateRunLock(dir, KEY, { session: { file: "/s", id: "1" } })).not.toThrow();
  });
});

describe("requestCancel / cancelRequested", () => {
  it("is seen by the run it names", () => {
    const dir = stateDir();
    expect(requestCancel(dir, KEY, "run-1")).toBe(true);
    expect(cancelRequested(dir, KEY, "run-1")).toBe(true);
  });

  it("is absent until asked for", () => {
    expect(cancelRequested(stateDir(), KEY, "run-1")).toBe(false);
  });

  it("does NOT stop a different run of the same automation", () => {
    // The dangerous case: a stop requested a moment too late lands while the NEXT run is going.
    // Nothing about the file's name distinguishes them — only the run id inside it does.
    const dir = stateDir();
    requestCancel(dir, KEY, "run-1");
    expect(cancelRequested(dir, KEY, "run-2")).toBe(false);
  });

  it("clears a request aimed at a run that is already over", () => {
    // Otherwise it sits there waiting to stop whichever run happens to come next.
    const dir = stateDir();
    requestCancel(dir, KEY, "run-1");
    expect(cancelRequested(dir, KEY, "run-2")).toBe(false);
    expect(existsSync(cancelFile(dir, KEY))).toBe(false);
    // And now even the run it named cannot be stopped by it, because it is gone.
    expect(cancelRequested(dir, KEY, "run-1")).toBe(false);
  });

  it("is scoped to one automation", () => {
    const dir = stateDir();
    requestCancel(dir, KEY, "run-1");
    expect(cancelRequested(dir, "user:/r:something-else", "run-1")).toBe(false);
  });

  it("survives a corrupt request rather than throwing", () => {
    const dir = stateDir();
    requestCancel(dir, KEY, "run-1");
    writeFileSync(cancelFile(dir, KEY), "{ not json");
    expect(() => cancelRequested(dir, KEY, "run-1")).not.toThrow();
    expect(cancelRequested(dir, KEY, "run-1")).toBe(false);
  });

  it("is cleared on the way out, whatever happened", () => {
    const dir = stateDir();
    requestCancel(dir, KEY, "run-1");
    clearCancel(dir, KEY);
    expect(existsSync(cancelFile(dir, KEY))).toBe(false);
    // Clearing something that is not there is not an error.
    expect(() => clearCancel(dir, KEY)).not.toThrow();
  });
});
