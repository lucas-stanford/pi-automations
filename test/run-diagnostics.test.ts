/** Provider diagnostics remain visible in live and reopened views without changing run outcomes. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { applyFireEvent, parseFireLine, replayFireLog } from "../src/ui/run-view.js";
import type { RunView } from "../src/ui/run-view.js";
import { PROBLEMS_SHOWN, runPageLines } from "../src/ui/running.js";
import { fireLogPath } from "../src/paths.js";
import { FIRE_LOG_TAIL_BYTES, foldRunProblems, readFireLogTail, readRunProblems } from "../src/ui/firelog.js";
import { RunRegistry } from "../src/ui/registry.js";
import { slug } from "../src/paths.js";
import type { FireEvent, RunRecord } from "../src/types.js";
import { handleLog, runningViews, type CommandDeps, type Refreshed } from "../src/commands.js";
import { acquireRunLock, runLockInfo } from "../src/locks.js";
import { DEFAULTS } from "../src/config.js";
import { State } from "../src/state.js";
import { Trust } from "../src/trust.js";
import { fire } from "../src/run.js";
import { readRecords } from "../src/records.js";
import { HOST_NOW, isolatedAutomation, isolatedFireDeps } from "./helpers/isolated-host.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const HERE = path.dirname(fileURLToPath(import.meta.url));

const RUN_ID = "20260921-010000-abcd";
const KEY = "user:/roots:nightly";

function record(outcome: RunRecord["outcome"] = "ok"): RunRecord {
  return {
    id: RUN_ID,
    key: KEY,
    name: "nightly",
    scope: "user",
    root: "/roots",
    trigger: "schedule",
    recordedAt: "2026-09-21T01:00:05.000Z",
    startedAt: "2026-09-21T01:00:00.000Z",
    endedAt: "2026-09-21T01:00:05.000Z",
    late: false,
    outcome,
  };
}

/** The events one run emits, with `problem` where core actually raises it — after the record. */
function events(problems: string[], outcome: RunRecord["outcome"] = "ok"): FireEvent[] {
  return [
    { event: "start", runId: RUN_ID, key: KEY, trigger: "schedule", late: false },
    { event: "record", record: record(outcome) },
    ...problems.map((message): FireEvent => ({ event: "problem", message })),
  ];
}

/** The bare view a watcher starts from before any event has arrived. */
function baseView(): RunView {
  return {
    key: KEY,
    name: "nightly",
    trigger: "schedule",
    source: "attached",
    startedAt: "2026-09-21T01:00:00.000Z",
    timeoutMs: 60_000,
    steps: [],
    phase: "starting",
    stderrTail: [],
  };
}

function viewFrom(evs: FireEvent[]): RunView {
  return evs.reduce((v, e) => applyFireEvent(v, e), baseView());
}

function render(evs: FireEvent[], width = 100): string {
  return runPageLines(viewFrom(evs), width, new Date("2026-09-21T01:00:06Z")).join("\n");
}

