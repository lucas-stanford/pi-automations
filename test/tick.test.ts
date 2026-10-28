import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { decideTick, runTick, tick, type TickDeps } from "../src/tick.js";
import { resolveModel, type ModelRuntimeLike } from "../src/model.js";
import { readRecords } from "../src/records.js";
import { acquireRunLock, runLockInfo } from "../src/locks.js";
import { State } from "../src/state.js";
import { Trust } from "../src/trust.js";
import { armUserRoot } from "./helpers/arm.js";
import type { Root, Schedule, Status } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const GRACE = 10 * 60_000; // 10m
const WINDOW = 7 * 86_400_000; // 7d

const hourly: Schedule = { cron: "0 * * * *", catchUp: "skip", timezone: "UTC" };
const hourlyOnce: Schedule = { ...hourly, catchUp: "once" };
const daily: Schedule = { cron: "0 7 * * *", catchUp: "skip", timezone: "UTC" };

function at(iso: string): Date {
  return new Date(iso);
}

function decide(over: Partial<Parameters<typeof decideTick>[0]>) {
  return decideTick({
    schedule: hourly,
    now: at("2026-09-17T12:00:30.000Z"),
    staggerSec: 0,
    graceMs: GRACE,
    catchUpWindowMs: WINDOW,
    ...over,
  });
}

describe("decideTick", () => {
  it("fires on time, not late", () => {
    const d = decide({ lastTickAt: at("2026-09-17T11:59:00.000Z") });
    expect(d.action).toBe("fire");
    expect(d.late).toBe(false);
    expect(d.scheduledFor?.toISOString()).toBe("2026-09-17T12:00:00.000Z");
    expect(d.missedCount).toBe(0);
  });

  it("does nothing when no tick is due", () => {
    const d = decide({
      now: at("2026-09-17T12:30:00.000Z"),
      lastTickAt: at("2026-09-17T12:29:00.000Z"),
    });
    expect(d.action).toBe("none");
  });

  it("holds a fire back until the stagger offset has elapsed, without losing it", () => {
    // Due at 12:00:00 with a 47-second offset; at 12:00:30 the offset has not elapsed.
    const early = decide({
      now: at("2026-09-17T12:00:30.000Z"),
      lastTickAt: at("2026-09-17T11:59:00.000Z"),
      staggerSec: 47,
    });
    expect(early.action).toBe("wait");
    // `wait`, not `none`: the caller has to keep this instant in the next tick's window.
    expect(early.scheduledFor?.toISOString()).toBe("2026-09-17T12:00:00.000Z");

    const ready = decide({
      now: at("2026-09-17T12:00:48.000Z"),
      lastTickAt: at("2026-09-17T11:59:00.000Z"),
      staggerSec: 47,
    });
    expect(ready.action).toBe("fire");
    expect(ready.late).toBe(false);
    // The record says the CRON instant, not the staggered one.
    expect(ready.scheduledFor?.toISOString()).toBe("2026-09-17T12:00:00.000Z");
  });

  it("still counts as on time at the very end of the grace period", () => {
    const d = decide({
      now: at("2026-09-17T12:10:00.000Z"),
      lastTickAt: at("2026-09-17T11:59:00.000Z"),
    });
    expect(d.action).toBe("fire");
    expect(d.late).toBe(false);
  });

  it("records a missed tick past the grace window when catch-up is skip", () => {
    const d = decide({
      now: at("2026-09-17T12:11:00.000Z"),
      lastTickAt: at("2026-09-17T11:59:00.000Z"),
    });
    expect(d.action).toBe("missed");
    expect(d.missedUntil?.toISOString()).toBe("2026-09-17T12:00:00.000Z");
    // The instant being reported is itself missed, so the count includes it.
    expect(d.missedCount).toBe(1);
  });

  it("runs ONE late instance past the grace window when catch-up is once", () => {
    const d = decide({
      schedule: { ...daily, catchUp: "once" },
      now: at("2026-09-17T09:14:00.000Z"),
      lastTickAt: at("2026-09-17T06:00:00.000Z"),
    });
    expect(d.action).toBe("fire");
    expect(d.late).toBe(true);
    expect(d.scheduledFor?.toISOString()).toBe("2026-09-17T07:00:00.000Z");
  });

  it("collapses several missed ticks into one fire plus a count", () => {
    // Four hourly ticks were due; only the most recent is run, the older three are recorded.
    const d = decide({
      schedule: hourlyOnce,
      now: at("2026-09-17T12:05:00.000Z"),
      lastTickAt: at("2026-09-17T08:30:00.000Z"),
    });
    expect(d.action).toBe("fire");
    expect(d.scheduledFor?.toISOString()).toBe("2026-09-17T12:00:00.000Z");
    expect(d.missedCount).toBe(3);
  });

  it("clamps a long outage to the catch-up window rather than reaching back for ever", () => {
    // Away for two weeks with a 7-day window.
    const now = at("2026-09-30T09:00:00.000Z");
    const d = decide({
      schedule: { ...daily, catchUp: "once" },
      now,
      lastTickAt: at("2026-09-17T06:00:00.000Z"),
      catchUpWindowMs: WINDOW,
    });

    expect(d.action).toBe("fire");
    expect(d.late).toBe(true);
    const scheduled = d.scheduledFor as Date;
    expect(now.getTime() - scheduled.getTime()).toBeLessThanOrEqual(WINDOW);
    expect(scheduled.toISOString()).toBe("2026-09-30T07:00:00.000Z");
    // Six older daily instants inside the window are recorded as missed, not run.
    expect(d.missedCount).toBe(6);
  });

  it("refuses a late run when the next regular tick is already about to fire", () => {
    // Missed 12:00, it is now 12:55, and 13:00 is five minutes away. Running a late instance now
    // would be a duplicate wearing a different hat.
    const d = decide({
      schedule: hourlyOnce,
      now: at("2026-09-17T12:55:00.000Z"),
      lastTickAt: at("2026-09-17T11:30:00.000Z"),
    });
    expect(d.action).toBe("missed");
  });

  it("does nothing when this instant is already claimed", () => {
    const d = decide({
      lastTickAt: at("2026-09-17T11:59:00.000Z"),
      claimedIso: "2026-09-17T12:00:00.000Z",
    });
    expect(d.action).toBe("none");
  });

  it("fires the next instant after a claim", () => {
    const d = decide({
      now: at("2026-09-17T13:00:30.000Z"),
      claimedIso: "2026-09-17T12:00:00.000Z",
    });
    expect(d.action).toBe("fire");
    expect(d.scheduledFor?.toISOString()).toBe("2026-09-17T13:00:00.000Z");
  });

  it("does not walk a month of instants after a long outage", () => {
    // Without the catch-up horizon this would materialise thousands of dates.
    const d = decide({
      schedule: hourlyOnce,
      now: at("2026-09-17T12:05:00.000Z"),
      lastTickAt: at("2026-01-01T00:00:00.000Z"),
    });
    expect(d.missedCount).toBeLessThanOrEqual(7 * 24);
  });

  it("handles a first ever tick, with no lastTickAt and no claim", () => {
    const d = decide({ now: at("2026-09-17T12:00:30.000Z") });
    expect(d.action).toBe("fire");
  });
});

