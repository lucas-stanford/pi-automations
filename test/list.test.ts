/** The shared listing model and the list screen. */

import { describe, expect, it, vi } from "vitest";

import { listingModel, measure, renderListing, type Row } from "../src/listing.js";
import {
  actionForToggle,
  actionsFor,
  agendaRow,
  automationLead,
  cardFor,
  createListScreen,
  headerLines,
  triage,
  WATCHER_KEY,
  type InboxEntry,
  type ListAction,
  type ListData,
} from "../src/ui/list.js";
import { visibleWidth } from "../src/ui/width.js";
import type { AutomationState, Root, Status } from "../src/types.js";

const NOW = new Date("2026-09-17T10:00:00.000Z");

/** Let every pending promise settle. A microtask flush is not enough for a chained .then(). */
const settle = () => new Promise((r) => setTimeout(r, 0));
const HOME = "/home/me";

function root(p: string, scope: "user" | "repository"): Root {
  return { path: p, scope, kind: "agents" };
}

function status(over: Partial<Status> & { name: string }): Status {
  const scope = over.scope ?? "user";
  const r = over.root ?? root(scope === "user" ? `${HOME}/.agents/automations` : "/repo/.agents/automations", scope);
  return {
    key: `${scope}:${r.path}:${over.name}`,
    scope,
    root: r,
    dir: `${r.path}/${over.name}`,
    state: "armed",
    effectiveTimeoutMs: 600_000,
    staggerSec: 0,
    ...over,
  } as Status;
}

const USER_ARMED = status({ name: "daily-briefing", state: "armed" });
const USER_DISABLED = status({ name: "quiet-one", state: "disabled" });
const PROJECT_OFF = status({
  name: "repo-thing",
  scope: "repository",
  state: "off",
  reason: "repository automations are off until you arm them",
});
const INVALID = status({ name: "broken", state: "invalid", reason: "unknown field: retry" });

describe("listingModel", () => {
  const opts = { home: HOME, projectRoots: ["/repo"], now: NOW };

  it("groups by scope and never flattens into a scope column", () => {
    const m = listingModel([USER_ARMED, PROJECT_OFF], opts);
    expect(m.groups.map((g) => g.kind)).toEqual(["user", "project"]);
    expect(m.groups[0]?.title).toContain("USER");
    expect(m.groups[0]?.title).toContain("~/.agents/automations");
    expect(m.groups[1]?.title).toContain("REPOSITORY");
    expect(m.separator).toBe(true);
  });

  it("has no repository group at all outside a repository", () => {
    const m = listingModel([USER_ARMED], { ...opts, projectRoots: [] });
    expect(m.groups).toHaveLength(1);
    expect(m.separator).toBe(false);
  });

  it("orders armed, off, disabled, invalid, then alphabetically", () => {
    const rows = listingModel(
      [INVALID, USER_DISABLED, status({ name: "zeta" }), status({ name: "alpha" })],
      { ...opts, projectRoots: [] },
    ).groups[0]?.rows;
    expect(rows?.map((r) => r.name)).toEqual(["alpha", "zeta", "quiet-one", "broken"]);
  });

  it("carries the Status on every row, so an action can never hit the wrong one", () => {
    const m = listingModel([USER_ARMED], { ...opts, projectRoots: [] });
    expect(m.groups[0]?.rows[0]?.status).toBe(USER_ARMED);
  });

  it("puts a reason only on the states that need explaining", () => {
    const m = listingModel([USER_ARMED, INVALID, PROJECT_OFF], opts);
    const byName = new Map(m.groups.flatMap((g) => g.rows).map((r) => [r.name, r]));
    expect(byName.get("daily-briefing")?.reason).toBeUndefined();
    expect(byName.get("broken")?.reason).toBe("unknown field: retry");
    expect(byName.get("repo-thing")?.reason).toContain("off until you arm");
  });

  it("offers an empty repository group a way forward", () => {
    const m = listingModel([USER_ARMED], opts);
    const project = m.groups.find((g) => g.kind === "project");
    expect(project?.rows).toEqual([]);
    expect(project?.empty).toContain("AUTOMATION.md");
  });

  it("decorates rows through the caller, so listing.ts still reads no files", () => {
    const m = listingModel([USER_ARMED], {
      ...opts,
      projectRoots: [],
      decorate: (row) => {
        row.sparkline = "▇▇▁";
        row.summary = "2 ok · 1 skipped";
      },
    });
    expect(m.groups[0]?.rows[0]?.sparkline).toBe("▇▇▁");
  });
});

describe("renderListing still consumes the model unchanged", () => {
  it("produces the same grouped plain text", () => {
    const lines = renderListing([USER_ARMED, PROJECT_OFF], {
      home: HOME,
      projectRoots: ["/repo"],
      now: NOW,
    });
    const text = lines.join("\n");
    expect(text).toContain("NAME");
    expect(text).toContain("USER · ~/.agents/automations");
    expect(text).toContain("REPOSITORY ·");
    expect(text).toContain("daily-briefing");
    expect(text).toContain("repo-thing");
    // The plain listing reads no records, so no sparkline column appears.
    expect(text).not.toContain("RUNS");
  });
});

