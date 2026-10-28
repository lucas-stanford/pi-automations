/** What a run is, frozen before anything moves. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { acquireRunLock, readRunLock, runLockInfo } from "../src/locks.js";
import { appendRecord, readRecords, recordsFile } from "../src/records.js";
import { fire } from "../src/run.js";
import { summaryLine } from "../src/summary.js";
import { OUTPUT_MAX } from "../src/summary.js";
import type { FireEvent, RunRecord } from "../src/types.js";
import { cleanupTempDirs } from "./helpers/temp.js";
import {
  fakeSession,
  HOST_NOW,
  isolatedAutomation,
  isolatedFireDeps,
} from "./helpers/isolated-host.js";

afterAll(cleanupTempDirs);

const FIXTURES = path.join(import.meta.dirname, "compat-fixtures");

const MANUAL = { trigger: "manual" as const, now: () => HOST_NOW };

describe("the run record, as it is written today", () => {
  it("carries exactly the documented fields for a clean run", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const session = fakeSession(["the body answered"]);

    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, {
      startSession: session.starter,
    }));

    // Identity and provenance.
    expect(rec.key).toBe(a.located.key);
    expect(rec.name).toBe("test-automation");
    expect(rec.scope).toBe("user");
    expect(rec.root).toBe(a.located.root.path);
    expect(rec.trigger).toBe("manual");
    expect(rec.late).toBe(false);
    expect(rec.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);

    // Outcome and timing.
    expect(rec.outcome).toBe("ok");
    expect(rec.startedAt).toBe(HOST_NOW.toISOString());
    expect(rec.endedAt).toBe(HOST_NOW.toISOString());
    expect(rec.recordedAt).toBe(HOST_NOW.toISOString());

    // What ran.
    expect(rec.model).toBe("anthropic/default");
    expect(rec.timeout).toBeTypeOf("string");
    expect(rec.pid).toBe(process.pid);
    expect(rec.hooks).toEqual([]);
    expect(rec.output?.text).toBe("the body answered");

    // The session reference is exactly file + id.
    expect(rec.session).toEqual({ file: "/sessions/fake.jsonl", id: "fake-session" });
    expect(Object.keys(rec.session ?? {}).sort()).toEqual(["file", "id"]);

    // No schedule trigger, so no schedule fields.
    expect(rec.scheduledFor).toBeUndefined();
    expect(rec.error).toBeUndefined();
    expect(rec.reason).toBeUndefined();
  });

  it("keeps the schedule fields for a scheduled, late run", async () => {
    const a = isolatedAutomation({
      frontmatter: 'on:\n  schedule:\n    cron: "0 7 * * *"\n',
    });

    const rec = await fire(
      a.located,
      {
        trigger: "schedule",
        scheduledFor: "2026-09-17T07:00:00-07:00",
        late: true,
        now: () => HOST_NOW,
      },
      isolatedFireDeps(a.stateDir),
    );

    expect(rec.trigger).toBe("schedule");
    expect(rec.scheduledFor).toBe("2026-09-17T07:00:00-07:00");
    expect(rec.late).toBe(true);
    expect(rec.outcome).toBe("ok");
  });
});

describe("the outcome paths, as they behave today", () => {
  it("skips without starting anything when the lock is already held", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const session = fakeSession();

    acquireRunLock(
      a.stateDir,
      runLockInfo({
        key: a.located.key,
        runId: "someone-else",
        timeoutMs: 600_000,
        postHooks: 0,
        trigger: "manual",
        now: HOST_NOW,
      }),
    );

    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, {
      startSession: session.starter,
    }));

    expect(rec.outcome).toBe("skipped");
    expect(rec.reason).toMatch(/^still running since /);
    expect(session.opened).toBe(0);
    // The held lock belongs to the other run, so this one must not have released it.
    expect(readRunLock(a.stateDir, a.located.key)?.runId).toBe("someone-else");
  });

  it("skips on a pre hook that says skip, and never opens a session", async () => {
    const a = isolatedAutomation({
      frontmatter: "on:\n  manual: true\nhooks:\n  pre:\n    - script: s.js\n",
      scripts: { "s.js": "console.error('nothing new');process.exit(3);\n" },
    });
    const session = fakeSession();

    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, {
      startSession: session.starter,
    }));

    expect(rec.outcome).toBe("skipped");
    expect(rec.reason).toContain("nothing new");
    expect(session.opened).toBe(0);
    expect(rec.hooks?.[0]?.status).toBe("skipped");
  });

  it("fails with a hook error kind when a post hook is not the cause", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const starter = async () => {
      throw new Error("the model refused");
    };

    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, { startSession: starter }));

    expect(rec.outcome).toBe("failed");
    expect(rec.error?.kind).toBeTypeOf("string");
    expect(rec.error?.message).toContain("the model refused");
  });

  it("leaves the lock released and the record written on every path", async () => {
    for (const scripts of [{}, { "s.js": "process.exit(3);\n" }]) {
      const hooks = Object.keys(scripts).length
        ? "hooks:\n  pre:\n    - script: s.js\n"
        : "";
      const a = isolatedAutomation({
        frontmatter: `on:\n  manual: true\n${hooks}`,
        scripts,
      });

      await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir));

      expect(readRunLock(a.stateDir, a.located.key)).toBeUndefined();
      expect(readRecords(a.stateDir, a.located.key)).toHaveLength(1);
    }
  });
});

describe("a session costs nothing until the body needs one", () => {
  it("opens exactly one session for a body plus a post prompt", async () => {
    const a = isolatedAutomation({
      frontmatter: "on:\n  manual: true\nhooks:\n  post:\n    - prompt: Say goodbye.\n",
    });
    const session = fakeSession(["body", "goodbye"]);

    await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, { startSession: session.starter }));

    expect(session.opened).toBe(1);
    expect(session.asked).toHaveLength(2);
    expect(session.disposed).toBe(1);
  });

  it("opens none at all when a pre hook stops the run first", async () => {
    const a = isolatedAutomation({
      frontmatter: "on:\n  manual: true\nhooks:\n  pre:\n    - script: s.js\n",
      scripts: { "s.js": "process.exit(3);\n" },
    });
    const session = fakeSession();

    await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, { startSession: session.starter }));

    expect(session.opened).toBe(0);
    expect(session.disposed).toBe(0);
  });
});

describe("the event stream a watcher sees", () => {
  it("emits start, body-start, body-end and record in that order", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const seen: FireEvent[] = [];

    await fire(
      a.located,
      { ...MANUAL, emit: (e) => seen.push(e) },
      isolatedFireDeps(a.stateDir),
    );

    expect(seen.map((e) => e.event)).toEqual([
      "start",
      "body-start",
      "session",
      "body-end",
      "record",
    ]);
  });
});

describe("the on-disk history format", () => {
  it("reads a fixture history written by an earlier version, unchanged", () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const fixture = readFileSync(path.join(FIXTURES, "run-history.jsonl"), "utf8");
    const file = recordsFile(a.stateDir, a.located.key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, fixture);

    const records = readRecords(a.stateDir, a.located.key);

    expect(records).toHaveLength(4);
    expect(records.map((r) => r.outcome)).toEqual(["ok", "skipped", "failed", "aborted"]);
    expect(records[0]?.session).toEqual({
      file: "/home/tester/.pi/agent/sessions/s-1.jsonl",
      id: "s-1",
    });
    expect(records[2]?.error).toEqual({ kind: "model", message: "no credentials for anthropic" });
    expect(records[3]?.reason).toBe("stopped by request");

  });

  it("round-trips a record it wrote itself", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir));

    const [back] = readRecords(a.stateDir, a.located.key);
    expect(back).toEqual(rec);

    // One JSON object per line, no trailing blank object.
    const raw = readFileSync(recordsFile(a.stateDir, a.located.key), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] as string)).not.toThrow();
  });

  it("keeps history append-only across runs", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir));
    await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir));

    expect(readRecords(a.stateDir, a.located.key)).toHaveLength(2);
  });
});

describe("what a record says about a very long answer", () => {
  it("clips the stored output and the summary line", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const long = "x".repeat(OUTPUT_MAX * 3);

    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, {
      startSession: fakeSession([long]).starter,
    }));

    expect(rec.output?.text.length).toBeLessThanOrEqual(OUTPUT_MAX);
    expect(rec.output?.truncated).toBe(true);
    // `clipLine` appends its ellipsis AFTER slicing to `max`, so the bound is max + 1.
    expect(summaryLine(rec as RunRecord, 120).length).toBeLessThanOrEqual(121);
    expect(summaryLine(rec as RunRecord, 120).endsWith("…")).toBe(true);
  });

  it("records nothing under output when the body said nothing", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, {
      startSession: fakeSession([""]).starter,
    }));

    expect(rec.output).toBeUndefined();
  });
});

describe("retention", () => {
  it("rotates a long history down to the keep size", () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n" });
    const rec: RunRecord = {
      id: "r",
      key: a.located.key,
      name: "test-automation",
      scope: "user",
      root: a.located.root.path,
      trigger: "manual",
      late: false,
      recordedAt: HOST_NOW.toISOString(),
      outcome: "ok",
    };

    for (let i = 0; i < 40; i++) {
      appendRecord(a.stateDir, { ...rec, id: `r-${i}` }, { maxLinesPerAutomation: 20, keepLines: 5 });
    }

    const kept = readRecords(a.stateDir, a.located.key, 1000);
    expect(kept.length).toBeLessThanOrEqual(20);
    expect(kept.at(-1)?.id).toBe("r-39");
  });
});
