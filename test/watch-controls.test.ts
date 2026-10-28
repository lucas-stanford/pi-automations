/** Pausing one watch, and turning the watcher off and on, from the list. */

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleWatch, parseArgs, type CommandDeps, type Refreshed } from "../src/commands.js";
import { DEFAULTS } from "../src/config.js";
import type { ScriptExecution } from "../src/core/contracts.js";
import { listingModel } from "../src/listing.js";
import { State, readPausedWatches } from "../src/state.js";
import { tick, type TickDeps } from "../src/tick.js";
import { Trust } from "../src/trust.js";
import type { Status, Watch } from "../src/types.js";
import { classifyWatcher, WATCHER_QUIET_MS } from "../src/ui/details.js";
import { agendaRow, automationLead, createListScreen, headerLines, triage, type GlobalAction, type InboxEntry, type ListAction, type ListData } from "../src/ui/list.js";
import { nominalFire, scheduleWords, whenWords } from "../src/ui/words.js";
import { tempDir } from "./helpers/temp.js";

const NOW = new Date("2026-10-07T22:00:00.000Z");
const FIVE: Watch = { script: "scripts/watch.js", every: "5m" };
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function watched(name = "my-pr-review", over: Partial<Status> = {}): Status {
  const root = path.resolve("/home/me/.agents/automations");
  return {
    key: `user:${root}:${name}`,
    name,
    scope: "user",
    root: { path: root, scope: "user", kind: "agents" },
    dir: path.join(root, name),
    state: "armed",
    effectiveTimeoutMs: 600_000,
    staggerSec: 0,
    nextCheck: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
    automation: { name, description: "d", enabled: true, on: { manual: true, watch: FIVE }, hooks: { pre: [], post: [] }, body: "b" },
    ...over,
  };
}