describe("measure — the drop order", () => {
  function rows(spark = false): Row[] {
    const r = listingModel([USER_ARMED], {
      home: HOME,
      projectRoots: [],
      now: NOW,
      ...(spark ? { decorate: (row: Row) => (row.sparkline = "▇▇▇▇▇▇▇") } : {}),
    });
    return r.groups[0]?.rows ?? [];
  }

  it("shows every column when there is room", () => {
    const cols = measure(rows(true), 120);
    expect(cols.showHooks).toBe(true);
    expect(cols.showSparkline).toBe(true);
    expect(cols.showSchedule).toBe(true);
  });

  it("drops HOOKS first, then the sparkline, then SCHEDULE", () => {
    const r = rows(true);
    const wide = measure(r, 120);
    expect([wide.showHooks, wide.showSparkline, wide.showSchedule]).toEqual([true, true, true]);

    const noHooks = measure(r, 72);
    expect([noHooks.showHooks, noHooks.showSparkline, noHooks.showSchedule]).toEqual([
      false,
      true,
      true,
    ]);

    const noSpark = measure(r, 64);
    expect([noSpark.showHooks, noSpark.showSparkline, noSpark.showSchedule]).toEqual([
      false,
      false,
      true,
    ]);

    const bare = measure(r, 40);
    expect([bare.showHooks, bare.showSparkline, bare.showSchedule]).toEqual([false, false, false]);
  });

  it("never claims a sparkline column when no row has one", () => {
    expect(measure(rows(false), 200).showSparkline).toBe(false);
  });

  it("never shortens a name", () => {
    const long = status({ name: "an-extremely-long-automation-name-that-will-not-fit" });
    const r = listingModel([long], { home: HOME, projectRoots: [], now: NOW }).groups[0]?.rows ?? [];
    expect(measure(r, 30).name).toBeGreaterThanOrEqual(long.name.length);
  });
});

describe("actionsFor", () => {
  const labels = (s: Status) => actionsFor(s).map((a) => a.action);

  it("offers a running automation only things that make sense while it runs", () => {
    const s = status({
      name: "x",
      running: {
        pid: 1,
        runId: "r",
        key: "k",
        startedAt: NOW.toISOString(),
        timeoutMs: 1,
        postHooks: 0,
        trigger: "manual",
      },
    });
    expect(labels(s)).toEqual(["window", "stop", "log", "check"]);
    expect(labels(s)).not.toContain("run");
  });

  it("offers stop ONLY while something is running", () => {
    // `x` on a finished run would either do nothing or, worse, reach the NEXT run of the same
    // automation — the stale-request case the cancel file guards against.
    for (const state of ["armed", "off", "disabled", "invalid"] as const) {
      const s = status({ state });
      expect(labels(s)).not.toContain("stop");
    }
  });

  it("offers disarm for a repository automation and disable for a user one", () => {
    expect(labels(status({ name: "x", scope: "repository", state: "armed" }))).toContain("disarm");
    expect(labels(USER_ARMED)).toContain("disable");
    expect(labels(USER_ARMED)).not.toContain("disarm");
  });

  it("never offers run for an off, disabled or invalid automation", () => {
    for (const st of ["off", "disabled", "invalid"] as AutomationState[]) {
      expect(labels(status({ name: "x", state: st }))).not.toContain("run");
    }
  });

  it("offers arm and arm-and-run only when it is off", () => {
    expect(labels(PROJECT_OFF)).toEqual(["arm", "arm-and-run", "check"]);
    expect(labels(status({ name: "mine", state: "off" }))).toEqual(["arm", "arm-and-run", "check"]);
  });

  it("arms an off automation with space, in either scope", () => {
    expect(actionForToggle(PROJECT_OFF)).toBe("arm");
    expect(actionForToggle(status({ name: "mine", state: "off" }))).toBe("arm");
    expect(actionForToggle(USER_ARMED)).toBe("disable");
    expect(actionForToggle(USER_DISABLED)).toBe("enable");
  });

  it("offers an invalid automation only check — there is nothing else to do with it", () => {
    expect(labels(INVALID)).toEqual(["check"]);
  });
});