describe("tick", () => {
  function armedStatus(key: string, schedule: Schedule, over: Partial<Status> = {}): Status {
    return {
      key,
      name: key.split(":").pop() as string,
      scope: "user",
      root: { path: "/r", scope: "user", kind: "agents" },
      dir: `/r/${key.split(":").pop()}`,
      state: "armed",
      effectiveTimeoutMs: 600_000,
      staggerSec: 0,
      automation: {
        name: key.split(":").pop() as string,
        description: "d",
        enabled: true,
        on: { schedule, manual: false },
        hooks: { pre: [], post: [] },
        body: "b",
      },
      ...over,
    };
  }

  function makeDeps(dir: string, statuses: Status[], now: Date) {
    const spawned: string[][] = [];
    const deps: TickDeps = {
      config: DEFAULTS,
      stateDir: dir,
      trust: new Trust(dir),
      state: new State(dir),
      now,
      spawnFire: async (args) => {
        spawned.push([...args]);
        return { ok: true, pid: 4242 };
      },
      statuses,
    };
    return { deps, spawned };
  }

  it("claims before it spawns, so a crash between the two cannot double-fire", async () => {
    const dir = tempDir("pi-tick-claim-");
    const key = "user:/r:a";
    const { deps, spawned } = makeDeps(
      dir,
      [armedStatus(key, hourly)],
      at("2026-09-17T12:00:30.000Z"),
    );
    deps.state.lastTickAt = "2026-09-17T11:59:00.000Z";

    await tick(deps);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.[0]).toBe(key);
    // The claim is on disk, not just in memory.
    expect(new State(dir).claimOf(key)).toBe("2026-09-17T12:00:00.000Z");
  });

  it("does not fire the same instant twice", async () => {
    const dir = tempDir("pi-tick-twice-");
    const key = "user:/r:a";
    const now = at("2026-09-17T12:00:30.000Z");

    const first = makeDeps(dir, [armedStatus(key, hourly)], now);
    first.deps.state.lastTickAt = "2026-09-17T11:59:00.000Z";
    await tick(first.deps);
    expect(first.spawned).toHaveLength(1);

    // A second tick arrives in the same minute — the claim stops it.
    const second = makeDeps(dir, [armedStatus(key, hourly)], now);
    await tick(second.deps);
    expect(second.spawned).toHaveLength(0);
  });

  it("records skipped rather than queueing when a run is still going", async () => {
    const dir = tempDir("pi-tick-running-");
    const key = "user:/r:a";
    // Started five minutes ago and well inside its budget, so the sweep leaves it alone — the point
    // of this test is contention, not staleness.
    acquireRunLock(
      dir,
      runLockInfo({
        key,
        runId: "in-flight",
        timeoutMs: 600_000,
        postHooks: 0,
        trigger: "schedule",
        now: at("2026-09-17T11:55:00.000Z"),
      }),
    );

    const { deps, spawned } = makeDeps(
      dir,
      [armedStatus(key, hourly)],
      at("2026-09-17T12:00:30.000Z"),
    );
    deps.state.lastTickAt = "2026-09-17T11:59:00.000Z";

    const summary = await tick(deps);

    expect(spawned).toHaveLength(0);
    expect(summary.skipped).toEqual([key]);
    const records = readRecords(dir, key);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "skipped" });
    expect(records[0]?.reason).toMatch(/^still running since /);
  });

  it("writes one missed record with a count, not one per missed tick", async () => {
    const dir = tempDir("pi-tick-missed-");
    const key = "user:/r:a";
    const { deps, spawned } = makeDeps(
      dir,
      [armedStatus(key, hourly)],
      at("2026-09-17T12:30:00.000Z"),
    );
    deps.state.lastTickAt = "2026-09-17T08:30:00.000Z";

    const summary = await tick(deps);

    expect(spawned).toHaveLength(0);
    expect(summary.missed).toEqual([key]);
    const records = readRecords(dir, key);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "missed", reason: "host unavailable" });
    expect(records[0]?.count).toBe(4);
  });

  it("marks a late catch-up run and passes --late to the fire", async () => {
    const dir = tempDir("pi-tick-late-");
    const key = "user:/r:a";
    const { deps, spawned } = makeDeps(
      dir,
      [armedStatus(key, { ...daily, catchUp: "once" })],
      at("2026-09-17T09:14:00.000Z"),
    );
    deps.state.lastTickAt = "2026-09-17T06:00:00.000Z";

    await tick(deps);

    expect(spawned[0]).toEqual([
      key,
      "--scheduled-for",
      "2026-09-17T07:00:00.000Z",
      "--late",
    ]);
  });

  it("ignores automations that are not armed or have no schedule", async () => {
    const dir = tempDir("pi-tick-ignore-");
    const now = at("2026-09-17T12:00:30.000Z");
    const statuses: Status[] = [
      armedStatus("user:/r:off", hourly, { state: "off" }),
      armedStatus("user:/r:disabled", hourly, { state: "disabled" }),
      armedStatus("user:/r:invalid", hourly, { state: "invalid" }),
      {
        ...armedStatus("user:/r:manual", hourly),
        automation: {
          name: "manual",
          description: "d",
          enabled: true,
          on: { manual: true },
          hooks: { pre: [], post: [] },
          body: "b",
        },
      },
    ];

    const { deps, spawned } = makeDeps(dir, statuses, now);
    deps.state.lastTickAt = "2026-09-17T11:59:00.000Z";

    const summary = await tick(deps);
    expect(spawned).toHaveLength(0);
    expect(summary.considered).toBe(0);
  });

  it("sweeps an abandoned run lock and records it", async () => {
    const dir = tempDir("pi-tick-sweep-");
    const key = "user:/r:a";
    acquireRunLock(
      dir,
      runLockInfo({
        key,
        runId: "dead",
        timeoutMs: 1000,
        postHooks: 0,
        trigger: "schedule",
        now: at("2026-09-16T00:00:00.000Z"),
        pid: 2 ** 30,
      }),
    );

    const { deps } = makeDeps(dir, [], at("2026-09-17T12:00:30.000Z"));
    const summary = await tick(deps);

    expect(summary.swept).toEqual([key]);
    expect(readRecords(dir, key)[0]).toMatchObject({
      outcome: "aborted",
      reason: "host stopped",
    });
  });

  it("advances lastTickAt even when nothing was due", async () => {
    const dir = tempDir("pi-tick-advance-");
    const now = at("2026-09-17T12:30:00.000Z");
    const { deps } = makeDeps(dir, [], now);
    await tick(deps);
    expect(new State(dir).lastTickAt).toBe(now.toISOString());
  });

  it("does NOT advance lastTickAt past an instant held back for its stagger", async () => {
    // The bug this pins, found on a real host: a tick runs a couple of seconds past the minute, so
    // the newest due instant is younger than the automation's offset and is deferred.
    const dir = tempDir("pi-tick-wait-");
    const key = "user:/r:a";
    const status = armedStatus(key, { cron: "* * * * *", catchUp: "skip", timezone: "UTC" });
    status.staggerSec = 20;

    const { deps, spawned } = makeDeps(dir, [status], at("2026-09-17T12:00:02.000Z"));
    deps.state.lastTickAt = "2026-09-17T11:59:02.000Z";

    const first = await tick(deps);
    expect(first.waiting).toEqual([key]);
    expect(spawned).toHaveLength(0);
    // Rewound to just before the deferred instant, not forward to now.
    expect(Date.parse(new State(dir).lastTickAt as string)).toBe(
      Date.parse("2026-09-17T12:00:00.000Z") - 1,
    );
  });

  it("fires the newest READY instant, not the newest due one", async () => {
    // The defect this pins, found by running the real scheduler: with a per-minute schedule and a
    // tick landing two seconds past the minute, the newest due instant is always younger than the
    // stagger offset.
    const dir = tempDir("pi-tick-perminute-");
    const key = "user:/r:a";
    const status = armedStatus(key, { cron: "* * * * *", catchUp: "skip", timezone: "UTC" });
    status.staggerSec = 20;

    // 12:00:02 — only 12:00:00 is due and it is 2s old, so nothing is ready yet.
    const t1 = makeDeps(dir, [status], at("2026-09-17T12:00:02.000Z"));
    t1.deps.state.lastTickAt = "2026-09-17T11:59:02.000Z";
    const s1 = await tick(t1.deps);
    expect(s1.waiting).toEqual([key]);
    expect(t1.spawned).toHaveLength(0);

    // 12:01:02 — 12:00:00 is now 62s old and ready; 12:01:00 is 2s old and still holding.
    const t2 = makeDeps(dir, [status], at("2026-09-17T12:01:02.000Z"));
    const s2 = await tick(t2.deps);
    expect(t2.spawned).toHaveLength(1);
    expect(t2.spawned[0]).toEqual([key, "--scheduled-for", "2026-09-17T12:00:00.000Z"]);
    // The instant still holding is kept for the next tick rather than being skipped over.
    expect(Date.parse(new State(dir).lastTickAt as string)).toBe(
      Date.parse("2026-09-17T12:01:00.000Z") - 1,
    );
    expect(s2.fired).toEqual([key]);

    // 12:02:02 — the previously held instant is ready and fires in its turn.
    const t3 = makeDeps(dir, [status], at("2026-09-17T12:02:02.000Z"));
    await tick(t3.deps);
    expect(t3.spawned[0]).toEqual([key, "--scheduled-for", "2026-09-17T12:01:00.000Z"]);
  });

  it("keeps firing a per-minute automation tick after tick", async () => {
    // A minute-by-minute schedule must produce a run per minute, not stall after the first.
    const dir = tempDir("pi-tick-sustained-");
    const key = "user:/r:a";
    const status = armedStatus(key, { cron: "* * * * *", catchUp: "skip", timezone: "UTC" });
    status.staggerSec = 20;

    let fires = 0;
    for (let minute = 0; minute < 6; minute++) {
      const now = at(`2026-09-17T12:${String(minute).padStart(2, "0")}:02.000Z`);
      const t = makeDeps(dir, [status], now);
      if (minute === 0) t.deps.state.lastTickAt = "2026-09-17T11:59:02.000Z";
      await tick(t.deps);
      fires += t.spawned.length;
    }

    // Six ticks, one warm-up while the first instant is still holding, then one fire per tick.
    expect(fires).toBe(5);
  });
});

