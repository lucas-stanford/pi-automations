/** A provider that misbehaves must cost the run its provider, not its record. */

import { readdirSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { acquireRunLock, readRunLock } from "../src/locks.js";
import { readRecords } from "../src/records.js";
import { fire } from "../src/run.js";
import type { FireEvent, RunRecord } from "../src/types.js";
import type { FlowTracking, WorkspaceHandle } from "../src/core/contracts.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";
import { HOST_CONFIG, HOST_NOW, isolatedAutomation, isolatedFireDeps } from "./helpers/isolated-host.js";

afterAll(cleanupTempDirs);

const MANUAL = { trigger: "manual" as const, now: () => HOST_NOW };

/** A manual automation with no hooks, so the only moving parts are the ones under test. */
function automation(name: string) {
  return isolatedAutomation({ name, frontmatter: "on:\n  manual: true\n" });
}

interface Observed {
  record: RunRecord;
  events: FireEvent[];
  problems: string[];
  written: RunRecord[];
}

// Run one automation and collect everything the three assertions need.
//
// The events are captured rather than discarded because `problem` is a stream event: it is emitted
// after the record is written, so the stream is the only place it can be observed.
async function run(
  a: ReturnType<typeof automation>,
  over: Record<string, unknown>,
): Promise<Observed> {
  const events: FireEvent[] = [];
  const record = await fire(
    a.located,
    { ...MANUAL, emit: (e: FireEvent) => events.push(e) },
    isolatedFireDeps(a.stateDir, over),
  );
  return {
    record,
    events,
    problems: events.flatMap((e) => (e.event === "problem" ? [e.message] : [])),
    written: readRecords(a.stateDir, a.located.key, 100),
  };
}

// Prove the lock is genuinely free by TAKING it, not by looking at it.
//
// A missing lock file and a lock file this process may not have is the same absence on disk; only
// an acquisition proves the next real run would be allowed to start. Released immediately.
function lockIsFree(stateDir: string, key: string): boolean {
  const got = acquireRunLock(stateDir, {
    pid: process.pid,
    runId: "probe",
    key,
    startedAt: new Date().toISOString(),
    timeoutMs: 1000,
    postHooks: 0,
    trigger: "manual",
  });
  if (got.ok) got.release();
  return got.ok;
}

/** A tracker whose every call succeeds, except the named one, which throws. */
function trackerThatThrowsFrom(call: keyof FlowTracking | "factory"): {
  start: () => FlowTracking | undefined;
  calls: string[];
} {
  const calls: string[] = [];
  const boom = (name: string) => {
    calls.push(name);
    if (name === call) throw new Error(`tracker ${name} exploded`);
  };
  return {
    calls,
    start: () => {
      boom("factory");
      return {
        start: () => {
          boom("start");
          return "flow-session-1";
        },
        next: () => boom("next"),
        step: () => boom("step"),
        mark: () => boom("mark"),
        say: () => boom("say"),
        end: () => {
          boom("end");
          return undefined;
        },
        environment: () => {
          boom("environment");
          return { AUTOMATION_NODE: "body" };
        },
      } satisfies FlowTracking;
    },
  };
}

describe("a workspace provider that throws", () => {
  it("is the same one failed / host record an explicit refusal produces", async () => {
    const a = automation("prepare-throws");
    const out = await run(a, {
      prepareWorkspace: async () => {
        throw new Error("clone exploded");
      },
    });

    expect(out.record.outcome).toBe("failed");
    expect(out.record.error?.kind).toBe("host");
    // The underlying cause survives, bounded to one line, so the person reading history is told
    // what actually went wrong rather than "the run failed".
    expect(out.record.error?.message).toContain("clone exploded");

    expect(out.written).toHaveLength(1);
    expect(out.written[0]).toEqual(out.record);
  });

  it("runs no hooks, opens no session and starts no tracking", async () => {
    const a = isolatedAutomation({
      name: "prepare-throws-hooks",
      frontmatter:
        "on:\n  manual: true\nhooks:\n  pre:\n    - script: pre.js\n  post:\n    - script: post.js\n",
      scripts: {
        "pre.js": "process.exit(0);",
        "post.js": "process.exit(0);",
      },
    });

    const tracker = trackerThatThrowsFrom("factory");
    let sessions = 0;
    const out = await run(a, {
      prepareWorkspace: async () => {
        throw new Error("clone exploded");
      },
      startTracking: tracker.start,
      startSession: () => {
        sessions += 1;
        throw new Error("the body must never be reached");
      },
    });

    expect(out.record.outcome).toBe("failed");
    // `hooks` is the record's own account of what ran. A refused run has nothing in it, and the
    // hook events are absent from the stream for the same reason.
    expect(out.record.hooks ?? []).toHaveLength(0);
    expect(out.events.filter((e) => e.event === "hook-start")).toHaveLength(0);
    expect(out.record.session).toBeUndefined();
    expect(sessions).toBe(0);
    expect(tracker.calls).toEqual([]);
  });

  it("leaves the lock free for the next real run", async () => {
    const a = automation("prepare-throws-lock");
    await run(a, {
      prepareWorkspace: async () => {
        throw new Error("clone exploded");
      },
    });
    expect(readRunLock(a.stateDir, a.located.key)).toBeUndefined();
    expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
  });

  it("leaves the dispatcher's claim state exactly as it found it", async () => {
    const a = automation("prepare-throws-claim");
    // Deliberately AFTER discovery and trust, so this is the state a dispatcher would have left.
    const before = readdirSync(a.stateDir).sort();

    await run(a, {
      prepareWorkspace: async () => {
        throw new Error("clone exploded");
      },
    });

    // The record and its own directory are the only additions a refused run is allowed to make: the
    // run did not happen, so it must not claim the instant it covers and suppress catch-up.
    const after = readdirSync(a.stateDir).sort();
    expect(after.filter((n) => !before.includes(n) && n !== "runs" && n !== "locks")).toEqual([]);
  });
});

describe("a tracker that throws", () => {
  for (const call of ["factory", "start", "environment", "end"] as const) {
    it(`from ${call} leaves the run's own terminal record intact`, async () => {
      const a = automation(`tracker-${call}`);
      const tracker = trackerThatThrowsFrom(call);
      const out = await run(a, { startTracking: tracker.start });

      // The run itself did nothing wrong, so it is still `ok` — a broken chart is not a failure.
      expect(out.record.outcome).toBe("ok");
      expect(out.written).toHaveLength(1);
      expect(out.written[0]).toEqual(out.record);
      expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
    });
  }

  it("says so on the record, through the channel tracking already had", async () => {
    const a = automation("tracker-visible");
    const out = await run(a, { startTracking: trackerThatThrowsFrom("end").start });

    expect(out.record.flow?.problem).toContain("flow end");
    expect(out.record.flow?.problem).toContain("exploded");
  });

  it("from end still reaches the record, which is the case that used to erase it", async () => {
    const a = automation("tracker-end-order");
    const tracker = trackerThatThrowsFrom("end");
    const out = await run(a, { startTracking: tracker.start });

    expect(tracker.calls).toContain("next");
    expect(tracker.calls).toContain("end");
    expect(out.record.outcome).toBe("ok");
    expect(out.written).toHaveLength(1);
  });

  it("goes quiet after the first failed call, but is still asked once to close", async () => {
    const a = automation("tracker-quiet");
    const tracker = trackerThatThrowsFrom("next");
    await run(a, { startTracking: tracker.start });

    expect(tracker.calls.filter((call) => call === "next")).toHaveLength(1);
    expect(tracker.calls).not.toContain("say");
    expect(tracker.calls).not.toContain("mark");
    // What was recorded before the fault is still worth folding into the record.
    expect(tracker.calls.filter((call) => call === "end")).toHaveLength(1);
  });
});

describe("a session disposer that will not complete", () => {
  it("still releases the run lock when disposal never settles", async () => {
    const a = automation("session-dispose-hangs");
    const out = await run(a, {
      startSession: async () => ({
        file: "/sessions/fake.jsonl",
        id: "fake",
        prompt: async () => "done",
        dispose: () => new Promise<void>(() => {}),
      }),
      providerTimeoutMs: 20,
    });

    expect(out.record.outcome).toBe("ok");
    expect(out.written).toHaveLength(1);
    expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
    expect(out.problems.join(" ")).toContain("session disposal did not finish");
  });

  it("handles a late disposal rejection once without an unhandled rejection", async () => {
    const a = automation("session-dispose-late");
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const out = await run(a, {
        startSession: async () => ({
          file: "/sessions/fake.jsonl",
          id: "fake",
          prompt: async () => "done",
          dispose: () =>
            new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error("dispose exploded late")), 50);
            }),
        }),
        providerTimeoutMs: 10,
      });

      expect(out.problems.filter((p) => p.startsWith("session disposal"))).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      expect(out.problems.filter((p) => p.startsWith("session disposal"))).toHaveLength(1);
      expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("a workspace release that will not complete", () => {
  /** A handle that prepares normally and misbehaves only on the way out. */
  function handle(release: () => Promise<void>, cwd: string): WorkspaceHandle {
    return { cwd, release };
  }

  it("still releases the run lock when release REJECTS", async () => {
    const a = automation("release-rejects");
    const cwd = tempDir("pi-fault-ws-");
    const out = await run(a, {
      prepareWorkspace: async () => ({
        ok: true,
        workspace: handle(async () => {
          throw new Error("worktree removal exploded");
        }, cwd),
      }),
    });

    expect(out.record.outcome).toBe("ok");
    expect(out.written).toHaveLength(1);
    expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
    expect(out.problems.join(" ")).toContain("workspace release failed");
  });

  it("still releases the run lock when release NEVER SETTLES", async () => {
    const a = automation("release-hangs");
    const cwd = tempDir("pi-fault-ws-");
    const out = await run(a, {
      prepareWorkspace: async () => ({
        ok: true,
        // Never resolves, never rejects. Unbounded, this held the lock for as long as the process
        // lived.
        workspace: handle(() => new Promise<void>(() => {}), cwd),
      }),
      // A short bound, so the test does not sit through the production one.
      providerTimeoutMs: 50,
    });

    expect(out.record.outcome).toBe("ok");
    expect(out.written).toHaveLength(1);
    expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
    expect(out.problems.join(" ")).toContain("workspace release did not finish");
  });

  it("does not replace the run's own result with the cleanup failure", async () => {
    const a = automation("release-keeps-failure");
    const cwd = tempDir("pi-fault-ws-");
    const out = await run(a, {
      prepareWorkspace: async () => ({
        ok: true,
        workspace: handle(async () => {
          throw new Error("worktree removal exploded");
        }, cwd),
      }),
      startSession: () => {
        throw new Error("the body itself failed");
      },
    });

    // The primary failure is the body's, not the cleanup's — the record must say what the run did.
    expect(out.record.outcome).toBe("failed");
    expect(out.record.error?.message).toContain("the body itself failed");
    expect(out.written).toHaveLength(1);
    expect(out.problems.join(" ")).toContain("workspace release failed");
  });
});

describe("a notification that will not complete", () => {
  /** Failed, so `notifyOnFailed` actually reaches the sink. */
  function failingRun(over: Record<string, unknown>): Record<string, unknown> {
    return {
      ...over,
      startSession: () => {
        throw new Error("the body itself failed");
      },
    };
  }

  it("lets the run finish, and says so, when the sink NEVER SETTLES", async () => {
    const a = automation("notify-hangs");
    const out = await run(
      a,
      failingRun({
        config: { ...HOST_CONFIG, notifyOnFailed: true },
        notify: () => new Promise<void>(() => {}),
        providerTimeoutMs: 50,
      }),
    );

    expect(out.record.outcome).toBe("failed");
    expect(out.written).toHaveLength(1);
    expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
    expect(out.problems.join(" ")).toContain("notification did not finish");
  });

  it("reports a sink that rejects, rather than swallowing it", async () => {
    const a = automation("notify-rejects");
    const out = await run(
      a,
      failingRun({
        config: { ...HOST_CONFIG, notifyOnFailed: true },
        notify: async () => {
          throw new Error("toast exploded");
        },
      }),
    );

    expect(out.record.outcome).toBe("failed");
    expect(out.problems.join(" ")).toContain("notification failed");
    expect(out.problems.join(" ")).toContain("toast exploded");
  });

  it("reports a sink that throws SYNCHRONOUSLY, which never becomes a rejection on its own", async () => {
    const a = automation("notify-sync-throws");
    const out = await run(
      a,
      failingRun({
        config: { ...HOST_CONFIG, notifyOnFailed: true },
        // Not an async function: this throws on the CALL, before any promise exists, so nothing
        // downstream of `await` can catch it. Unconverted, it escapes `fire` entirely and turns a
        // finished, recorded run into an exception.
        notify: () => {
          throw new Error("toast exploded on the way in");
        },
      }),
    );

    expect(out.record.outcome).toBe("failed");
    expect(out.written).toHaveLength(1);
    expect(out.problems.join(" ")).toContain("notification failed");
    expect(out.problems.join(" ")).toContain("toast exploded on the way in");
    expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
  });

  it("survives a rejection that arrives LATE, without a second report or an unhandled rejection", async () => {
    const a = automation("notify-late");
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    try {
      const out = await run(
        a,
        failingRun({
          config: { ...HOST_CONFIG, notifyOnFailed: true },
          // Rejects well after the bound has already given up on it. Unattached, this is the
          // rejection that takes the process down after the run is over.
          notify: () =>
            new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error("toast exploded late")), 40);
            }),
          providerTimeoutMs: 10,
        }),
      );

      expect(out.record.outcome).toBe("failed");
      expect(out.problems.filter((p) => p.startsWith("notification"))).toHaveLength(1);
      expect(out.problems.join(" ")).toContain("notification did not finish");

      // Long enough for the late rejection to land.
      await new Promise((r) => setTimeout(r, 120));
      expect(unhandled).toHaveLength(0);
      // And it did not turn into a second diagnostic after the caller moved on.
      expect(out.problems.filter((p) => p.startsWith("notification"))).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("the ordinary run, unchanged", () => {
  it("records ok, emits no problem, and frees its lock", async () => {
    const a = automation("control-ok");
    const out = await run(a, {});

    expect(out.record.outcome).toBe("ok");
    expect(out.written).toHaveLength(1);
    expect(out.problems).toEqual([]);
    expect(lockIsFree(a.stateDir, a.located.key)).toBe(true);
  });
});