describe("headerLines", () => {
  const counts = { armed: 2, off: 0, disabled: 1, invalid: 0 };

  it("says where you are and nothing else: the first line of the page is the answer", () => {
    expect(headerLines({ counts, running: 0, needs: 0, next: "next: x in 3m" }, 100)).toEqual(["Automations"]);
    expect(headerLines({ counts, running: 2, needs: 3 }, 100)).toEqual(["Automations"]);
  });

  it("puts the watcher on the right: dim while on, in the warning colour while off or late, with no key", () => {
    const on = headerLines({ counts, running: 0, watcher: { state: "on", lastTickAt: new Date(NOW.getTime() - 31_000).toISOString() } }, 120, undefined, NOW)[0] ?? "";
    expect(on).toMatch(/^Automations\s+watcher on$/);
    expect(on).toHaveLength(120);
    expect(headerLines({ counts, running: 0, watcher: { state: "off" } }, 120, undefined, NOW)[0]).toMatch(/\s+watcher off$/);
    const late = headerLines({ counts, running: 0, watcher: { state: "stale", lastTickAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() } }, 120, undefined, NOW)[0] ?? "";
    expect(late).toMatch(/\s+watcher late$/);
    const colours: string[] = [];
    headerLines({ counts, running: 0, watcher: { state: "off" } }, 120, { fg: (c, t) => (colours.push(c), t) }, NOW);
    expect(colours).toEqual(["warning"]);
  });

  it("drops the watcher before it ever clips the title", () => {
    const facts = { counts, running: 0, watcher: { state: "off" as const } };
    expect(headerLines(facts, 15, undefined, NOW)[0]).toBe("Automations");
    for (const w of [5, 10, 30, 100]) for (const l of headerLines(facts, w, undefined, NOW)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
  });
});

describe("createListScreen", () => {
  function data(statuses: Status[] = [USER_ARMED, USER_DISABLED, PROJECT_OFF]): ListData {
    const counts = { armed: 0, off: 0, disabled: 0, invalid: 0 };
    for (const s of statuses) counts[s.state]++;
    return {
      model: listingModel(statuses, { home: HOME, projectRoots: ["/repo"], now: NOW }),
      facts: { counts, running: 0 },
      now: NOW,
    };
  }

  function harness(initial = data()) {
    let renders = 0;
    let closed = 0;
    const acted: { action: ListAction; key: string }[] = [];
    let reloads = 0;
    let next = initial;

    const screen = createListScreen(
      {
        tui: { requestRender: () => renders++ },
        close: () => closed++,
        reload: async () => {
          reloads++;
          return next;
        },
        act: (action, status) => acted.push({ action, key: status.key }),
      },
      initial,
    );

    return {
      screen,
      acted,
      get renders() {
        return renders;
      },
      get closed() {
        return closed;
      },
      get reloads() {
        return reloads;
      },
      setNext: (d: ListData) => {
        next = d;
      },
    };
  }

  const cursorLine = (lines: string[]): string => lines.find((l) => l.startsWith("  ❯")) ?? "";

  const automation = (on: NonNullable<Status["automation"]>["on"] = { manual: true }): NonNullable<Status["automation"]> => ({
    name: "auto",
    description: "d",
    enabled: true,
    on,
    hooks: { pre: [], post: [] },
    body: "b",
  });

  const watched = (name: string, over: Partial<Status> = {}) =>
    status({
      name,
      automation: automation({ manual: true, watch: { script: "scripts/watch.js", every: "5m" } }),
      nextCheck: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
      ...over,
    });

  const scheduled = (name: string, over: Partial<Status> = {}) =>
    status({
      name,
      automation: automation({ manual: true, schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles", catchUp: "once" } }),
      nextFire: "2026-09-18T16:00:40.000Z",
      staggerSec: 40,
      ...over,
    });

  function listData(statuses: Status[], over: Partial<ListData> = {}): ListData {
    const counts = { armed: 0, off: 0, disabled: 0, invalid: 0 };
    for (const s of statuses) counts[s.state]++;
    return {
      model: listingModel(statuses, { home: HOME, projectRoots: ["/repo"], now: NOW }),
      facts: { counts, running: statuses.filter((s) => s.running).length, ...(over.facts ?? {}) },
      now: NOW,
      ...over,
    };
  }

  it("draws the answer, the cards, the agenda and the one hint line", () => {
    const h = harness();
    const lines = h.screen.render(100);
    const text = lines.join("\n");
    expect(lines[0]).toBe("Automations");
    expect(lines[2]).toBe("  Needs you");
    expect(text).toContain("  Coming up\n");
    expect(text).toContain("  Off and disabled\n");
    expect(text).not.toContain("3 automations");
    expect(text).not.toContain("user: ~/.agents/automations");
    expect(lines.at(-1)).toMatch(/^↑↓ move · enter open\s+\? help · esc close$/);
    h.screen.dispose();
  });

  describe("triage", () => {
    it("puts every kind in the section it belongs to, in the order the page shows them", () => {
      const failed = status({ name: "failed", last: { outcome: "failed", at: new Date(NOW.getTime() - 2 * 60_000).toISOString() } });
      const rows = [
        watched("watch-problem", { watch: { checkedAt: NOW.toISOString(), exit: 1, durationMs: 10, problem: "script failed" } }),
        status({ name: "invalid", state: "invalid", reason: "bad yaml" }),
        failed,
        status({ name: "consent", scope: "repository", state: "off", reason: "its AUTOMATION.md changed since you armed it" }),
        status({ name: "not-armed", scope: "repository", state: "off", reason: "not armed" }),
        watched("running", { running: { pid: 1, runId: "r", key: "k", startedAt: NOW.toISOString(), timeoutMs: 600_000, postHooks: 0, trigger: "watch" } }),
        watched("paused", { watchPausedAt: NOW.toISOString() }),
        scheduled("hold"),
        status({ name: "manual", automation: automation({ manual: true }) }),
        status({ name: "disabled", state: "disabled", automation: automation({ manual: true }) }),
      ];
      const tri = triage(listData(rows, { facts: { counts: { armed: 6, off: 2, disabled: 1, invalid: 1 }, running: 1, watcher: { state: "off" } } }), NOW);
      expect(tri.sections.map((s) => s.id)).toEqual(["needs", "running", "coming", "watching", "off"]);
      expect(tri.sections.map((s) => s.title)).toEqual(["Needs you", "Running now", "Coming up", "Watching", "Off and disabled"]);
      expect(Object.fromEntries(tri.sections.map((s) => [s.id, s.items.map((i) => `${i.kind}:${i.name}`)]))).toEqual({
        needs: ["watcher:The watcher", "invalid:invalid", "failed:failed", "watch:watch-problem", "consent:consent"],
        running: ["running:running"],
        coming: ["hold:hold", "manual:manual"],
        watching: ["paused:paused"],
        off: ["off:disabled", "not-armed:not-armed"],
      });
    });

    it("gives each Needs-you card what happened, why, and the one key that deals with it", () => {
      const failed = status({ name: "failed", last: { outcome: "failed", at: NOW.toISOString(), reason: "boom" } });
      const rows = [
        status({ name: "invalid", state: "invalid", reason: "on.schedule.cron: nope" }),
        failed,
        watched("watch-problem", { watch: { checkedAt: NOW.toISOString(), exit: 1, durationMs: 10, problem: "could not check" } }),
        status({ name: "consent", scope: "repository", state: "off", reason: "its scripts changed since you armed it", automation: automation({ manual: true, watch: { script: "scripts/new-tags.js", every: "15m" } }) }),
      ];
      const d = listData(rows);
      const cards = new Map(triage(d, NOW).sections.flatMap((s) => s.items).map((i) => [i.kind, cardFor(i, d, NOW)]));
      expect(cards.get("invalid")).toMatchObject({ glyph: { text: "✗", color: "error" }, rest: " has a problem in its file", why: { text: "on.schedule.cron: nope" }, key: "e", does: "fix it" });
      expect(cards.get("failed")).toMatchObject({ glyph: { color: "error" }, rest: " failed 0s ago", why: { text: "boom" }, key: "r", does: "run it again" });
      expect(cards.get("watch")).toMatchObject({ glyph: { text: "!", color: "warning" }, rest: "'s watch could not check", why: { text: "could not check" }, key: "c" });
      expect(cards.get("consent")).toMatchObject({ rest: " is off: its scripts changed since you armed it", key: "a", why: { text: "arming lets scripts/new-tags.js run every 15m on this machine" } });
    });

    it("says how long a run has gone and usually takes, and what it is doing now", () => {
      const running = watched("runner", {
        running: { pid: 1, runId: "r", key: "k", startedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(), timeoutMs: 30 * 60_000, postHooks: 0, trigger: "watch" },
      });
      const rec = (id: string, minutes: number) => ({
        id,
        key: running.key,
        name: running.name,
        scope: running.scope,
        root: running.root.path,
        trigger: "watch",
        late: false,
        recordedAt: NOW.toISOString(),
        startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
        endedAt: new Date(NOW.getTime() - 60 * 60_000 + minutes * 60_000).toISOString(),
        outcome: "ok" as const,
      });
      const d = listData([running], { details: { [running.key]: { records: [rec("10", 10), rec("12", 12), rec("14", 14)] } } });
      const item = triage(d, NOW).sections.flatMap((s) => s.items).find((i) => i.name === "runner") as InboxEntry;
      expect(cardFor(item, d, NOW)).toMatchObject({ glyph: { text: "▶", color: "accent" }, rest: " is running · 4m in, usually takes 12m", key: "s", does: "show it" });
      expect(cardFor(item, d, NOW).why?.text).toMatch(/^started by its watch at \d\d:\d\d$/);
      expect(cardFor(item, d, NOW, { step: { label: "Three reviewers read", note: "2 of 3 done" } }).why?.text).toBe("now: Three reviewers read · 2 of 3 done");
    });

    it("makes the watcher a card only when something waits for it, and enter opens its page where enter starts it", async () => {
      const manualOnly = listData([status({ name: "manual", automation: automation({ manual: true }) })], { facts: { counts: { armed: 1, off: 0, disabled: 0, invalid: 0 }, running: 0, watcher: { state: "off" } } });
      expect(triage(manualOnly, NOW).sections.flatMap((s) => s.items).some((i) => i.key === WATCHER_KEY)).toBe(false);

      const d = listData([scheduled("daily")], { facts: { counts: { armed: 1, off: 0, disabled: 0, invalid: 0 }, running: 0, watcher: { state: "off" } } });
      const first = triage(d, NOW).sections[0]?.items[0] as InboxEntry;
      expect(first.key).toBe(WATCHER_KEY);
      expect(cardFor(first, d, NOW)).toMatchObject({ name: "The watcher", rest: " is off — nothing runs on its own", why: { text: "daily waits for it" }, key: "w", does: "start it" });

      const global: string[] = [];
      const screen = createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => d, act: () => {}, actGlobal: (a) => void global.push(a) }, d);
      expect(screen.render(120).join("\n")).toContain("      w  start it");
      screen.handleInput("\r");
      const page = screen.render(120);
      expect(page[0]).toBe("The watcher");
      expect(page.join("\n")).toContain("Waiting for it");
      expect(page.join("\n")).toContain("daily");
      screen.handleInput("\r");
      await vi.waitFor(() => expect(global).toEqual(["watcher-start"]));
      screen.dispose();
    });

    it("leaves a dismissed failure in Coming up, until a newer run fails", () => {
      const oldFail = status({ name: "flaky", last: { outcome: "failed", at: NOW.toISOString() } });
      const oldRecord = { id: "old", key: oldFail.key, name: oldFail.name, scope: oldFail.scope, root: oldFail.root.path, trigger: "manual", late: false, recordedAt: NOW.toISOString(), outcome: "failed" as const };
      const dismissed = triage(listData([oldFail], { details: { [oldFail.key]: { records: [oldRecord], dismissedRunId: "old" } } }), NOW);
      expect(dismissed.sections.flatMap((s) => s.items).find((i) => i.name === "flaky")?.section).toBe("coming");
      const newer = { ...oldRecord, id: "new" };
      const back = triage(listData([oldFail], { details: { [oldFail.key]: { records: [oldRecord, newer], dismissedRunId: "old" } } }), NOW);
      expect(back.sections.flatMap((s) => s.items).find((i) => i.name === "flaky")?.section).toBe("needs");
    });

    it("flashes why for keys that do not apply, and enter does not confirm stopping the watcher", async () => {
      for (const key of ["p", "x", "s", "d"]) {
        const d = listData([status({ name: "manual", automation: automation({ manual: true }) })]);
        const screen = createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => d, act: () => {} }, d);
        screen.handleInput(key);
        expect(screen.render(100).join("\n")).toContain(`${key} ·`);
        screen.dispose();
      }
      const disabled = listData([status({ name: "disabled", state: "disabled", automation: automation({ manual: true }) })]);
      const disabledScreen = createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => disabled, act: () => {} }, disabled);
      disabledScreen.handleInput("r");
      expect(disabledScreen.render(100).join("\n")).toContain("r · disabled is disabled · space enables it");
      disabledScreen.dispose();

      const d = listData([scheduled("daily")], { facts: { counts: { armed: 1, off: 0, disabled: 0, invalid: 0 }, running: 0, watcher: { state: "on", lastTickAt: NOW.toISOString() } } });
      const global: string[] = [];
      const screen = createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => d, act: () => {}, actGlobal: (a) => void global.push(a) }, d);
      screen.handleInput("w");
      screen.handleInput("\r");
      expect(global).toEqual([]);
      expect(screen.render(120).join("\n")).toContain("Stop the watcher?");
      screen.handleInput("y");
      await vi.waitFor(() => expect(global).toEqual(["watcher-stop"]));
      screen.dispose();
    });

    it("never renders a line wider than the width, on any page", () => {
      const stopped = listData([scheduled("daily"), watched("watch", { last: { outcome: "failed", at: NOW.toISOString(), reason: "x".repeat(300) } })], { facts: { counts: { armed: 2, off: 0, disabled: 0, invalid: 0 }, running: 0, watcher: { state: "off" } } });
      for (const width of [40, 60, 80, 110, 160, 220]) {
        const states = [
          (s: ReturnType<typeof createListScreen>) => s,
          (s: ReturnType<typeof createListScreen>) => (s.handleInput("\r"), s),
          (s: ReturnType<typeof createListScreen>) => (s.handleInput("\u001b[B"), s.handleInput("\r"), s),
          (s: ReturnType<typeof createListScreen>) => (s.handleInput("?"), s),
        ];
        for (const open of states) {
          const screen = open(createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => stopped, act: () => {}, actGlobal: () => {} }, stopped));
          for (const line of screen.render(width)) expect(visibleWidth(line), line).toBeLessThanOrEqual(width);
          screen.dispose();
        }
        const running = listData([scheduled("daily")], { facts: { counts: { armed: 1, off: 0, disabled: 0, invalid: 0 }, running: 0, watcher: { state: "on", lastTickAt: NOW.toISOString() } } });
        const confirm = createListScreen({ tui: { requestRender: () => {} }, close: () => {}, reload: async () => running, act: () => {}, actGlobal: () => {} }, running);
        confirm.handleInput("w");
        for (const line of confirm.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        confirm.dispose();
      }
    });
  });

  it("writes an agenda row as when, name and how its last run went; an Off and disabled row as its name", () => {
    const h = harness(
      data([
        status({ name: "daily-briefing", automation: automation({ manual: true }), last: { outcome: "ok", at: new Date(NOW.getTime() - 26 * 60_000).toISOString() } }),
        { ...USER_DISABLED, automation: automation({ manual: true }) },
        status({ name: "repo-thing", scope: "repository", state: "off", reason: "not armed", root: { path: "/repo/.agents/automations", scope: "repository", kind: "agents" } }),
      ]),
    );
    const lines = h.screen.render(100);
    const row = (name: string) => lines.find((l) => l.includes(name)) ?? "";
    expect(row("daily-briefing")).toMatch(/^ {2}❯ when you run it {3}daily-briefing\s+✓ 26m ago$/);
    expect(row("quiet-one")).toBe("    quiet-one");
    expect(row("repo-thing")).toMatch(/^ {4}repo-thing\s+not armed · a arms it after a preview$/);
    h.screen.dispose();
  });

  it("starts on the first card, never on a heading, and moves card to card, row to row", () => {
    const h = harness();
    expect(cursorLine(h.screen.render(100))).toContain("repo-thing");
    h.screen.handleInput("\u001b[B");
    expect(cursorLine(h.screen.render(100))).toContain("daily-briefing");
    h.screen.handleInput("\u001b[B");
    expect(cursorLine(h.screen.render(100))).toContain("quiet-one");
    h.screen.dispose();
  });

  it("clamps at both ends", () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.screen.handleInput("\u001b[B");
    expect(cursorLine(h.screen.render(100))).toContain("quiet-one");
    for (let i = 0; i < 20; i++) h.screen.handleInput("\u001b[A");
    expect(cursorLine(h.screen.render(100))).toContain("repo-thing");
    h.screen.handleInput("\u001b[F");
    expect(cursorLine(h.screen.render(100))).toContain("quiet-one");
    h.screen.handleInput("\u001b[H");
    expect(cursorLine(h.screen.render(100))).toContain("repo-thing");
    h.screen.dispose();
  });

  it("esc and q close", () => {
    const h = harness();
    h.screen.handleInput("\u001b");
    h.screen.handleInput("q");
    expect(h.closed).toBe(2);
    h.screen.dispose();
  });

  it("? shows what each part of the page means and the keys by what they act on; any key comes back", () => {
    const h = harness();
    h.screen.handleInput("\u001b[B");
    h.screen.handleInput("?");
    const help = h.screen.render(100);
    expect(help.filter((l) => /^ {2}[A-Z]/.test(l)).map((l) => l.trim())).toEqual(["The page", "On the selected automation", "The watcher", "Moving around"]);
    const text = help.join("\n");
    for (const k of ["Needs you", "Running now", "Coming up", "Watching", "how often it checks", "Off and disabled", "enter", "r  f", "x  s", "p  d", "space  a", "e  l  c", "w ", "PgUp PgDn Home End", "R  refresh", "esc", "q  close", "y  yes, when asked"]) expect(text).toContain(k);
    expect(help.at(-1)?.trim()).toBe("any key closes");
    h.screen.handleInput("x");
    const back = h.screen.render(100);
    expect(back.join("\n")).not.toContain("Moving around");
    expect(cursorLine(back)).toContain("daily-briefing");
    expect(h.acted).toHaveLength(0);
    h.screen.dispose();
  });

  it("lists a plugin's keys in the help", () => {
    const d = { ...data(), extras: { edit: { label: "Edit in the Automation Manager", why: "w" }, actions: [{ id: "share", label: "Share it", key: "h" }] } };
    const screen = createListScreen({ tui: { requestRender() {} }, close() {}, reload: async () => d, act() {} }, d);
    screen.handleInput("?");
    expect(screen.render(100).join("\n")).toContain("    h         share it");
    screen.dispose();
  });

  it("v does nothing: there is one size, the whole screen", () => {
    const h = harness();
    const before = h.screen.render(100).join("\n");
    h.screen.handleInput("v");
    expect(h.screen.render(100).join("\n")).toBe(before);
    expect(h.closed).toBe(0);
    expect(h.reloads).toBe(0);
    h.screen.dispose();
  });

  it("enter opens the automation as a page: its lead, what it does, its last run, every action", () => {
    const h = harness();
    h.screen.handleInput("\r");
    const lines = h.screen.render(100);
    const text = lines.join("\n");
    expect(lines[0]).toBe("repo-thing");
    expect(lines[2]?.startsWith("  repo-thing is off: repository automations are off until you arm them.")).toBe(true);
    expect(text.replace(/\n {2}/g, " ")).toContain("repo-thing is off: repository automations are off until you arm them. Look at it again, then arm it.");
    expect(text).toContain("Last run   never run");
    expect(text).toContain("  ❯ a      arm it, after a preview");
    expect(text).toContain("           arm it and run it once");
    expect(text).toContain("    e      edit it");
    expect(text).not.toContain("disarm");
    // A page of its own: the list is not drawn behind it.
    expect(text).not.toContain("daily-briefing");
    expect(lines.at(-1)).toMatch(/^↑↓ choose · enter do it\s+esc back$/);
    h.screen.dispose();
  });

  it("an action's own key does it from the automation's page, and the page stays", async () => {
    const h = harness();
    h.screen.handleInput("\u001b[B");
    h.screen.handleInput("\r");
    h.screen.handleInput("r");
    await vi.waitFor(() => expect(h.acted).toHaveLength(1));
    expect(h.acted[0]).toEqual({ action: "run", key: USER_ARMED.key });
    expect(h.screen.render(100)[0]).toBe("daily-briefing");
    h.screen.dispose();
  });

  it("esc leaves the automation's page for the list, on the same automation", () => {
    const h = harness();
    h.screen.handleInput("\u001b[B");
    h.screen.handleInput("\u001b[B");
    h.screen.handleInput("\r");
    h.screen.handleInput("\u001b");
    expect(h.closed).toBe(0);
    expect(cursorLine(h.screen.render(100))).toContain("quiet-one");
    h.screen.dispose();
  });

  it("re-reads before acting, so it never acts on a cached status", async () => {
    const h = harness();
    h.screen.handleInput("\u001b[B");
    h.screen.handleInput("r");
    await vi.waitFor(() => expect(h.acted).toHaveLength(1));
    expect(h.reloads).toBe(1);
    expect(h.acted[0]).toEqual({ action: "run", key: USER_ARMED.key });
    h.screen.dispose();
  });

  it("looks again shortly after starting a run, so the page can say it is running", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.screen.handleInput("\u001b[B");
      h.screen.handleInput("r");
      await vi.waitFor(() => expect(h.acted).toHaveLength(1));
      const before = h.reloads;
      await vi.advanceTimersByTimeAsync(1_600);
      expect(h.reloads).toBe(before + 1);
      h.screen.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an action the automation no longer allows after the re-read", async () => {
    const h = harness();
    h.screen.handleInput("\u001b[B");
    h.setNext(data([status({ name: "daily-briefing", state: "invalid", reason: "broke" })]));
    h.screen.handleInput("r");
    await vi.waitFor(() => expect(h.reloads).toBe(1));
    // `reloads` increments INSIDE reload(), so the decision has not been made yet.
    await settle();
    expect(h.acted).toHaveLength(0);
    h.screen.dispose();
  });

  it("does not fall back to another automation when the chosen one vanished", async () => {
    const h = harness();
    h.screen.handleInput("\u001b[B");
    h.setNext(data([USER_DISABLED]));
    h.screen.handleInput("r");
    await vi.waitFor(() => expect(h.reloads).toBe(1));
    await settle();
    expect(h.acted).toHaveLength(0);
    expect(h.screen.render(100).join("\n")).toContain("no longer listed");
    h.screen.dispose();
  });

  it("acts on the automation whose page is open", async () => {
    const h = harness();
    h.screen.handleInput("\u001b[B"); // daily-briefing
    h.screen.handleInput("\u001b[B"); // quiet-one
    h.screen.handleInput("\r");
    h.screen.handleInput("\r");
    await vi.waitFor(() => expect(h.acted).toHaveLength(1));
    expect(h.acted[0]).toEqual({ action: "enable", key: USER_DISABLED.key });
    h.screen.dispose();
  });

  it("keeps the cursor on the same automation across a reload that reorders the page", async () => {
    const h = harness();
    h.screen.handleInput("\u001b[B");
    expect(cursorLine(h.screen.render(100))).toContain("daily-briefing");
    // daily-briefing fails: it moves from Coming up to the top of the page, and the cursor goes
    // with it.
    h.setNext(data([{ ...USER_ARMED, last: { outcome: "failed", at: NOW.toISOString(), reason: "boom" } }, USER_DISABLED, PROJECT_OFF]));
    h.screen.handleInput("R");
    await vi.waitFor(() => expect(h.reloads).toBe(1));
    await settle();
    const lines = h.screen.render(100);
    expect(cursorLine(lines)).toContain("✗ daily-briefing failed");
    expect(lines.indexOf(cursorLine(lines))).toBe(3);
    h.screen.dispose();
  });

  it("ignores keys it does not own", () => {
    const h = harness();
    const before = h.screen.render(100).join("\n");
    for (const k of ["z", "\u0003", "\u001b[Z"]) h.screen.handleInput(k);
    expect(h.screen.render(100).join("\n")).toBe(before);
    expect(h.closed).toBe(0);
    h.screen.dispose();
  });

  it("survives an empty world, and says how to start", () => {
    const h = harness({
      model: listingModel([], { home: HOME, projectRoots: [], now: NOW }),
      facts: { counts: { armed: 0, off: 0, disabled: 0, invalid: 0 }, running: 0 },
    });
    const text = h.screen.render(100).join("\n");
    expect(text).toContain("✓ Nothing needs you.");
    expect(text).toContain("No automations yet");
    for (const k of ["\u001b[A", "\u001b[B", "\r", "r", "a", "l", "c"]) {
      expect(() => h.screen.handleInput(k)).not.toThrow();
    }
    expect(h.acted).toHaveLength(0);
    h.screen.dispose();
  });

  it("stops touching a render host that has gone away", () => {
    let calls = 0;
    const screen = createListScreen(
      {
        tui: {
          requestRender: () => {
            calls++;
            throw new Error("stale");
          },
        },
        close: () => {},
        reload: async () => data(),
        act: () => {},
      },
      data(),
    );
    expect(() => screen.handleInput("\u001b[B")).not.toThrow();
    const first = calls;
    screen.handleInput("\u001b[B");
    expect(calls).toBe(first);
    screen.dispose();
  });
});