describe("runTick — the model resolver is composed, not constructed", () => {
  function automationRoot(name: string, frontmatter: string, stateDir: string): Root[] {
    const home = tempDir("pi-tick-compose-");
    const root = path.join(home, "automations");
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "AUTOMATION.md"),
      `---\nname: ${name}\ndescription: A test automation.\n${frontmatter}---\n\nDo the thing.\n`,
    );
    armUserRoot(root, stateDir);
    // Returned as the explicit discovery root, so no call below ever builds one inline: the
    // isolation scan reads the nearest enclosing object literal, and an inline `{ path: … }` in the
    // arguments would hide the `roots:` it is checking for.
    return [{ path: root, scope: "user", kind: "agents" }];
  }

  const catalog: ModelRuntimeLike = {
    providers: () => ["anthropic"],
    getModel: (provider, id) => ({ id, provider }),
    checkAuth: async () => true,
    defaultModel: () => ({
      provider: "anthropic",
      id: "default",
      display: "anthropic/default",
      raw: {},
    }),
  };

  it("asks for a resolver once per tick, and uses it", async () => {
    const dir = tempDir("pi-tick-state-");
    const roots = automationRoot(
      "composed",
      'model: anthropic/claude-sonnet-4-5\non:\n  schedule:\n    cron: "0 7 * * *"\n    timezone: UTC\n  manual: true\n',
      dir,
    );
    const asked: Array<string | undefined> = [];
    const fired: string[][] = [];
    let made = 0;

    const summary = await runTick({
      stateDir: dir,
      now: at("2026-09-17T12:00:30.000Z"),
      roots,
      spawnFire: async (args) => {
        fired.push([...args]);
        return { ok: true, pid: 4242 };
      },
      modelResolver: async () => {
        made++;
        return (spec) => {
          asked.push(spec);
          return resolveModel(spec, catalog);
        };
      },
    });

    expect(made).toBe(1);
    expect(asked).toEqual(["anthropic/claude-sonnet-4-5"]);
    // Resolution succeeded, so the automation is armed and was considered for this tick.
    expect(summary?.considered).toBe(1);
    // 12:00 is not 07:00, and there is no previous tick to catch up from.
    expect(fired).toEqual([]);
  });

  it("ticks without any resolver at all", async () => {
    const dir = tempDir("pi-tick-state-none-");
    const roots = automationRoot(
      "unresolved",
      'model: anthropic/claude-sonnet-4-5\non:\n  schedule:\n    cron: "0 7 * * *"\n    timezone: UTC\n  manual: true\n',
      dir,
    );

    const summary = await runTick({
      stateDir: dir,
      now: at("2026-09-17T12:00:30.000Z"),
      roots,
      spawnFire: async () => ({ ok: true, pid: 4242 }),
    });

    // The documented degradation: no resolver means no model re-check, and the automation is still
    // armed and still considered — `fire()` re-checks the model, so a broken one still cannot run.
    expect(summary?.considered).toBe(1);
  });

  it("refuses to count a fire it had no way to start", async () => {
    const dir = tempDir("pi-tick-state-notransport-");
    const roots = automationRoot(
      "due-now",
      'model: anthropic/claude-sonnet-4-5\non:\n  schedule:\n    cron: "* * * * *"\n    timezone: UTC\n  manual: true\n',
      dir,
    );

    // The same deterministic shape the per-minute scheduling test uses: a tick two minutes after
    // the last one, so an instant is genuinely ready rather than merely due.
    const seed = new State(dir);
    seed.lastTickAt = "2026-09-17T11:59:02.000Z";
    seed.save();

    // A TypeScript caller cannot get here at all — proven against the real exported contract in
    // `tick-composition`. A JavaScript one can, and it is REFUSED before any claim: whether a
    // transport is callable is knowable in advance, so this is a host fault and not a run outcome.
    await expect(
      runTick({
        stateDir: dir,
        now: at("2026-09-17T12:01:02.000Z"),
        roots,
        modelResolver: async () => (spec) => resolveModel(spec, catalog),
      } as unknown as Parameters<typeof runTick>[0]),
    ).rejects.toThrow(/composed no worker transport/);

    // Nothing consumed. This is the property that regressed: classifying the absent transport as
    // post-launch uncertainty kept the claim, so catch-up never came back for the instant.
    const after = new State(dir);
    // The whole claim map, not one key: nothing at all may be consumed by a refused tick.
    expect(Object.keys((after as unknown as { claimed?: Record<string, string> }).claimed ?? {})).toEqual([]);
    expect(after.lastTickAt).toBe(seed.lastTickAt);
  });

  it("is silent about a transport it never needed", async () => {
    const dir = tempDir("pi-tick-state-nothingdue-");
    const roots = automationRoot(
      "not-due",
      'model: anthropic/claude-sonnet-4-5\non:\n  schedule:\n    cron: "0 7 * * *"\n    timezone: UTC\n  manual: true\n',
      dir,
    );

    // Nothing is due, so there is nothing to start and nothing to complain about. The refusal lands
    // at the point of USE, which is the only moment the fault is actually true.
    const summary = await runTick({
      stateDir: dir,
      now: at("2026-09-17T12:00:30.000Z"),
      roots,
    });
    expect(summary?.considered).toBe(1);
    expect(summary?.fired).toEqual([]);
  });

  it("discovers from the host's roots it was handed, not the process home", async () => {
    const dir = tempDir("pi-tick-hostroots-");
    const home = tempDir("pi-tick-hosthome-");
    const agentDir = path.join(home, ".agents");
    mkdirSync(path.join(agentDir, "automations", "from-host"), { recursive: true });
    writeFileSync(
      path.join(agentDir, "automations", "from-host", "AUTOMATION.md"),
      '---\nname: from-host\ndescription: A test automation.\nmodel: anthropic/claude-sonnet-4-5\non:\n  schedule:\n    cron: "* * * * *"\n    timezone: UTC\n  manual: true\n---\n\nDo the thing.\n',
    );

    armUserRoot(path.join(agentDir, "automations"), dir);

    // Deterministic per-minute shape: a tick two minutes after the last one, so an instant is
    // genuinely READY rather than merely due.
    const seed = new State(dir);
    seed.lastTickAt = "2026-09-17T11:59:02.000Z";
    seed.save();

    const fired: string[][] = [];
    // Hoisted, not inline. `hostWithoutRoots` finds the nearest enclosing `{` before `spawnFire:`,
    // so an inline `host: { … }` would hide the very `host` the scan is looking for.
    const host = { home, agentDir };

    await runTick({
      stateDir: dir,
      now: at("2026-09-17T12:01:02.000Z"),
      host,
      spawnFire: async (args) => {
        fired.push([...args]);
        return { ok: true, pid: 4242 };
      },
      modelResolver: async () => (spec) => resolveModel(spec, catalog),
    });

    // The NAME, not a count. A count would be satisfied by whatever the person running this happens
    // to have armed in their real home, which is exactly the discovery leak this asserts against —
    // and it would pass by coincidence on a machine with one automation.
    expect(fired.map((a) => a[0])).toEqual([expect.stringContaining("from-host")]);
  });

  it("never starts a user automation nobody has armed", async () => {
    const dir = tempDir("pi-tick-unarmed-");
    // Armed in some other state directory, so this one has no consent for it.
    const roots = automationRoot(
      "unarmed",
      'on:\n  schedule:\n    cron: "* * * * *"\n    timezone: UTC\n  manual: true\n',
      tempDir("pi-tick-unarmed-elsewhere-"),
    );
    const seed = new State(dir);
    seed.lastTickAt = "2026-09-17T11:59:02.000Z";
    seed.save();

    const fired: string[][] = [];
    const summary = await runTick({
      stateDir: dir,
      now: at("2026-09-17T12:01:02.000Z"),
      roots,
      spawnFire: async (args) => {
        fired.push([...args]);
        return { ok: true, pid: 4242 };
      },
    });

    expect(fired).toEqual([]);
    expect(summary?.considered).toBe(0);
  });
});
