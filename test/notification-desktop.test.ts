/** The desktop sink itself. */

import { afterEach, describe, expect, it, vi } from "vitest";

const CALLS = vi.hoisted(() => ({ list: [] as Array<{ file: string; args: string[] }> }));

vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb?: () => void) => {
    CALLS.list.push({ file, args });
    cb?.();
    return { on: () => {} };
  },
}));

import { desktopNotifier, notifyFailed } from "../src/notify.js";
import type { RunRecord } from "../src/types.js";

afterEach(() => {
  CALLS.list.length = 0;
});

const failed = {
  id: "r1",
  key: "user:demo",
  name: "morning-mail",
  trigger: "manual",
  outcome: "failed",
  startedAt: "2026-09-17T14:00:00.000Z",
  endedAt: "2026-09-17T14:00:09.000Z",
  reason: "the model refused",
} as RunRecord;

describe("the desktop sink refuses anything that is not a failure", () => {
  for (const outcome of ["ok", "skipped", "aborted"] as const) {
    it(`says nothing at all about a ${outcome} run`, async () => {
      await notifyFailed({ ...failed, outcome } as RunRecord, "linux");
      // Not "sends a quieter toast" — reaches the operating system zero times. Core already
      // filters, but this is a shipped export: an installed caller can hand it anything, and a
      // toast for every quiet morning is how people learn to ignore them.
      expect(CALLS.list).toEqual([]);
    });
  }

  it("does announce a failure, so the check above is not vacuous", async () => {
    await notifyFailed(failed, "linux");
    expect(CALLS.list).toHaveLength(1);
    expect(CALLS.list[0]?.file).toBe("notify-send");
  });
});

describe("each platform is asked in its own language", () => {
  it("uses notify-send on linux, naming the app", async () => {
    await notifyFailed(failed, "linux");
    const call = CALLS.list[0];
    expect(call?.file).toBe("notify-send");
    expect(call?.args.slice(0, 2)).toEqual(["-a", "pi-automations"]);
    expect(call?.args[2]).toBe("morning-mail failed");
  });

  it("uses osascript on darwin", async () => {
    await notifyFailed(failed, "darwin");
    expect(CALLS.list[0]?.file).toBe("osascript");
    expect(CALLS.list[0]?.args[1]).toContain("display notification");
    expect(CALLS.list[0]?.args[1]).toContain("morning-mail failed");
  });

  it("uses a toast script on win32", async () => {
    await notifyFailed(failed, "win32");
    expect(CALLS.list[0]?.file).toBe("powershell");
    expect(CALLS.list[0]?.args).toContain("-NonInteractive");
    expect(CALLS.list[0]?.args.join(" ")).toContain("ToastNotificationManager");
  });

  it("does nothing on a platform it has no way to reach", async () => {
    await notifyFailed(failed, "aix");
    // Silently, and without throwing: a machine this does not know about is not a broken run.
    expect(CALLS.list).toEqual([]);
  });
});

describe("quoting", () => {
  it("escapes a quote so the AppleScript literal survives it", async () => {
    await notifyFailed({ ...failed, reason: 'it said "no"' } as RunRecord, "darwin");
    const script = CALLS.list[0]?.args[1] ?? "";
    // The body is inside a double-quoted AppleScript string; an unescaped quote would end it early
    // and the rest of the message would be read as code.
    expect(script).toContain('\\"no\\"');
  });
});

describe("desktopNotifier binds the platform once", () => {
  it("delivers through the platform it was composed with", async () => {
    const notify = desktopNotifier("linux");
    await notify(failed);
    expect(CALLS.list[0]?.file).toBe("notify-send");
  });

  it("carries the outcome rule with it", async () => {
    const notify = desktopNotifier("linux");
    await notify({ ...failed, outcome: "ok" } as RunRecord);
    expect(CALLS.list).toEqual([]);
  });
});
