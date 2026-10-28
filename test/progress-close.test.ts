/** Closing a run's progress when its file cannot be removed. */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const FAIL = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rmSync: typeof actual.rmSync = (p, o) => {
    if (FAIL.on && String(p).endsWith(".jsonl")) {
      throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${String(p)}'`), { code: "EPERM" });
    }
    return actual.rmSync(p, o);
  };
  return { ...actual, rmSync, default: { ...actual, rmSync } };
});

import {
  closeProgress,
  openProgress,
  progressFile,
  progressNote,
  progressSay,
  progressStep,
  ProgressError,
  readProgress,
  sweepTombstones,
} from "../src/progress.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);
afterEach(() => {
  FAIL.on = false;
});

describe("a progress file Windows will not let go of", () => {
  it("still hands back the fold, marks the run closed, and is swept later", () => {
    const dir = tempDir("pa-close-");
    const run = "20260917-140000-e1e1";
    openProgress(dir, { runId: run, key: "user:/r:x", name: "x", chart: "flowchart TD\n  a --> b\n" });
    progressStep(dir, run, { node: "a", status: "done", text: "did a" });
    progressNote(dir, run, { text: "Posted", links: ["pr=https://x.test/pr/1"] });

    FAIL.on = true;
    const folded = closeProgress(dir, run, "ok");
    expect(folded?.steps.find((s) => s.id === "a")).toMatchObject({ status: "done", text: "did a" });
    expect(folded?.notes[0]?.links).toEqual([{ label: "pr", url: "https://x.test/pr/1" }]);

    // Still there, but closed: a straggler is refused, and closing again gives the same answer.
    expect(existsSync(progressFile(dir, run))).toBe(true);
    expect(readProgress(dir, run)?.closed).toBe(true);
    let refused: unknown;
    try {
      progressSay(dir, run, { text: "late", node: "b" });
    } catch (e) {
      refused = e;
    }
    expect((refused as ProgressError).code).toBe("RUN_CLOSED");
    expect(closeProgress(dir, run, "ok")?.notes).toHaveLength(1);

    // Once nothing holds it, the sweep removes it and keeps the tombstone.
    FAIL.on = false;
    sweepTombstones(dir);
    expect(readdirSync(path.join(dir, "progress"))).toEqual([`${run}.closed`]);
  });
});