describe("a provider problem is rendered, not just collected", () => {
  it("appears while the run is still live", () => {
    const live = viewFrom([
      { event: "start", runId: RUN_ID, key: KEY, trigger: "schedule", late: false },
      { event: "problem", message: "flow next failed: fm stopped" },
    ]);
    const text = runPageLines(live, 100, new Date("2026-09-21T01:00:02Z")).join("\n");

    expect(live.phase).toBe("running");
    expect(text).toContain("provider: flow next failed: fm stopped");
  });

  it("appears in the text of a finished run", () => {
    const text = render(events(["workspace release failed: the worktree is locked"]));

    expect(text).toContain("workspace release failed");
    expect(text).toContain("the worktree is locked");
  });

  it("names the PROVIDER, so nobody debugs the automation instead", () => {
    const text = render(events(["notification did not finish within 15s"]));
    expect(text).toMatch(/provider:/);
  });

  it("sits BESIDE the outcome and never replaces it", () => {
    const text = render(events(["workspace release failed: locked"], "ok"));

    // The run itself succeeded. A cleanup fault must not make it read as a failure.
    expect(text).toContain("nightly");
    expect(text).toContain("workspace release failed");
    expect(text.toLowerCase()).not.toContain("failed · see details");
  });

  it("is absent when there is nothing to say", () => {
    expect(render(events([]))).not.toMatch(/provider:/);
  });

  it("is bounded, and says how many it is not showing", () => {
    const many = Array.from({ length: PROBLEMS_SHOWN + 4 }, (_, i) => `problem number ${i}`);
    const text = render(events(many));

    expect(text).toContain("problem number 0");
    expect(text).toContain(`and ${many.length - PROBLEMS_SHOWN} more`);
    // A provider failing repeatedly must not push the run's own detail off the screen.
    expect(text).not.toContain(`problem number ${many.length - 1}`);
  });

  it("is truncated to the width it was given", () => {
    const text = render(events(["x".repeat(400)]), 60);
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe("after the worker has gone, and after a close and reopen", () => {
  /** Rebuilt from the LOG BYTES alone. */
  function reopen(logText: string): RunView | undefined {
    return replayFireLog(baseView(), logText.split("\n"), RUN_ID);
  }

  it("survives a round trip through the fire log", () => {
    const evs = events(["workspace release did not finish within 15s"]);
    // Exactly what `bin/fire.js` writes: one JSON event per stdout line.
    const logText = evs.map((e) => JSON.stringify(e)).join("\n");

    const reopened = reopen(logText);
    expect(reopened?.problems ?? []).toEqual(["workspace release did not finish within 15s"]);

    const text = runPageLines(reopened as NonNullable<typeof reopened>, 100, new Date("2026-09-21T01:00:06Z")).join("\n");
    expect(text).toContain("workspace release did not finish");
  });

  it("survives interleaved non-JSON lines, which a real fire log is full of", () => {
    const evs = events(["notification failed: toast exploded"]);
    const logText = [
      "some stderr the body wrote",
      ...evs.map((e) => JSON.stringify(e)),
      "a trailing warning from the worker",
    ].join("\n");

    expect(reopen(logText)?.problems ?? []).toEqual(["notification failed: toast exploded"]);
  });

  it("keeps the record — one terminal outcome, plus the aside", () => {
    const evs = events(["workspace release failed: locked"], "failed");
    const reopened = reopen(evs.map((e) => JSON.stringify(e)).join("\n"));

    expect(reopened?.record?.outcome).toBe("failed");
    expect(reopened?.record?.id).toBe(RUN_ID);
    expect(reopened?.problems).toHaveLength(1);
  });

  it("parses a problem line on its own, so the event is genuinely in the format", () => {
    const line = JSON.stringify({ event: "problem", message: "workspace release failed: locked" });
    expect(parseFireLine(line)).toEqual({
      event: "problem",
      message: "workspace release failed: locked",
    });
  });

  it("does NOT stop replaying at the record — a problem arrives after it", () => {
    const evs = events(["notification did not finish within 15s"]);
    const idx = evs.findIndex((e) => e.event === "record");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(evs.slice(idx + 1).some((e) => e.event === "problem")).toBe(true);
    expect(reopen(evs.map((e) => JSON.stringify(e)).join("\n"))?.problems).toHaveLength(1);
  });
});

describe("a standalone child finishes on its own when a provider never settles", () => {
  it("exits without the parent having to kill it", () => {
    const dir = tempDir("pi-never-");
    const child = path.join(HERE, "fixtures", "never-settling-provider.mjs");

    const started = Date.now();
    // The parent bound is the OUTER NET, not the mechanism. If the child needed it, `execFileSync`
    // would throw ETIMEDOUT rather than returning — which is exactly the failure this is looking
    // for, because it would mean a child-local timer was holding node open.
    const out = execFileSync(process.execPath, [child, dir], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    const elapsed = Date.now() - started;

    const report = JSON.parse(out.trim().split("\n").pop() as string) as {
      settled: boolean;
      problem: string | null;
      lateRejectionHandled: boolean;
      mode: string;
      result: string;
      errorMessage: string | null;
    };

    // It finished, and it finished because the bounded wait gave up — not because anything killed
    // it, and comfortably inside the outer net.
    expect(report.settled).toBe(true);
    expect(elapsed).toBeLessThan(55_000);

    // The diagnostic is real, and it is about the NOTIFIER.
    expect(report.problem).toMatch(/notification did not finish/);

    // The run's own result is untouched.
    expect(report.result).toBe("failed");
    expect(report.errorMessage).toContain("the body itself failed");

    // And the rejection that lands after the bound was handled rather than becoming an unhandled
    // rejection that would have taken the child down after it had already finished.
    expect(report.lateRejectionHandled).toBe(true);
    expect(report.mode).toBe("late");
  }, 90_000);
});

describe("the ordinary readers, long after the run and its lock are gone", () => {
  /** The real `handleLog`, given one already-discovered automation. */
  async function logLinesFor(
    stateDir: string,
    key: string,
    json = false,
    width?: number,
  ): Promise<string[]> {
    const deps = {
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      now: () => new Date("2026-09-20T02:00:00Z"),
      home: stateDir,
      cwd: stateDir,
      ...(width ? { width } : {}),
    } as unknown as CommandDeps;
    const refreshed = { statuses: [{ key, name: "nightly", state: "ok" }] } as unknown as Refreshed;

    const out = await handleLog(deps, refreshed, "nightly", 10, json);
    return out.lines;
  }
  // A finished run whose log holds a problem reported after its terminal record.
  //
  // Written through the real fire-log path and read back through the real readers, so this is the
  // route a scheduled run actually takes rather than a view handed straight to a renderer.
  function finishedRun(label: string, problems: string[], runId = "run-aaa") {
    const stateDir = tempDir(label);
    const key = `user:${path.join(stateDir, "roots")}:nightly`;
    const record: RunRecord = {
      id: runId,
      key,
      name: "nightly",
      trigger: "schedule",
      outcome: "ok",
      recordedAt: "2026-09-20T01:00:02Z",
      startedAt: "2026-09-20T01:00:00Z",
      endedAt: "2026-09-20T01:00:02Z",
    } as RunRecord;

    const lines = [
      JSON.stringify({ event: "start", runId, key, name: "nightly", trigger: "schedule", startedAt: record.startedAt, timeoutMs: 1000 }),
      JSON.stringify({ event: "record", record }),
      // After the record, which is the whole reason the record cannot carry it.
      ...problems.map((message) => JSON.stringify({ event: "problem", message })),
    ];

    mkdirSync(path.dirname(fireLogPath(stateDir, key)), { recursive: true });
    writeFileSync(fireLogPath(stateDir, key), `${lines.join("\n")}\n`);
    mkdirSync(path.join(stateDir, "runs"), { recursive: true });
    writeFileSync(path.join(stateDir, "runs", `${slug(key)}.jsonl`), `${JSON.stringify(record)}\n`);
    return { stateDir, key, record, runId };
  }

  it("readRunProblems finds a post-record diagnostic through the durable log", () => {
    const { stateDir, key, runId } = finishedRun("diag-read-", ["workspace cleanup failed: EBUSY"]);

    expect(readRunProblems(stateDir, key, runId)).toEqual(["workspace cleanup failed: EBUSY"]);
  });

  it("gives an adjacent run none of this one's problems", () => {
    const { stateDir, key } = finishedRun("diag-corr-", ["notification did not finish within 5s"]);

    // Same automation, different run: correlation is by id, so nothing crosses over.
    expect(readRunProblems(stateDir, key, "run-bbb")).toEqual([]);
  });

  it("says nothing for ordinary work that had no problem", () => {
    const { stateDir, key, runId } = finishedRun("diag-quiet-", []);

    expect(readRunProblems(stateDir, key, runId)).toEqual([]);
  });

  it("shows the diagnostic in the log view, beside the outcome", async () => {
    const { stateDir, key } = finishedRun("diag-log-", ["workspace cleanup failed: EBUSY"]);
    const out = await logLinesFor(stateDir, key);

    // The run's own outcome is still the line it has always been.
    expect(out.some((l) => l.includes("ok"))).toBe(true);
    expect(out.some((l) => l.includes("provider: workspace cleanup failed: EBUSY"))).toBe(true);
  });

  it("bounds and clips provider diagnostics in the log view", async () => {
    const problems = Array.from(
      { length: PROBLEMS_SHOWN + 2 },
      (_, i) => `problem ${i} ${"x".repeat(80)}`,
    );
    const { stateDir, key } = finishedRun("diag-log-bounded-", problems);
    const out = await logLinesFor(stateDir, key, false, 64);

    expect(out.filter((line) => line.includes("provider:"))).toHaveLength(PROBLEMS_SHOWN);
    expect(out.some((line) => line.includes("and 2 more"))).toBe(true);
    expect(
      out.filter((line) => line.includes("provider:") || line.includes("and 2 more"))
        .every((line) => line.length <= 64),
    ).toBe(true);
  });

  it("shows it in the JSON view, without changing a record that has none", async () => {
    const withProblem = finishedRun("diag-json-", ["notification did not finish within 5s"]);
    const parsed = JSON.parse((await logLinesFor(withProblem.stateDir, withProblem.key, true))[0] as string) as {
      outcome: string;
      problems?: string[];
    };
    expect(parsed.outcome).toBe("ok");
    expect(parsed.problems).toEqual(["notification did not finish within 5s"]);

    const quiet = finishedRun("diag-json-quiet-", []);
    const plain = JSON.parse((await logLinesFor(quiet.stateDir, quiet.key, true))[0] as string) as Record<string, unknown>;
    // Byte-identical to what a reader saw before: nothing is added when there is nothing to add.
    expect("problems" in plain).toBe(false);
  });

  it("renders it on the page of a reopened, finished run", () => {
    const { stateDir, key, record, runId } = finishedRun("diag-detail-", ["workspace cleanup failed: EBUSY"]);

    // A fresh reader: nothing survives in memory from the run, only the files it left.
    const view: RunView = {
      key,
      name: "nightly",
      trigger: "schedule",
      source: "observed",
      runId,
      startedAt: record.startedAt as string,
      timeoutMs: 1000,
      steps: [],
      phase: "done",
      stderrTail: [],
      record,
      problems: readRunProblems(stateDir, key, runId),
    };

    const text = runPageLines(view, 100, new Date("2026-09-21T01:00:06Z")).join("\n");
    expect(text).toContain("provider: workspace cleanup failed: EBUSY");
  });
});

describe("the running window keeps a diagnostic it used to discard", () => {
  // An observed run whose log has already recorded an outcome and then a provider fault.
  //
  // The lock is still held, so the row is still shown — which is exactly the case where the
  // finished replay is not used as the row and its problems were being dropped with it.
  function observedWithProblem(label: string, truncateStart = false) {
    const stateDir = tempDir(label);
    const key = `user:${path.join(stateDir, "roots")}:nightly`;
    const runId = "run-obs";
    const record = {
      id: runId,
      key,
      name: "nightly",
      trigger: "manual",
      outcome: "ok",
      recordedAt: "2026-09-20T01:00:02Z",
      startedAt: "2026-09-20T01:00:00Z",
      endedAt: "2026-09-20T01:00:02Z",
    } as RunRecord;

    mkdirSync(path.dirname(fireLogPath(stateDir, key)), { recursive: true });
    writeFileSync(
      fireLogPath(stateDir, key),
      `${[
        JSON.stringify({ event: "start", runId, key, name: "nightly", trigger: "manual", startedAt: record.startedAt, timeoutMs: 60_000 }),
        ...(truncateStart ? ["x".repeat(FIRE_LOG_TAIL_BYTES)] : []),
        JSON.stringify({ event: "record", record }),
        JSON.stringify({ event: "problem", message: "workspace cleanup failed: EBUSY", ...(truncateStart ? { runId } : {}) }),
      ].join("\n")}\n`,
    );

    // The real lock writer, so the row is discovered exactly as a live run's would be.
    acquireRunLock(
      stateDir,
      runLockInfo({
        key,
        runId,
        timeoutMs: 60_000,
        postHooks: 0,
        trigger: "manual",
        now: new Date("2026-09-20T01:00:00Z"),
      }),
    );
    return { stateDir, key, runId };
  }

  it.each([false, true])("keeps diagnostics in CLI and registry rows (truncated start: %s)", (truncateStart) => {
    const { stateDir, key } = observedWithProblem("diag-obs-", truncateStart);
    const now = () => new Date("2026-09-20T01:00:10Z");
    const deps = {
      config: DEFAULTS,
      stateDir,
      now,
    } as unknown as CommandDeps;

    const tail = readFireLogTail(stateDir, key);
    expect(tail.some((line) => parseFireLine(line)?.event === "start")).toBe(!truncateStart);
    const views = runningViews(deps, { statuses: [{ key, name: "nightly", state: "ok" }] } as unknown as Refreshed);
    const registry = new RunRegistry({ stateDir, config: DEFAULTS, now });
    registry.refreshObserved([key]);

    expect(views).toHaveLength(1);
    expect(registry.all()).toHaveLength(1);
    for (const view of [views[0], registry.all()[0]?.view]) {
      expect.soft(view?.problems).toEqual(["workspace cleanup failed: EBUSY"]);
      expect(view?.record).toBeUndefined();
      expect(view?.steps).toEqual([]);
    }
  });

  it("adds nothing to a row whose run reported no problem", () => {
    const { stateDir, key } = observedWithProblem("diag-obs-quiet-");
    // Same fixture without the problem line.
    const lines = readFileSync(fireLogPath(stateDir, key), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.includes('"problem"'));
    writeFileSync(fireLogPath(stateDir, key), `${lines.join("\n")}\n`);

    const deps = {
      config: DEFAULTS,
      stateDir,
      now: () => new Date("2026-09-20T01:00:10Z"),
    } as unknown as CommandDeps;

    const views = runningViews(deps, { statuses: [{ key, name: "nightly", state: "ok" }] } as unknown as Refreshed);

    expect(views).toHaveLength(1);
    expect(views[0]?.problems ?? []).toEqual([]);
  });
});

describe("a provider that never settles at all", () => {
  it("still ends, with no timer of its own to end it", () => {
    const dir = tempDir("pi-forever-");
    const child = path.join(HERE, "fixtures", "never-settling-provider.mjs");

    const started = Date.now();
    // No provider timer, no child watchdog, no explicit exit. Only the core bound can end this, and
    // only an unref'd deadline lets node exit afterwards.
    const out = execFileSync(process.execPath, [child, dir, "forever"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    const elapsed = Date.now() - started;

    const report = JSON.parse(out.trim().split("\n").pop() as string) as {
      settled: boolean;
      mode: string;
      problem: string | null;
      result: string;
      lateRejectionHandled: boolean;
    };

    expect(report.mode).toBe("forever");
    expect(report.settled).toBe(true);
    expect(elapsed).toBeLessThan(55_000);
    expect(report.problem).toMatch(/notification did not finish/);
    // The run's own result is untouched, and nothing rejected late in this shape.
    expect(report.result).toBe("failed");
    expect(report.lateRejectionHandled).toBe(false);
  }, 90_000);
});

describe("core persists a provider fault itself, with nobody listening", () => {
  const MANUAL = { trigger: "manual" as const, now: () => HOST_NOW };

  /** Every line the automation's own fire log holds. */
  function logLines(stateDir: string, key: string): string[] {
    const file = fireLogPath(stateDir, key);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  }

  /** Prove the lock is free by taking it, not by looking for its file. */
  function lockIsFree(stateDir: string, key: string): boolean {
    const got = acquireRunLock(
      stateDir,
      runLockInfo({ key, runId: "probe", timeoutMs: 1000, postHooks: 0, trigger: "manual", now: new Date() }),
    );
    if (got.ok) got.release();
    return got.ok;
  }

  /** One real run with a workspace that will not release. */
  async function faultyRun(name: string) {
    const a = isolatedAutomation({ name, frontmatter: "on:\n  manual: true\n" });
    const cwd = tempDir("pi-prod-ws-");
    const record = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, {
        prepareWorkspace: async () => ({
          ok: true,
          workspace: {
            cwd,
            release: async () => {
              throw new Error("worktree removal exploded");
            },
          },
        }),
        notify: async () => {
          throw new Error("toast exploded");
        },
      }),
    );
    return { a, record };
  }

  it("writes the fault to the log, tagged with its run", async () => {
    const { a, record } = await faultyRun("prod-persist");

    const problems = logLines(a.stateDir, a.located.key)
      .map((l) => JSON.parse(l) as { event: string; message?: string; runId?: string })
      .filter((e) => e.event === "problem");

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.runId === record.id)).toBe(true);
    expect(problems.map((p) => p.message).join(" ")).toContain("workspace release failed");
  });

  it("keeps the primary outcome, one record, and a lock a real run can take", async () => {
    const { a, record } = await faultyRun("prod-primary");

    expect(record.outcome).toBe("ok");
    expect(readRecords(a.stateDir, a.located.key, 100)).toHaveLength(1);
    expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
  });

  it("is readable by a fresh reader that only has the state directory", async () => {
    const { a, record } = await faultyRun("prod-reader");

    const found = readRunProblems(a.stateDir, a.located.key, record.id);
    expect(found.join(" ")).toContain("workspace release failed");
    // One entry per fault, even though core appends and a host tee may copy the same line.
    expect(new Set(found).size).toBe(found.length);
  });

  it("shows it in the ordinary log text and json", async () => {
    const { a, record } = await faultyRun("prod-log");
    const deps = {
      config: DEFAULTS,
      stateDir: a.stateDir,
      trust: new Trust(a.stateDir),
      state: new State(a.stateDir),
      now: () => new Date("2026-09-17T15:00:00Z"),
      home: a.stateDir,
      cwd: a.stateDir,
    } as unknown as CommandDeps;
    const refreshed = { statuses: [{ key: a.located.key, name: "prod-log", state: "ok" }] } as unknown as Refreshed;

    const text = (await handleLog(deps, refreshed, "prod-log", 10, false)).lines.join("\n");
    expect(text).toContain("provider: workspace release failed");

    const json = (await handleLog(deps, refreshed, "prod-log", 10, true)).lines;
    const parsed = JSON.parse(json[0] as string) as { id: string; problems?: string[] };
    expect(parsed.id).toBe(record.id);
    expect((parsed.problems ?? []).join(" ")).toContain("workspace release failed");
  });

  it("says nothing at all for a run whose providers behaved", async () => {
    const a = isolatedAutomation({ name: "prod-quiet", frontmatter: "on:\n  manual: true\n" });
    const record = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, {}));

    expect(record.outcome).toBe("ok");
    const problems = logLines(a.stateDir, a.located.key)
      .map((l) => JSON.parse(l) as { event: string })
      .filter((e) => e.event === "problem");
    expect(problems).toEqual([]);
    expect(readRunProblems(a.stateDir, a.located.key, record.id)).toEqual([]);
  });

  it("keeps two runs of the same automation apart", async () => {
    const { a, record: first } = await faultyRun("prod-two");
    const second = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, {}));

    expect(second.id).not.toBe(first.id);
    expect(readRunProblems(a.stateDir, a.located.key, first.id).join(" ")).toContain("workspace release failed");
    // The quiet run gets none of its neighbour's, even though they share one log.
    expect(readRunProblems(a.stateDir, a.located.key, second.id)).toEqual([]);
  });
});

