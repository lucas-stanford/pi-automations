import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { handleStop } from "../src/commands.js";
import { acquireRunLock, cancelFile, cancelRequested, readRunLock, runLockInfo } from "../src/locks.js";
import { readRecords } from "../src/records.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

// The UI's name and key are NOT interchangeable (including the drive colon on Windows).
const key = "user:D:\\Users\\tester\\.agents\\automations:my-team-review";
const target = { key, name: "my-team-review", runId: "run-1" };

function fixture(pid = process.pid, runId = target.runId) {
  const stateDir = tempDir("pi-stop-");
  const lock = acquireRunLock(stateDir, runLockInfo({
    key, runId, pid, now: new Date(), timeoutMs: 600_000, postHooks: 1, trigger: "manual",
  }));
  return { stateDir, lock };
}

describe("handleStop", () => {
  it("targets the selected run by full key and requests cancellation, not completion", () => {
    const deps = fixture();
    const result = handleStop(deps, target);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("stop requested");
    expect(cancelRequested(deps.stateDir, key, target.runId)).toBe(true);
    expect(readRunLock(deps.stateDir, key)?.runId).toBe(target.runId);
    expect(readRecords(deps.stateDir, key)).toEqual([]);
  });

  it("does not stop a same-named automation from another root", () => {
    const deps = fixture();
    const otherKey = "repository:C:\\repo\\.agents\\automations:my-team-review";
    acquireRunLock(deps.stateDir, runLockInfo({
      key: otherKey, runId: target.runId, now: new Date(), timeoutMs: 600_000,
      postHooks: 0, trigger: "manual",
    }));
    handleStop(deps, target);
    expect(cancelRequested(deps.stateDir, key, target.runId)).toBe(true);
    expect(existsSync(cancelFile(deps.stateDir, otherKey))).toBe(false);
  });

  it("does not claim to stop a process that has already died", () => {
    const deps = fixture(0);
    expect(handleStop(deps, target).lines.join("\n")).toContain("not running");
    expect(existsSync(cancelFile(deps.stateDir, key))).toBe(false);
    expect(readRunLock(deps.stateDir, key)).toBeDefined();
  });

  it("does not recreate a cancellation file for a released lock", () => {
    const deps = fixture();
    if (deps.lock.ok) deps.lock.release();
    expect(handleStop(deps, target).lines.join("\n")).toContain("not running");
    expect(existsSync(cancelFile(deps.stateDir, key))).toBe(false);
  });

  it("does not stop a replacement run when the selected row was stale", () => {
    const deps = fixture(process.pid, "run-2");
    expect(handleStop(deps, target).exitCode).toBe(2);
    expect(existsSync(cancelFile(deps.stateDir, key))).toBe(false);
  });

  it("does not overwrite a replacement run's existing stop request", () => {
    const deps = fixture(process.pid, "run-2");
    handleStop(deps, { ...target, runId: "run-2" });
    const before = readFileSync(cancelFile(deps.stateDir, key), "utf8");
    handleStop(deps, target);
    expect(readFileSync(cancelFile(deps.stateDir, key), "utf8")).toBe(before);
  });

  it("does not guess a run id while the selected run is still starting", () => {
    const deps = fixture();
    expect(handleStop(deps, { key, name: target.name }).exitCode).toBe(2);
    expect(existsSync(cancelFile(deps.stateDir, key))).toBe(false);
  });

  it("reports a failed request instead of always saying stopping", () => {
    const deps = fixture();
    mkdirSync(cancelFile(deps.stateDir, key));
    const result = handleStop(deps, target);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join("\n")).toContain("could not write");
    expect(result.lines.join("\n")).not.toContain("stop requested");
  });
});