describe("the flowchart marker in the listing", () => {
  const tracked = status({ name: "demo-inbox", flow: true });

  it("marks a tracked automation and only a tracked one", () => {
    const m = listingModel([tracked, USER_ARMED], { home: HOME, projectRoots: [], now: NOW });
    const rows = m.groups[0]?.rows ?? [];
    expect(rows.find((r) => r.name === "demo-inbox")?.flow).toBe(true);
    expect(rows.find((r) => r.name === "daily-briefing")?.flow).toBeUndefined();
    expect(m.cols.showFlow).toBe(true);
  });

  it("reserves no column at all when nothing is tracked", () => {
    const m = listingModel([USER_ARMED], { home: HOME, projectRoots: [], now: NOW });
    expect(m.cols.showFlow).toBe(false);
  });

  it("leaves the plain listing byte-identical when nothing is tracked", () => {
    const opts = { home: HOME, projectRoots: [], now: NOW };
    const before = renderListing([USER_ARMED, USER_DISABLED], opts).join("\n");
    expect(before).not.toContain("⋔");
    expect(before.split("\n")[0]).toMatch(/^\s+NAME/);
  });

  it("shows the glyph before the name, and indents the rest to match", () => {
    const lines = renderListing([tracked, USER_ARMED], {
      home: HOME,
      projectRoots: [],
      now: NOW,
    });
    const text = lines.join("\n");
    expect(text).toContain("⋔ demo-inbox");

    // The invariant that matters: the NAMES still line up, with each other and with the header.
    const header = lines[0] ?? "";
    const trackedRow = lines.find((l) => l.includes("demo-inbox")) ?? "";
    const plainRow = lines.find((l) => l.includes("daily-briefing")) ?? "";
    expect(trackedRow.indexOf("demo-inbox")).toBe(plainRow.indexOf("daily-briefing"));
    expect(trackedRow.indexOf("demo-inbox")).toBe(header.indexOf("NAME"));
    // ...and the marker sits in the two columns reserved before them.
    expect(trackedRow.indexOf("⋔")).toBe(header.indexOf("NAME") - 2);
  });
});

