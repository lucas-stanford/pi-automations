/** The notification seam. */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import type { Notify } from "../src/core/contracts.js";
import { notificationText } from "../src/notify.js";
import { fire } from "../src/run.js";
import { summaryLine } from "../src/summary.js";
import type { RunRecord } from "../src/types.js";
import { cleanupTempDirs } from "./helpers/temp.js";
import { HOST_CONFIG, HOST_NOW, isolatedAutomation, isolatedFireDeps } from "./helpers/isolated-host.js";

afterAll(cleanupTempDirs);

const MANUAL = { trigger: "manual" as const, now: () => HOST_NOW };

/** A sink that records, and can be told to misbehave. */
function sink(over: { throws?: boolean; hangs?: boolean } = {}): {
  notify: Notify;
  seen: RunRecord[];
} {
  const seen: RunRecord[] = [];
  return {
    seen,
    notify: async (rec) => {
      seen.push(rec);
      if (over.throws) throw new Error("the notifier exploded");
      if (over.hangs) await new Promise((r) => setTimeout(r, 50));
    },
  };
}

/** An automation whose body fails. */
function failing() {
  return isolatedAutomation({
    frontmatter: "on:\n  manual: true\n",
    name: "breaks",
  });
}

const failingRuntime = {
  resolveModel: async () =>
    Object.freeze({ provider: "anthropic", id: "x", display: "anthropic/x" }) as never,
  startSession: async () => ({
    file: "/s.jsonl",
    id: "s",
    prompt: async () => {
      throw new Error("the model refused");
    },
    dispose: () => {},
  }),
};

describe("a failed run reaches whatever sink the host composed", () => {
  it("delivers the record when the person asked to be told", async () => {
    const a = failing();
    const s = sink();

    const rec = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, {
        runtime: failingRuntime,
        notify: s.notify,
        config: { ...HOST_CONFIG, notifyOnFailed: true },
      }),
    );

    expect(rec.outcome).toBe("failed");
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]?.name).toBe("breaks");
  });

  it("stays quiet when the person turned it off", async () => {
    const a = failing();
    const s = sink();

    const rec = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, {
        runtime: failingRuntime,
        notify: s.notify,
        config: { ...HOST_CONFIG, notifyOnFailed: false },
      }),
    );

    // The configured setting is still core's decision, not the sink's. A sink that had to check it
    // would let a replacement host quietly ignore the person's preference.
    expect(rec.outcome).toBe("failed");
    expect(s.seen).toEqual([]);
  });

  it("says nothing about a run that did not fail", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "fine" });
    const s = sink();

    const rec = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, {
        notify: s.notify,
        config: { ...HOST_CONFIG, notifyOnFailed: true },
      }),
    );

    expect(rec.outcome).toBe("ok");
    expect(s.seen).toEqual([]);
  });

  it("runs perfectly well for a host that composed no sink at all", async () => {
    const a = failing();

    const rec = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, {
        runtime: failingRuntime,
        notify: undefined,
        config: { ...HOST_CONFIG, notifyOnFailed: true },
      }),
    );

    // Absent means "this host tells nobody" — a headless tick, a CI run. It is a composition, not a
    // fault, so the run is recorded exactly as it would be otherwise.
    expect(rec.outcome).toBe("failed");
    expect(summaryLine(rec, 180)).toBeTruthy();
  });
});

describe("a notification cannot fail a run", () => {
  it("swallows a sink that throws", async () => {
    const a = failing();
    const s = sink({ throws: true });

    const rec = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, {
        runtime: failingRuntime,
        notify: s.notify,
        config: { ...HOST_CONFIG, notifyOnFailed: true },
      }),
    );

    // The record is already written and the run is already over. The least important part of the
    // system must not be able to break the most important one.
    expect(s.seen).toHaveLength(1);
    expect(rec.outcome).toBe("failed");
    // The sink's own error is nowhere on the record: it happened after the run was over.
    expect(JSON.stringify(rec)).not.toContain("exploded");
  });

  it("delivers to a slow sink without changing the record", async () => {
    const a = failing();
    const s = sink({ hangs: true });

    const rec = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, {
        runtime: failingRuntime,
        notify: s.notify,
        config: { ...HOST_CONFIG, notifyOnFailed: true },
      }),
    );

    expect(s.seen).toHaveLength(1);
    expect(rec.outcome).toBe("failed");
  });
});

describe("what a person is told is decided in one place", () => {
  const record: RunRecord = {
    id: "r1",
    key: "user:demo",
    name: "morning-mail",
    trigger: "manual",
    outcome: "failed",
    startedAt: "2026-09-17T14:00:00.000Z",
    endedAt: "2026-09-17T14:00:09.000Z",
    reason: "the model refused",
  } as RunRecord;

  it("titles it with the automation's name", () => {
    expect(notificationText(record).title).toBe("morning-mail failed");
  });

  it("uses the SAME sentence the log and the report use", () => {
    // A toast that phrases the failure differently from the log makes a person wonder whether they
    // are looking at the same run.
    expect(notificationText(record).body).toContain(summaryLine(record, 180));
  });

  it("says how long it took before giving up", () => {
    expect(notificationText(record).body).toContain("after 9s");
  });

  it("omits the duration when the record has no span", () => {
    const partial = { ...record, endedAt: undefined } as RunRecord;
    expect(notificationText(partial).body).not.toContain("after");
  });
});

describe("test safety is structural, not configured", () => {
  const testDir = import.meta.dirname;

  const testFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "compat-fixtures") walk(p);
        } else if (/\.(ts|js|mjs)$/.test(e.name)) {
          out.push(p);
        }
      }
    };
    walk(testDir);
    return out;
  };

  it("composes the desktop notifier nowhere that could actually reach a desktop", () => {
    const self = path.resolve(import.meta.filename);
    const offenders = testFiles()
      .filter((f) => path.resolve(f) !== self)
      .filter((f) => {
        const body = readFileSync(f, "utf8");
        // Composing it is a CALL. This file names the symbol in prose and in the scan itself, which
        // is why it is exempted by PATH rather than by wording.
        if (!/\bdesktopNotifier\s*\(/.test(body)) return false;
        // One legitimate reason to compose it: a test OF the sink, which mocks the operating system
        // boundary so nothing can spawn.
        return !/vi\.mock\(\s*["']node:child_process["']/.test(body);
      });
    expect(offenders).toEqual([]);
  });

  it("would notice a fixture that composed one, and still allows a mocked sink test", () => {
    // The scan is only worth anything if it can fail on the real mistake and pass on the real
    // exemption. Both arms, with synthetic sources.
    const composes = (body: string) =>
      /\bdesktopNotifier\s*\(/.test(body) &&
      !/vi\.mock\(\s*["']node:child_process["']/.test(body);

    expect(composes("const deps = { notify: desktopNotifier() };")).toBe(true);
    expect(composes("// mentions desktopNotifier in prose")).toBe(false);
    expect(
      composes('vi.mock("node:child_process", () => ({}));\nconst n = desktopNotifier("linux");'),
    ).toBe(false);
  });

  it("still keeps the configured flag off in every isolated host", () => {
    // Belt as well as braces: production notifies by default, and a fixture recorded before the
    // sink existed still describes the same run.
    expect(DEFAULTS.notifyOnFailed).toBe(true);
    expect(HOST_CONFIG.notifyOnFailed).toBe(false);
  });
});