describe("folding a log back into one run's diagnostics", () => {
  const start = (runId: string) => JSON.stringify({ event: "start", runId, key: "k", trigger: "manual", late: false });
  const record = (id: string) => JSON.stringify({ event: "record", record: { id, key: "k", name: "n", trigger: "manual", outcome: "ok", recordedAt: "2026-09-20T01:00:00Z" } });
  const tagged = (runId: string, message: string) => JSON.stringify({ event: "problem", message, runId });
  const untagged = (message: string) => JSON.stringify({ event: "problem", message });

  it("collapses the same fault seen twice", () => {
    // Core appends it and a host tee copies the same line through stdout; that is one fault.
    const lines = [start("a"), record("a"), tagged("a", "cleanup failed"), tagged("a", "cleanup failed")];

    expect(foldRunProblems(lines, "a")).toEqual(["cleanup failed"]);
  });

  it("honours the tag even when the line arrives before the run's own start", () => {
    // Pipe buffering can place a copied line anywhere; the tag is what decides, not the position.
    const lines = [tagged("b", "notifier failed"), start("a"), record("a"), start("b"), record("b")];

    expect(foldRunProblems(lines, "b")).toEqual(["notifier failed"]);
    expect(foldRunProblems(lines, "a")).toEqual([]);
  });

  it("reads an old log that has no tags at all, by window", () => {
    const lines = [start("a"), record("a"), untagged("old fault"), start("b"), record("b"), untagged("newer fault")];

    expect(foldRunProblems(lines, "a")).toEqual(["old fault"]);
    expect(foldRunProblems(lines, "b")).toEqual(["newer fault"]);
  });

  it("gives a run nothing when its start is not in the bounded tail", () => {
    // The tail starts mid-file, which is normal; an untagged line then has no window to belong to.
    expect(foldRunProblems([untagged("orphan")], "a")).toEqual([]);
    // A tagged one still finds its run.
    expect(foldRunProblems([tagged("a", "kept")], "a")).toEqual(["kept"]);
  });

  it("never gives one run another's tagged fault", () => {
    const lines = [start("a"), tagged("b", "not mine"), record("a")];

    expect(foldRunProblems(lines, "a")).toEqual([]);
  });
});