describe("run and watch the flowchart", () => {
  it("is offered for a tracked automation, right after run", () => {
    const actions = actionsFor(status({ name: "x", flow: true })).map((a) => a.action);
    expect(actions[0]).toBe("run");
    expect(actions[1]).toBe("run-flow");
  });

  it("is NOT offered for an automation with no flowchart", () => {
    expect(actionsFor(USER_ARMED).map((a) => a.action)).not.toContain("run-flow");
  });

  it("is not offered for a tracked automation that cannot run", () => {
    for (const st of ["off", "disabled", "invalid"] as AutomationState[]) {
      const actions = actionsFor(status({ name: "x", state: st, flow: true })).map((a) => a.action);
      expect(actions, st).not.toContain("run-flow");
    }
  });

  it("is not offered while it is already running", () => {
    const running = status({
      name: "x",
      flow: true,
      running: {
        pid: 1,
        runId: "r",
        key: "k",
        startedAt: NOW.toISOString(),
        timeoutMs: 1,
        postHooks: 0,
        trigger: "manual",
      },
    });
    expect(actionsFor(running).map((a) => a.action)).not.toContain("run-flow");
  });

  it("f asks for it, and only after a fresh re-read", async () => {
    const counts = { armed: 1, off: 0, disabled: 0, invalid: 0 };
    const data: ListData = {
      model: listingModel([status({ name: "demo-inbox", flow: true })], {
        home: HOME,
        projectRoots: [],
        now: NOW,
      }),
      facts: { counts, running: 0 },
    };
    const acted: ListAction[] = [];
    let reloads = 0;
    const screen = createListScreen(
      {
        tui: { requestRender: () => {} },
        close: () => {},
        reload: async () => {
          reloads++;
          return data;
        },
        act: (action) => acted.push(action),
      },
      data,
    );
    screen.handleInput("f");
    await vi.waitFor(() => expect(acted).toHaveLength(1));
    expect(reloads).toBe(1);
    expect(acted[0]).toBe("run-flow");
    screen.dispose();
  });
});