function scheduled(name = "daily-digest", over: Partial<Status> = {}): Status {
  const root = path.resolve("/home/me/.agents/automations");
  return {
    key: `user:${root}:${name}`,
    name,
    scope: "user",
    root: { path: root, scope: "user", kind: "agents" },
    dir: path.join(root, name),
    state: "armed",
    effectiveTimeoutMs: 600_000,
    staggerSec: 40,
    nextFire: "2026-10-08T16:00:40.000Z",
    automation: {
      name,
      description: "d",
      enabled: true,
      on: { manual: true, schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles", catchUp: "once" } },
      hooks: { pre: [], post: [] },
      body: "b",
    },
    ...over,
  };
}

function listData(statuses: Status[], watcher: ListData["facts"]["watcher"] = { state: "on", lastTickAt: ago(30_000) }): ListData {
  const counts = { armed: 0, off: 0, disabled: 0, invalid: 0 };
  for (const s of statuses) counts[s.state]++;
  return {
    model: listingModel(statuses, { home: path.resolve("/home/me"), projectRoots: [], now: NOW }),
    facts: { counts, running: statuses.filter((s) => s.running).length, watcher },
    now: NOW,
  };
}

describe("a paused watch in state.json", () => {
  it("is kept apart from the checks, and survives a tick that loaded the file before the pause", () => {
    const dir = tempDir("pi-pause-state-");
    const tickCopy = new State(dir);
    new State(dir).update((s) => s.pauseWatch("k", NOW));
    // The tick saves what it loaded a moment before the pause was written.
    tickCopy.recordWatch("k", { checkedAt: NOW.toISOString(), exit: 3, durationMs: 1 });
    tickCopy.save();
    expect(readPausedWatches(dir)).toEqual({ k: NOW.toISOString() });
    expect(new State(dir).watchOf("k")).toMatchObject({ exit: 3 });
  });

  it("keeps the first pause time, and says whether anything changed", () => {
    const dir = tempDir("pi-pause-again-");
    const s = new State(dir);
    expect(s.pauseWatch("k", NOW)).toBe(true);
    expect(s.pauseWatch("k", new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(s.watchPausedAt("k")).toBe(NOW.toISOString());
    expect(s.resumeWatch("k")).toBe(true);
    expect(s.resumeWatch("k")).toBe(false);
    s.save();
    expect(readPausedWatches(dir)).toEqual({});
  });

  it("is not undone by a copy that resumed something else", () => {
    const dir = tempDir("pi-pause-two-");
    const a = new State(dir);
    a.update((s) => s.pauseWatch("one", NOW));
    a.update((s) => s.pauseWatch("two", NOW));
    const stale = new State(dir);
    new State(dir).update((s) => s.resumeWatch("one"));
    stale.update((s) => s.resumeWatch("two"));
    expect(readPausedWatches(dir)).toEqual({});
  });
});

describe("the tick and a paused watch", () => {
  it("records who ran it, so a screen can tell the job from serve", async () => {
    const stateDir = tempDir("pi-tick-by-");
    await tick({
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      now: NOW,
      spawnFire: async () => ({ ok: true, pid: 1 }),
      statuses: [],
      tickedBy: "serve",
    });
    expect(new State(stateDir).lastTickBy).toBe("serve");
  });

  it("starts nothing for a watch paused while its script was running, and keeps the finding new", async () => {
    const stateDir = tempDir("pi-pause-race-");
    const s = watched();
    const spawned: string[][] = [];
    await tick({
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      now: NOW,
      spawnFire: async (args) => {
        spawned.push([...args]);
        return { ok: true, pid: 1 };
      },
      statuses: [s],
      runScript: async () => {
        // The person presses p while the script is looking.
        new State(stateDir).update((other) => other.pauseWatch(s.key, NOW));
        return { end: "exit", exit: 0, stdout: "PR 12", stderr: "", outputBytes: 5, truncated: false } as ScriptExecution;
      },
    });
    expect(spawned).toEqual([]);
    const seen = new State(stateDir).watchOf(s.key);
    expect(seen).toMatchObject({ exit: 0, said: "PR 12" });
    expect(seen?.firedFor).toBeUndefined();
    expect(readPausedWatches(stateDir)[s.key]).toBe(NOW.toISOString());
  });

  it("runs no script for a paused watch, and runs it again once resumed", async () => {
    const stateDir = tempDir("pi-pause-tick-");
    const s = watched();
    new State(stateDir).update((st) => st.pauseWatch(s.key, NOW));
    const calls: unknown[] = [];
    const deps = (): TickDeps => ({
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      now: NOW,
      spawnFire: async () => ({ ok: true, pid: 1 }),
      statuses: [s],
      runScript: async (cmd) => {
        calls.push(cmd);
        return { end: "exit", exit: 3, stdout: "", stderr: "", outputBytes: 0, truncated: false } as ScriptExecution;
      },
    });
    const summary = await tick(deps());
    expect(calls).toHaveLength(0);
    expect(summary.checked).toEqual([]);

    new State(stateDir).update((st) => st.resumeWatch(s.key));
    await tick(deps());
    expect(calls).toHaveLength(1);
  });
});

describe("watch pause and watch resume", () => {
  function deps(stateDir: string): CommandDeps {
    return {
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      now: () => NOW,
      home: path.resolve("/home/me"),
      cwd: stateDir,
      spawnFire: () => {
        throw new Error("never starts a run");
      },
    };
  }
  const refreshed = (statuses: Status[]): Refreshed => ({ statuses, byKey: new Map(), projectRoots: [] });

  it("parses the verb, and keeps a name after it", () => {
    expect(parseArgs("watch pause my-pr-review")).toMatchObject({ sub: "watch", verb: "pause", name: "my-pr-review" });
    expect(parseArgs("watch resume my-pr-review")).toMatchObject({ sub: "watch", verb: "resume", name: "my-pr-review" });
    expect(parseArgs("watch my-pr-review")).toMatchObject({ sub: "watch", name: "my-pr-review" });
    expect(parseArgs("watch my-pr-review").verb).toBeUndefined();
  });

  it("pauses, says what still works, and resumes", async () => {
    const stateDir = tempDir("pi-pause-cmd-");
    const s = watched();
    const paused = await handleWatch(deps(stateDir), refreshed([s]), "my-pr-review", "pause");
    expect(paused.exitCode ?? 0).toBe(0);
    expect(paused.lines[0]).toBe("my-pr-review: watch paused — no more checks until you resume it; running it by hand still works");
    expect(readPausedWatches(stateDir)).toEqual({ [s.key]: NOW.toISOString() });

    const again = await handleWatch(deps(stateDir), refreshed([s]), "my-pr-review", "pause");
    expect(again.lines[0]).toContain("its watch was already paused since");

    const resumed = await handleWatch(deps(stateDir), refreshed([s]), "my-pr-review", "resume");
    expect(resumed.lines[0]).toBe("my-pr-review: watch resumed — it checks at the next tick");
    expect(readPausedWatches(stateDir)).toEqual({});
  });

  it("names the schedule as still working when there is one", async () => {
    const stateDir = tempDir("pi-pause-both-");
    const both = watched("both", {
      automation: { ...(watched().automation as NonNullable<Status["automation"]>), name: "both", on: { manual: true, watch: FIVE, schedule: { cron: "0 9 * * 1-5", catchUp: "skip" } } },
    });
    const out = await handleWatch(deps(stateDir), refreshed([both]), "both", "pause");
    expect(out.lines[0]).toContain("its schedule and running it by hand still work");
  });

  it("refuses an automation without a watch, and a missing name", async () => {
    const stateDir = tempDir("pi-pause-refuse-");
    const plain = scheduled();
    expect((await handleWatch(deps(stateDir), refreshed([plain]), "daily-digest", "pause")).exitCode).toBe(2);
    expect((await handleWatch(deps(stateDir), refreshed([plain]), undefined, "pause")).lines[0]).toContain("needs a name");
  });
});

describe("the words a row uses", () => {
  it("reads a schedule the way a person says it", () => {
    expect(scheduleWords({ cron: "0 9 * * 1-5" })).toBe("weekdays 09:00");
    expect(scheduleWords({ cron: "0 8 * * MON-FRI" })).toBe("weekdays 08:00");
    expect(scheduleWords({ cron: "30 7 * * *" })).toBe("daily 07:30");
    expect(scheduleWords({ cron: "0 22 * * 0" })).toBe("Sundays 22:00");
    expect(scheduleWords({ cron: "0 9 * * 1,3,5" })).toBe("Mon, Wed, Fri 09:00");
    expect(scheduleWords({ cron: "*/15 * * * *" })).toBe("every 15 min");
    expect(scheduleWords({ cron: "5 * * * *" })).toBe("hourly at :05");
    expect(scheduleWords({ cron: "0 9 1 * *" })).toBe("cron 0 9 1 * *");
  });

  it("says tomorrow for the next calendar day, even the night the clocks change", () => {
    // Saturday 23:30 in Los Angeles, the night before clocks go forward.
    const night = new Date("2026-03-08T07:30:00.000Z");
    expect(whenWords("2026-03-08T16:00:00.000Z", night, "America/Los_Angeles")).toBe("tomorrow 09:00");
    expect(whenWords("2026-03-09T16:00:00.000Z", night, "America/Los_Angeles")).toBe("Mon 09:00");
  });

  it("shows the cron instant, not the stagger added to it", () => {
    const s = scheduled();
    // 16:00:40Z is 09:00:40 in Los Angeles: the 40 seconds are this host's stagger.
    expect(whenWords(nominalFire(s.nextFire as string, s.staggerSec), NOW, "America/Los_Angeles")).toBe("tomorrow 09:00");
    const item = triage(listData([s]), NOW).sections.flatMap((x) => x.items)[0] as InboxEntry;
    expect(agendaRow(item, NOW).when?.text).toBe("tomorrow 09:00");
  });

  it("says when a watch checks next, or that it is paused", () => {
    const ready = triage(listData([watched()]), NOW).sections.flatMap((s) => s.items)[0] as InboxEntry;
    expect(ready.section).toBe("watching");
    // The row shows its steady interval; the countdown is on its page.
    expect(agendaRow(ready, NOW).when?.text).toBe("every 5m");
    expect(automationLead(watched(), listData([watched()]), NOW).text).toContain("Its watch checks in 3 minutes, then every 5m.");
    const paused = watched("p", { nextCheck: undefined, watchPausedAt: "2026-10-07T21:55:00.000Z" });
    const d = listData([paused]);
    const item = triage(d, NOW).sections.flatMap((s) => s.items)[0] as InboxEntry;
    expect(item.section).toBe("watching");
    expect(item.kind).toBe("paused");
    expect(agendaRow(item, NOW).when).toEqual({ text: "paused · p resumes", color: "warning" });
    expect(automationLead(paused, d, NOW)).toMatchObject({ text: expect.stringMatching(/^p's watch is paused since \d\d:\d\d, so nothing starts it on its own/), color: "warning" });
  });

  it("says what waits while the watcher is off, and leaves manual-only rows alone", () => {
    const off = { state: "off" as const };
    const d = listData([watched(), scheduled()], off);
    const held = triage(d, NOW).sections.filter((s) => s.id === "coming" || s.id === "watching").flatMap((s) => s.items);
    expect(held.map((i) => `${i.section}:${i.kind}:${i.name}`)).toEqual(["coming:hold:daily-digest", "watching:hold:my-pr-review"]);
    expect(held.map((i) => agendaRow(i, NOW).when?.text)).toEqual(["on hold", "on hold"]);
    // The watcher's own page says exactly what each one misses.
    const screen = createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => d, act: () => {}, actGlobal: () => {} }, d);
    screen.handleInput("\r");
    const page = screen.render(160).join("\n");
    expect(page).toContain("its watch: no check at 15:03");
    expect(page).toContain("its schedule: no run tomorrow 09:00");
    screen.dispose();
  });

  it("says what comes next on each row, with no next line under the title", () => {
    const d = listData([scheduled(), watched()]);
    const screen = createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => d, act: () => {} }, d);
    const lines = screen.render(140);
    expect(lines.join("\n")).not.toContain("next:");
    expect(lines.find((l) => l.includes("my-pr-review"))).toMatch(/every 5m\s+my-pr-review/);
    expect(lines.join("\n")).not.toContain("in 3m");
    expect(lines.find((l) => l.includes("daily-digest"))).toMatch(/tomorrow 09:00\s+daily-digest/);
    screen.dispose();
  });
});

describe("what the watcher is doing", () => {
  const job = (installed: boolean, stale = false) => ({ installed, stale });

  it("is on while the job is installed and ticking, and stale once it goes quiet", () => {
    expect(classifyWatcher(job(true), ago(30_000), NOW)).toEqual({ state: "on", lastTickAt: ago(30_000) });
    expect(classifyWatcher(job(true), ago(WATCHER_QUIET_MS + 1000), NOW).state).toBe("stale");
    expect(classifyWatcher(job(true), undefined, NOW).state).toBe("stale");
  });

  it("is stale, and says why, when the job was registered for another install", () => {
    expect(classifyWatcher(job(true, true), ago(30_000), NOW)).toMatchObject({ state: "stale", note: expect.stringContaining("another install") });
  });

  it("is off without the job, unless serve is ticking — which w cannot stop", () => {
    expect(classifyWatcher(job(false), undefined, NOW)).toEqual({ state: "off" });
    expect(classifyWatcher(job(false), ago(WATCHER_QUIET_MS + 1000), NOW, "serve").state).toBe("off");
    expect(classifyWatcher(job(false), ago(20_000), NOW, "serve")).toMatchObject({ state: "on", note: "pa serve", controllable: false });
  });

  it("is off right after the job is stopped, though its last tick is seconds old", () => {
    // The job ticked 40s ago and has just been removed: that tick must not read as serve.
    expect(classifyWatcher(job(false), ago(40_000), NOW, "job")).toEqual({ state: "off", lastTickAt: ago(40_000) });
    // A file written before ticks were labelled reads the same way.
    expect(classifyWatcher(job(false), ago(40_000), NOW)).toEqual({ state: "off", lastTickAt: ago(40_000) });
  });

  it("puts a late watcher on the title line, with the key that restarts it", () => {
    const counts = { armed: 1, off: 0, disabled: 0, invalid: 0 };
    const lines = headerLines({ counts, running: 0, next: "Next: x in 3m", watcher: { state: "stale", lastTickAt: ago(12 * 60_000) } }, 140, undefined, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Automations\s+watcher late$/);
  });
});

describe("p and w on the list", () => {
  function data(statuses: Status[], watcher: ListData["facts"]["watcher"] = { state: "on", lastTickAt: ago(30_000) }): ListData {
    return {
      model: listingModel(statuses, { home: path.resolve("/home/me"), projectRoots: [], now: NOW }),
      facts: { counts: { armed: statuses.length, off: 0, disabled: 0, invalid: 0 }, running: 0, watcher },
      now: NOW,
    };
  }

  function harness(initial: ListData, after = initial) {
    const acted: ListAction[] = [];
    const global: GlobalAction[] = [];
    let current = initial;
    const screen = createListScreen(
      {
        tui: { requestRender: () => {} },
        close: () => {},
        reload: async () => current,
        act: (action) => {
          acted.push(action);
          current = after;
          return { tone: "success", message: `${action} done` };
        },
        actGlobal: (action) => {
          global.push(action);
          current = after;
          return { tone: "success", message: `${action} done` };
        },
      },
      initial,
    );
    return { screen, acted, global };
  }

  it("p pauses a running watch and resumes a paused one, deciding from a fresh read", async () => {
    const h = harness(data([watched()]));
    h.screen.handleInput("p");
    await vi.waitFor(() => expect(h.acted).toEqual(["pause-watch"]));

    const paused = harness(data([watched("my-pr-review", { watchPausedAt: ago(60_000), nextCheck: undefined })]));
    paused.screen.handleInput("p");
    await vi.waitFor(() => expect(paused.acted).toEqual(["resume-watch"]));
    h.screen.dispose();
    paused.screen.dispose();
  });

  it("p resumes a paused watch on a repository automation that is off, as its details say", async () => {
    const repoRoot = path.resolve("/repo/.agents/automations");
    const off = watched("proj", {
      key: `repository:${repoRoot}:proj`,
      scope: "repository",
      root: { path: repoRoot, scope: "repository", kind: "agents" },
      dir: path.join(repoRoot, "proj"),
      state: "off",
      reason: "not armed",
      watchPausedAt: ago(60_000),
      nextCheck: undefined,
    });
    const d = data([off]);
    d.model = listingModel([off], { home: path.resolve("/home/me"), projectRoots: [path.resolve("/repo")], now: NOW });
    const h = harness(d);
    h.screen.handleInput("\r");
    expect(h.screen.render(140).join("\n")).toContain("p      resume its watch");
    h.screen.handleInput("\u001b");
    h.screen.handleInput("p");
    await vi.waitFor(() => expect(h.acted).toEqual(["resume-watch"]));
    h.screen.dispose();
  });

  it("p does nothing for an automation without a watch", async () => {
    const h = harness(data([scheduled()]));
    h.screen.handleInput("p");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.acted).toEqual([]);
    h.screen.dispose();
  });

  it("w asks before stopping the watcher, names what stops, and esc keeps it on", async () => {
    const h = harness(data([scheduled(), watched()]));
    h.screen.handleInput("w");
    const asking = h.screen.render(160).join("\n");
    expect(asking).toContain("Stop the watcher?");
    expect(asking).toContain("daily-digest  its schedule: no run tomorrow 09:00");
    expect(asking).toContain("my-pr-review  its watch: no check at 15:03");
    expect(asking).toContain("runs by hand");
    expect(h.global).toEqual([]);

    h.screen.handleInput("\u001b");
    expect(h.screen.render(160).join("\n")).not.toContain("Stop the watcher?");
    expect(h.global).toEqual([]);

    h.screen.handleInput("w");
    h.screen.handleInput("y");
    await vi.waitFor(() => expect(h.global).toEqual(["watcher-stop"]));
    h.screen.dispose();
  });

  it("w starts a stopped watcher at once, and says it is waiting for the first tick meanwhile", async () => {
    let finish: (v: { tone: "success"; message: string }) => void = () => {};
    const global: GlobalAction[] = [];
    const d = data([watched()], { state: "off" });
    const screen = createListScreen(
      {
        tui: { requestRender: () => {} },
        close: () => {},
        reload: async () => d,
        act: () => {},
        actGlobal: (action) => {
          global.push(action);
          return new Promise((r) => {
            finish = r;
          });
        },
      },
      d,
    );
    expect(screen.render(120)[0]).toMatch(/watcher off$/);
    expect(screen.render(120).join("\n")).toContain("      w  start it");
    screen.handleInput("w");
    expect(global).toEqual(["watcher-start"]);
    expect(screen.render(120).join("\n")).toContain("Starting the watcher — waiting for its first tick");
    finish({ tone: "success", message: "Watcher on" });
    await vi.waitFor(() => expect(screen.render(120).join("\n")).toContain("Watcher on"));
    screen.dispose();
  });

  it("w restarts a stale watcher without asking, and leaves serve alone", async () => {
    const stale = harness(data([watched()], { state: "stale", lastTickAt: ago(12 * 60_000) }));
    expect(stale.screen.render(140).join("\n")).toContain("      w  restart it");
    stale.screen.handleInput("w");
    await vi.waitFor(() => expect(stale.global).toEqual(["watcher-start"]));
    stale.screen.dispose();

    const serve = harness(data([watched()], { state: "on", lastTickAt: ago(20_000), note: "pa serve", controllable: false }));
    expect(serve.screen.render(140).join("\n")).not.toContain("w stop the watcher");
    serve.screen.handleInput("w");
    expect(serve.global).toEqual([]);
    expect(serve.screen.render(140).join("\n")).toContain("w · the ticks come from pa serve: stop it where it runs");
    serve.screen.dispose();
  });

  it("w does nothing where the host cannot start or stop the watcher", () => {
    const d = data([watched()]);
    const screen = createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => d, act: () => {} }, d);
    screen.handleInput("w");
    expect(screen.render(160).join("\n")).not.toContain("Stop the watcher?");
    expect(screen.render(160).join("\n")).not.toContain("w stop watcher");
    screen.dispose();
  });
});
