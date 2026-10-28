/** The fire log and the registry. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { runLockFile } from "../src/locks.js";
import { ensureDir, statePaths } from "../src/paths.js";
import { fireLogPath } from "../src/paths.js";
import { readFireLogTail } from "../src/ui/firelog.js";
import { openProgress, progressNote, progressStep, readProgress } from "../src/progress.js";
import { RunRegistry } from "../src/ui/registry.js";
import type { Located, RunLockInfo, RunRecord } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const KEY = "user:/a/.agents/automations:flow-example";

function stateWith(lines?: string[]): string {
  const dir = tempDir("pi-reg-");
  ensureDir(statePaths(dir).logs);
  ensureDir(statePaths(dir).locks);
  if (lines) writeFileSync(fireLogPath(dir, KEY), `${lines.join("\n")}\n`, "utf8");
  return dir;
}

function writeLock(dir: string, over: Partial<RunLockInfo> = {}): RunLockInfo {
  const info: RunLockInfo = {
    pid: process.pid,
    runId: "run-1",
    key: KEY,
    startedAt: new Date().toISOString(),
    timeoutMs: 600_000,
    postHooks: 0,
    trigger: "schedule",
    ...over,
  };
  writeFileSync(runLockFile(dir, info.key), JSON.stringify(info), "utf8");
  return info;
}

function located(name = "flow-example"): Located {
  return {
    automation: {
      name,
      description: "d",
      enabled: true,
      on: { manual: true },
      hooks: { pre: [{ script: "counts.js" }], post: [] },
      body: "b",
    },
    dir: "/a/.agents/automations/flow-example",
    file: "/a/.agents/automations/flow-example/AUTOMATION.md",
    root: { path: "/a/.agents/automations", scope: "user", kind: "agents" },
    key: KEY,
  };
}

function record(id: string): RunRecord {
  return {
    id,
    key: KEY,
    name: "flow-example",
    scope: "user",
    root: "/a/.agents/automations",
    trigger: "schedule",
    late: false,
    recordedAt: new Date().toISOString(),
    outcome: "ok",
  };
}

describe("readFireLogTail", () => {
  it("returns nothing for a log that does not exist", () => {
    expect(readFireLogTail(stateWith(), KEY)).toEqual([]);
  });

  it("returns nothing for an empty log", () => {
    const dir = stateWith();
    writeFileSync(fireLogPath(dir, KEY), "", "utf8");
    expect(readFireLogTail(dir, KEY)).toEqual([]);
  });

  it("returns every line of a small log, first line included", () => {
    const dir = stateWith(["first", "second", "third"]);
    expect(readFireLogTail(dir, KEY)).toEqual(["first", "second", "third", ""]);
  });

  it("drops the partial first line when it reads a tail, and keeps the rest", () => {
    const dir = stateWith();
    const lines = Array.from({ length: 400 }, (_, i) => `line-${i}-${"x".repeat(200)}`);
    writeFileSync(fireLogPath(dir, KEY), `${lines.join("\n")}\n`, "utf8");

    const tail = readFireLogTail(dir, KEY, 4096);
    expect(tail.length).toBeGreaterThan(1);
    // Whatever survived is whole: every non-empty line still carries its full padding.
    for (const l of tail.filter(Boolean)) expect(l).toMatch(/^line-\d+-x{200}$/);
    expect(tail.at(-2)).toBe("line-399-" + "x".repeat(200));
  });

  it("creates nothing on disk when asked for a missing log", () => {
    const dir = stateWith();
    readFireLogTail(dir, KEY);
    expect(() => readFireLogTail(dir, KEY)).not.toThrow();
    expect(path.isAbsolute(fireLogPath(dir, KEY))).toBe(true);
  });
});

describe("RunRegistry — attached runs", () => {
  function reg(dir = stateWith()) {
    return { dir, r: new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date() }) };
  }

  it("shows the whole plan from the first frame", () => {
    const { r } = reg();
    const id = r.addAttached({ located: located(), trigger: "manual", timeoutMs: 1000 });
    const v = r.all()[0]?.view;
    expect(v?.phase).toBe("starting");
    expect(v?.steps.map((s) => s.id)).toEqual(["pre0", "body"]);
    expect(r.running()).toHaveLength(1);
    expect(id).toMatch(/^attached-/);
  });

  it("notifies subscribers on every change and stops after unsubscribe", () => {
    const { r } = reg();
    let n = 0;
    const off = r.subscribe(() => n++);
    const id = r.addAttached({ located: located(), trigger: "manual", timeoutMs: 1000 });
    r.applyEvent(id, { event: "body-start", model: "m", cwd: "/a" });
    expect(n).toBe(2);
    off();
    r.applyEvent(id, { event: "body-end", chars: 1 });
    expect(n).toBe(2);
  });

  it("survives a listener that throws, and still notifies the others", () => {
    const { r } = reg();
    let good = 0;
    r.subscribe(() => {
      throw new Error("stale context");
    });
    r.subscribe(() => good++);
    r.addAttached({ located: located(), trigger: "manual", timeoutMs: 1000 });
    expect(good).toBe(1);
  });

  it("ignores events for an id it does not know", () => {
    const { r } = reg();
    expect(() => r.applyEvent("nope", { event: "body-end", chars: 1 })).not.toThrow();
    expect(r.size).toBe(0);
  });

  it("keeps a finished run until it is dismissed", () => {
    const { r } = reg();
    const id = r.addAttached({ located: located(), trigger: "manual", timeoutMs: 1000 });
    r.applyEvent(id, { event: "record", record: record("run-1") });
    expect(r.running()).toHaveLength(0);
    expect(r.finished()).toHaveLength(1);
    expect(r.dismiss(id)).toBe(true);
    expect(r.size).toBe(0);
  });

  it("refuses to dismiss a run that is still going", () => {
    const { r } = reg();
    const id = r.addAttached({ located: located(), trigger: "manual", timeoutMs: 1000 });
    expect(r.dismiss(id)).toBe(false);
    expect(r.size).toBe(1);
  });

  it("records a crash with its exit code and stderr", () => {
    const { r } = reg();
    const id = r.addAttached({ located: located(), trigger: "manual", timeoutMs: 1000 });
    r.crash(id, 20, ["Error: no credentials"]);
    const v = r.all()[0]?.view;
    expect(v?.phase).toBe("crashed");
    expect(v?.exitCode).toBe(20);
    expect(v?.stderrTail).toEqual(["Error: no credentials"]);
  });

  it("sorts running runs before finished ones", () => {
    const { r } = reg();
    const done = r.addAttached({ located: located("a"), trigger: "manual", timeoutMs: 1000 });
    r.applyEvent(done, { event: "record", record: record("run-a") });
    r.addAttached({ located: located("b"), trigger: "manual", timeoutMs: 1000 });
    expect(r.all().map((e) => e.view.name)).toEqual(["b", "a"]);
  });
});

describe("RunRegistry — observed runs", () => {
  function reg(dir: string) {
    return new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date() });
  }

  it("finds a live lock and reads its step detail from the fire log", () => {
    const dir = stateWith([
      JSON.stringify({ event: "start", runId: "run-1", key: KEY, trigger: "schedule", late: false }),
      "some stderr",
      JSON.stringify({ event: "hook-start", phase: "pre", index: 0, source: "counts.js" }),
    ]);
    writeLock(dir);
    const r = reg(dir);
    r.refreshObserved([KEY]);

    const v = r.all()[0]?.view;
    expect(v?.source).toBe("observed");
    expect(v?.pid).toBe(process.pid);
    expect(v?.steps.find((s) => s.id === "pre0")?.state).toBe("active");
  });

  it("keeps a provider fault reported after the run's own record", () => {
    // The replay has already seen `record`, so it is finished and is not used as the row.
    const record = { id: "run-1", key: KEY, name: "flow-example", trigger: "schedule", outcome: "ok", recordedAt: new Date().toISOString() };
    const dir = stateWith([
      JSON.stringify({ event: "start", runId: "run-1", key: KEY, trigger: "schedule", late: false }),
      JSON.stringify({ event: "record", record }),
      JSON.stringify({ event: "problem", message: "workspace cleanup failed: EBUSY" }),
    ]);
    writeLock(dir);
    const r = reg(dir);
    r.refreshObserved([KEY]);

    const v = r.all()[0]?.view;
    // Retention is unchanged: still the observed row, still one entry.
    expect(v?.source).toBe("observed");
    expect(v?.problems).toEqual(["workspace cleanup failed: EBUSY"]);
  });

  it("adds no problems to a run that reported none", () => {
    const dir = stateWith([
      JSON.stringify({ event: "start", runId: "run-1", key: KEY, trigger: "schedule", late: false }),
      JSON.stringify({ event: "record", record: { id: "run-1", key: KEY, name: "flow-example", trigger: "schedule", outcome: "ok", recordedAt: new Date().toISOString() } }),
    ]);
    writeLock(dir);
    const r = reg(dir);
    r.refreshObserved([KEY]);

    expect(r.all()[0]?.view.problems ?? []).toEqual([]);
  });

  it("shows the lock with no steps when the log has nothing for that run", () => {
    const dir = stateWith(["unrelated noise"]);
    writeLock(dir, { runId: "run-9" });
    const r = reg(dir);
    r.refreshObserved([KEY]);
    expect(r.all()[0]?.view.steps).toEqual([]);
  });

  it("ignores a lock whose process is dead, rather than showing a zombie for ever", () => {
    const dir = stateWith();
    // pid 0 is never a live process, and isAlive rejects it outright.
    writeLock(dir, { pid: 0 });
    const r = reg(dir);
    r.refreshObserved([KEY]);
    expect(r.size).toBe(0);
  });

  it("ignores a lock that has outlived any legitimate run", () => {
    const dir = stateWith();
    writeLock(dir, { startedAt: new Date(Date.now() - 86_400_000).toISOString(), timeoutMs: 1000 });
    const r = reg(dir);
    r.refreshObserved([KEY]);
    expect(r.size).toBe(0);
  });

  it("drops an observed run once its lock is gone", () => {
    const dir = stateWith();
    writeLock(dir);
    const r = reg(dir);
    r.refreshObserved([KEY]);
    expect(r.size).toBe(1);

    mkdirSync(path.dirname(runLockFile(dir, KEY)), { recursive: true });
    writeFileSync(runLockFile(dir, KEY), "", "utf8");
    // An unreadable lock is not a live run.
    r.refreshObserved([KEY]);
    expect(r.size).toBe(0);
  });

  it("does not duplicate a run this process is already attached to", () => {
    const dir = stateWith();
    writeLock(dir);
    const r = reg(dir);
    r.addAttached({ located: located(), trigger: "manual", timeoutMs: 1000 });
    r.refreshObserved([KEY]);
    expect(r.size).toBe(1);
    expect(r.all()[0]?.view.source).toBe("attached");
  });

  it("only notifies when something actually changed", () => {
    const dir = stateWith();
    writeLock(dir);
    const r = reg(dir);
    let n = 0;
    r.subscribe(() => n++);
    r.refreshObserved([KEY]);
    expect(n).toBe(1);
    r.refreshObserved([KEY]);
    expect(n).toBe(1);
  });

  it("clear() drops everything and notifies once", () => {
    const dir = stateWith();
    writeLock(dir);
    const r = reg(dir);
    r.refreshObserved([KEY]);
    let n = 0;
    r.subscribe(() => n++);
    r.clear();
    expect(r.size).toBe(0);
    expect(n).toBe(1);
    r.clear();
    expect(n).toBe(1);
  });
});

describe("RunRegistry — a tracked run's progress", () => {
  it("merges the store's nodes and notes into a running run, and leaves an untracked one alone", () => {
    const dir = stateWith();
    const runId = "20260917-140000-reg1";
    openProgress(dir, { runId, key: "user:/r:flow-example", name: "flow-example", chart: 'flowchart TD\n  body["Write it"] --> review["Review"]\n' });
    progressStep(dir, runId, { node: "review", text: "3 threads" });
    progressNote(dir, runId, { text: "Posted", links: ["pr=https://x.test/pr/1"] });

    const r = new RunRegistry({
      stateDir: dir,
      config: DEFAULTS,
      now: () => new Date(),
      progress: (flow) => readProgress(dir, flow.run),
    });
    const tracked = r.addAttached({ located: located(), trigger: "manual", timeoutMs: 60_000 });
    const plain = r.addAttached({ located: located("plain"), trigger: "manual", timeoutMs: 60_000 });
    r.applyEvent(tracked, { event: "flow", run: runId });
    r.refreshFlow();

    const view = r.all().find((e) => e.id === tracked)?.view;
    expect(view?.steps.find((s) => s.id === "review")).toMatchObject({ label: "Review", state: "active", note: "3 threads", extra: true });
    expect(view?.steps.find((s) => s.id === "body")?.label).toBe("Write it");
    expect(view?.notes).toEqual([{ ts: expect.any(String), text: "Posted", links: [{ label: "pr", url: "https://x.test/pr/1" }] }]);
    expect(r.all().find((e) => e.id === plain)?.view.notes).toBeUndefined();
  });

  it("shows a note from a run that has no chart, while it is still going", () => {
    const dir = stateWith();
    const runId = "20260917-140000-reg2";
    openProgress(dir, { runId, key: "user:/r:plain", name: "plain", chart: "" });
    progressNote(dir, runId, { text: "Sent the summary", links: ["https://x.test/m/1"] });
    const r = new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date(), progress: (flow) => readProgress(dir, flow.run) });
    const id = r.addAttached({ located: located("plain"), trigger: "manual", timeoutMs: 60_000 });
    r.applyEvent(id, { event: "start", runId, key: "user:/r:plain", trigger: "manual", late: false });
    r.refreshFlow();
    const view = r.all().find((e) => e.id === id)?.view;
    expect(view?.flow).toBeUndefined();
    expect(view?.notes?.[0]?.text).toBe("Sent the summary");
  });
});