describe("what the review of the triage found", () => {
  const SCHEDULE = { cron: "0 9 * * *", timezone: "UTC" };
  function auto(name: string, on: Record<string, unknown>): NonNullable<Status["automation"]> {
    return { name, description: `${name} does its own thing.`, enabled: true, on: { manual: true, ...on }, hooks: { pre: [], post: [] }, body: "b" } as unknown as NonNullable<Status["automation"]>;
  }
  function dataOf(statuses: Status[], watcher?: ListData["facts"]["watcher"]): ListData {
    const counts = { armed: 0, off: 0, disabled: 0, invalid: 0 };
    for (const s of statuses) counts[s.state]++;
    return {
      model: listingModel(statuses, { home: HOME, projectRoots: [], now: NOW }),
      facts: { counts, running: statuses.filter((s) => s.running).length, ...(watcher ? { watcher } : {}) },
      now: NOW,
    };
  }
  const cursorRow = (lines: string[]): string => lines.find((l) => l.startsWith("  ❯")) ?? "";
  const alpha = status({ name: "alpha-report", automation: auto("alpha-report", {}) });
  const bravo = status({ name: "bravo-cleanup", automation: auto("bravo-cleanup", {}) });

  it("keeps an open page on the automation it shows when a slow reload lands", async () => {
    const d = dataOf([alpha, bravo]);
    let release: (() => void) | undefined;
    let slow = true;
    const acted: string[] = [];
    const screen = createListScreen(
      {
        tui: { requestRender() {} },
        close() {},
        reload: () =>
          slow
            ? new Promise<ListData>((resolve) => {
                slow = false;
                release = () => resolve(d);
              })
            : Promise.resolve(d),
        act: (action, s) => {
          acted.push(`${action} ${s.name}`);
        },
      },
      d,
    );
    expect(cursorRow(screen.render(160))).toContain("alpha-report");
    screen.handleInput("r"); // the reload for alpha's run is still going…
    screen.handleInput("\u001b[B");
    screen.handleInput("\r"); // …when bravo's page opens
    release?.();
    await settle();
    expect(screen.render(160)[0]).toBe("bravo-cleanup");
    screen.handleInput(" ");
    await settle();
    await settle();
    expect(acted).toEqual(["run alpha-report", "disable bravo-cleanup"]);
    screen.handleInput("\u001b");
    expect(cursorRow(screen.render(160))).toContain("bravo-cleanup");
    screen.dispose();
  });

  it("brings the cursor back to the nearest automation when the one it acted on has gone", async () => {
    let next = dataOf([alpha, bravo]);
    const acted: string[] = [];
    const screen = createListScreen(
      { tui: { requestRender() {} }, close() {}, reload: async () => next, act: (action, s) => void acted.push(`${action} ${s.name}`) },
      next,
    );
    screen.handleInput("\u001b[B");
    expect(cursorRow(screen.render(120))).toContain("bravo-cleanup");
    next = dataOf([alpha]);
    screen.handleInput("r");
    await settle();
    expect(cursorRow(screen.render(120))).toContain("alpha-report");
    screen.handleInput("r");
    await settle();
    await settle();
    expect(acted).toEqual(["run alpha-report"]);
    screen.dispose();
  });

  it("holds nothing for a watcher registered for another install that still ticks, and offers to restart it", () => {
    const daily = status({ name: "daily", automation: auto("daily", { schedule: SCHEDULE }), nextFire: "2026-09-18T09:00:00.000Z" });
    const watcher = { state: "stale" as const, lastTickAt: new Date(NOW.getTime() - 30_000).toISOString(), note: "it was registered for another install of pi-automations" };
    const d = dataOf([daily], watcher);
    const t = triage(d, NOW);
    expect(t.sections.find((s) => s.id === "coming")?.items.map((i) => `${i.kind}:${i.name}`)).toEqual(["coming:daily"]);
    const card = t.sections.find((s) => s.id === "needs")?.items[0] as InboxEntry;
    expect(card.key).toBe(WATCHER_KEY);
    expect(cardFor(card, d, NOW)).toMatchObject({ rest: " is registered for another install", key: "w", does: "restart it for this one" });
    const screen = createListScreen({ tui: { requestRender() {} }, close() {}, reload: async () => d, act() {}, actGlobal() {} }, d);
    expect(screen.render(120)[0]).toMatch(/watcher on$/);
    screen.dispose();
    // Quiet past the threshold, it is late after all, and holds what it starts.
    const quiet = dataOf([daily], { ...watcher, lastTickAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() });
    expect(triage(quiet, NOW).sections.find((s) => s.id === "coming")?.items.map((i) => i.kind)).toEqual(["hold"]);
    const late = triage(quiet, NOW).sections[0]?.items[0] as InboxEntry;
    expect(cardFor(late, quiet, NOW)).toMatchObject({ rest: " is late — no tick for 20m", key: "w", does: "restart it" });
  });

  it("keeps a run in Running now when its file breaks under it, and says so on its card", () => {
    const runner = status({
      name: "runner",
      state: "invalid",
      reason: "timeout 9h is above the maximum",
      running: { pid: 1, runId: "r1", key: "k", startedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(), timeoutMs: 30 * 60_000, postHooks: 0, trigger: "manual" },
    });
    const d = dataOf([runner]);
    const t = triage(d, NOW);
    expect(t.running).toBe(1);
    expect(t.needs).toBe(0);
    const item = t.sections.find((s) => s.id === "running")?.items[0] as InboxEntry;
    expect(cardFor(item, d, NOW).rest).toContain("its file has a problem now");
  });

  it("says an overdue check is missing since a time with its day, never a bare clock time", () => {
    const watched = status({
      name: "watched",
      automation: auto("watched", { watch: { script: "w.js", every: "5m" } }),
      nextCheck: new Date(NOW.getTime() - 16 * 3_600_000).toISOString(),
      watch: { checkedAt: new Date(NOW.getTime() - 16 * 3_600_000 - 5 * 60_000).toISOString(), exit: 3, durationMs: 900 },
    });
    const d = dataOf([watched], { state: "off" });
    const screen = createListScreen({ tui: { requestRender() {} }, close() {}, reload: async () => d, act() {}, actGlobal() {} }, d);
    screen.handleInput("\r");
    const page = screen.render(160).join("\n");
    expect(page).toContain("its watch: no checks since ");
    expect(page).not.toContain("no check at ");
    screen.dispose();
  });

  it("files a schedule with a paused watch by its schedule, and says the watch is paused on its page", () => {
    const both = status({
      name: "both",
      automation: auto("both", { schedule: SCHEDULE, watch: { script: "w.js", every: "5m" } }),
      nextFire: "2026-09-18T09:00:00.000Z",
      watchPausedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    const off = triage(dataOf([both], { state: "off" }), NOW);
    expect(off.sections.find((s) => s.id === "coming")?.items.map((i) => i.kind)).toEqual(["hold"]);
    expect(off.paused).toBe(1);
    const onData = dataOf([both], { state: "on", lastTickAt: NOW.toISOString() });
    const on = triage(onData, NOW);
    const item = on.sections.find((s) => s.id === "coming")?.items[0] as InboxEntry;
    expect(item.kind).toBe("coming");
    expect(agendaRow(item, NOW).when?.text).toBe("tomorrow 09:00");
    expect(automationLead(both, onData, NOW).text).toMatch(/Its watch is paused\.$/);
    // A watch that was its only way to start on its own says so where its time would be.
    const only = status({ name: "only", automation: auto("only", { watch: { script: "w.js", every: "5m" } }), watchPausedAt: both.watchPausedAt });
    const onlyItem = triage(dataOf([only], { state: "on", lastTickAt: NOW.toISOString() }), NOW).sections[0]?.items[0] as InboxEntry;
    expect(onlyItem.kind).toBe("paused");
    expect(agendaRow(onlyItem, NOW).when).toEqual({ text: "paused · p resumes", color: "warning" });
  });
});