describe("a log that cannot be appended to", () => {
  it("reports the failure on the channel and still finishes the run", async () => {
    const a = isolatedAutomation({ name: "prod-badlog", frontmatter: "on:\n  manual: true\n" });
    // A directory exactly where the log file belongs, so every append fails.
    mkdirSync(fireLogPath(a.stateDir, a.located.key), { recursive: true });

    const events: FireEvent[] = [];
    const cwd = tempDir("pi-prod-badlog-ws-");
    const record = await fire(
      a.located,
      { trigger: "manual" as const, now: () => HOST_NOW, emit: (e: FireEvent) => events.push(e) },
      isolatedFireDeps(a.stateDir, {
        prepareWorkspace: async () => ({
          ok: true,
          workspace: {
            cwd,
            release: async () => {
              throw new Error("worktree removal exploded");
            },
          },
        }),
      }),
    );

    const said = events.flatMap((e) => (e.event === "problem" ? [e.message] : []));
    // The original fault, and the fact that it could not be written down — never one silently
    // standing in for the other.
    expect(said.join(" ")).toContain("workspace release failed");
    expect(said.filter((m) => m.startsWith("could not record a diagnostic"))).toHaveLength(1);

    expect(record.outcome).toBe("ok");
    expect(readRecords(a.stateDir, a.located.key, 100)).toHaveLength(1);
  });
});

describe("replaying a log into a run view applies the same two rules", () => {
  const base: RunView = {
    key: "user:/r:nightly",
    name: "nightly",
    trigger: "manual",
    source: "observed",
    runId: "a",
    startedAt: "2026-09-20T01:00:00Z",
    timeoutMs: 60_000,
    steps: [],
    phase: "running",
    stderrTail: [],
  };
  const start = (runId: string) => JSON.stringify({ event: "start", runId, key: base.key, trigger: "manual", late: false });
  const tagged = (runId: string, message: string) => JSON.stringify({ event: "problem", message, runId });

  it("shows one fault when core wrote it and a host tee copied it", () => {
    const view = replayFireLog(base, [start("a"), tagged("a", "cleanup failed"), tagged("a", "cleanup failed")], "a");

    expect(view?.problems).toEqual(["cleanup failed"]);
  });

  it("shows one fault when an untagged copy of it follows the tagged one", () => {
    // The tee reproduces whatever core emitted, so a log written across a version change can hold
    // both shapes of the same line.
    const view = replayFireLog(
      base,
      [start("a"), tagged("a", "cleanup failed"), JSON.stringify({ event: "problem", message: "cleanup failed" })],
      "a",
    );

    expect(view?.problems).toEqual(["cleanup failed"]);
  });

  it("refuses a neighbouring run's fault that landed inside this run's lines", () => {
    const view = replayFireLog(base, [start("a"), tagged("b", "not mine"), tagged("a", "mine")], "a");

    expect(view?.problems).toEqual(["mine"]);
  });

  it("still takes an untagged fault, which is all an old log has", () => {
    const view = replayFireLog(
      base,
      [start("a"), JSON.stringify({ event: "problem", message: "old fault" })],
      "a",
    );

    expect(view?.problems).toEqual(["old fault"]);
  });
});

describe("the history reader and the replay agree, whatever order the lines arrive in", () => {
  const base: RunView = {
    key: "user:/r:nightly",
    name: "nightly",
    trigger: "manual",
    source: "observed",
    runId: "a",
    startedAt: "2026-09-20T01:00:00Z",
    timeoutMs: 60_000,
    steps: [],
    phase: "running",
    stderrTail: [],
  };
  const start = (runId: string) => JSON.stringify({ event: "start", runId, key: base.key, trigger: "manual", late: false });
  const rec = (id: string) => JSON.stringify({ event: "record", record: { id, key: base.key, name: "nightly", trigger: "manual", outcome: "ok", recordedAt: "2026-09-20T01:00:02Z" } });
  const tagged = (runId: string, message: string) => JSON.stringify({ event: "problem", message, runId });
  const untagged = (message: string) => JSON.stringify({ event: "problem", message });

  /** Both readers, on the very same lines. Disagreement is the defect this exists to catch. */
  function both(lines: string[], runId: string) {
    return {
      fold: foldRunProblems(lines, runId),
      replay: replayFireLog({ ...base, runId }, lines, runId)?.problems ?? [],
    };
  }

  it("agrees when a tagged fault lands before its own run started", () => {
    // Pipe buffering can place a copied line anywhere; the tag decides, not the position.
    const lines = [tagged("b", "owned routing fault"), start("a"), rec("a"), start("b"), rec("b")];
    const out = both(lines, "b");

    expect(out.fold).toEqual(["owned routing fault"]);
    expect(out.replay).toEqual(out.fold);
  });

  it("agrees when a tagged fault lands after the next run started", () => {
    const lines = [start("a"), rec("a"), start("b"), rec("b"), tagged("a", "owned routing fault")];
    const out = both(lines, "a");

    expect(out.fold).toEqual(["owned routing fault"]);
    expect(out.replay).toEqual(out.fold);
  });

  it("agrees on an ordinary ordered log", () => {
    const lines = [start("a"), rec("a"), tagged("a", "owned routing fault")];
    const out = both(lines, "a");

    expect(out.fold).toEqual(["owned routing fault"]);
    expect(out.replay).toEqual(out.fold);
  });

  it("agrees on every shuffle of one run's lines", () => {
    // The orderings a bounded tail with two writers can actually produce.
    const parts = [start("a"), rec("a"), tagged("a", "first fault"), tagged("a", "second fault")];
    for (const shuffled of permutations(parts)) {
      const out = both(shuffled, "a");
      expect(out.replay, shuffled.join(" | ")).toEqual(out.fold);
      expect(new Set(out.fold).size).toBe(out.fold.length);
    }
  });

  it("still finds a tagged fault in a tail that holds no start at all", () => {
    // A bounded tail routinely begins mid-file, so this run's `start` is simply not in it.
    const lines = [tagged("a", "owned routing fault"), rec("a"), tagged("b", "foreign fault"), untagged("unowned fault")];
    const out = both(lines, "a");
    const view = replayFireLog(base, lines, "a");

    expect(out.fold).toEqual(["owned routing fault"]);
    expect(out.replay).toEqual(out.fold);
    expect(view?.record).toBeUndefined();
    expect(view?.phase).toBe(base.phase);
    expect(view?.steps).toEqual(base.steps);
    expect(base.problems).toBeUndefined();
  });

  it("does not infer a view from an uncorrelated tail", () => {
    const lines = [tagged("b", "foreign fault"), untagged("unowned fault"), rec("b")];
    expect(foldRunProblems(lines, "a")).toEqual([]);
    expect(replayFireLog(base, lines, "a")).toBeUndefined();
  });

  it("stops the replay window at the next run, so its steps and record stay out", () => {
    // Faults are folded from the whole tail; everything else is still windowed, and a later run's
    // progress must not be replayed into an earlier run's view.
    const lines = [
      start("a"),
      JSON.stringify({ event: "hook-start", phase: "pre", index: 0, source: "a.js" }),
      start("b"),
      // A different node, so b's progress is distinguishable from a's rather than merging into it.
      JSON.stringify({ event: "hook-start", phase: "pre", index: 1, source: "b.js" }),
      rec("b"),
    ];

    const view = replayFireLog({ ...base, runId: "a" }, lines, "a");
    expect(view).toBeDefined();
    // b's record belongs to b.
    expect(view?.record).toBeUndefined();
    // a's own step is there, and b's is not.
    expect(view?.steps.some((s) => s.id === "pre0")).toBe(true);
    expect(view?.steps.some((s) => s.id === "pre1")).toBe(false);
  });

  it("gives neither reader another run's fault", () => {
    const lines = [start("a"), tagged("b", "not mine"), rec("a")];
    const out = both(lines, "a");

    expect(out.fold).toEqual([]);
    expect(out.replay).toEqual([]);
  });

  it("collapses a duplicate the same way in both", () => {
    const lines = [start("a"), tagged("a", "same fault"), untagged("same fault"), rec("a")];
    const out = both(lines, "a");

    expect(out.fold).toEqual(["same fault"]);
    expect(out.replay).toEqual(out.fold);
  });
});

/** Every ordering of a small list. Small on purpose: four lines is twenty-four cases. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i] as T, ...p]);
  }
  return out;
}

describe("a notifier that rejects, on the path that actually calls one", () => {
  it("persists its own diagnostic with no emitter, and keeps the primary outcome", async () => {
    const a = isolatedAutomation({ name: "notify-rejects", frontmatter: "on:\n  manual: true\n" });
    let calls = 0;

    // A failed body is what brings the notifier in: `notifyOnFailed` raises for a failed run and
    // for nothing else, which is why the cleanup fixture above never reaches this code.
    const record = await fire(
      a.located,
      { trigger: "manual" as const, now: () => HOST_NOW },
      isolatedFireDeps(a.stateDir, {
        config: { ...DEFAULTS, notifyOnFailed: true },
        startSession: async () => {
          throw new Error("the body itself failed, which is what brings the notifier in");
        },
        notify: async () => {
          calls += 1;
          throw new Error("toast exploded");
        },
      }),
    );

    // The notifier really was called, and really did reject.
    expect(calls).toBe(1);

    // The run's own result is the body's, untouched by the notifier's failure.
    expect(record.outcome).toBe("failed");
    expect(readRecords(a.stateDir, a.located.key, 100)).toHaveLength(1);

    // And the diagnostic is on disk, tagged, readable by a reader that has only the state dir.
    const found = readRunProblems(a.stateDir, a.located.key, record.id);
    expect(found.join(" ")).toMatch(/notification/i);
  });
});

describe("the live attached path folds a streamed problem directly", () => {
  // `replayFireLog` rebuilds from a log; an attached run instead hands each streamed event to
  // `registry.applyEvent`, which calls this. Same two rules, different entry point — and the only
  // one still exercising them per event.
  const view: RunView = {
    key: "user:/r:nightly",
    name: "nightly",
    trigger: "manual",
    source: "attached",
    runId: "a",
    startedAt: "2026-09-20T01:00:00Z",
    timeoutMs: 60_000,
    steps: [],
    phase: "running",
    stderrTail: [],
  };

  it("collapses the same fault streamed twice", () => {
    const once = applyFireEvent(view, { event: "problem", message: "cleanup failed", runId: "a" });
    const twice = applyFireEvent(once, { event: "problem", message: "cleanup failed", runId: "a" });

    expect(twice.problems).toEqual(["cleanup failed"]);
  });

  it("collapses an untagged copy of a tagged fault", () => {
    const once = applyFireEvent(view, { event: "problem", message: "cleanup failed", runId: "a" });
    const twice = applyFireEvent(once, { event: "problem", message: "cleanup failed" });

    expect(twice.problems).toEqual(["cleanup failed"]);
  });

  it("refuses a fault tagged for another run", () => {
    const out = applyFireEvent(view, { event: "problem", message: "not mine", runId: "b" });

    expect(out.problems ?? []).toEqual([]);
  });

  it("still takes an untagged fault, which is all an older worker sends", () => {
    const out = applyFireEvent(view, { event: "problem", message: "old fault" });

    expect(out.problems).toEqual(["old fault"]);
  });
});