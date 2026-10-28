import { afterEach, describe, expect, it, vi } from "vitest";

import type { Status } from "../src/types.js";
import { agendaRow, automationLead, cardFor, createListScreen, triage, type InboxEntry, type ListData, type ListHost, type ListRuns } from "../src/ui/list.js";
import type { RunRegistry } from "../src/ui/registry.js";
import { runPageLines, runTitleRight } from "../src/ui/running.js";
import { createRunsPage } from "../src/ui/runs.js";
import type { LineTheme, UiColor } from "../src/ui/theme.js";
import { stripAnsi, visibleWidth } from "../src/ui/width.js";
import { createStatusWindow } from "../src/ui/window.js";
import {
  ALL,
  ALL_GOOD,
  DIGEST_RUNS,
  inboxData,
  ISSUE_VERIFY,
  NIGHTLY,
  NOW,
  OLD_CLEANUP,
  PR_DIGEST,
  PR_REVIEW,
  status,
  TEAM_REVIEW,
  teamRunView,
} from "./helpers/inbox-data.js";

const settle = () => new Promise((r) => setTimeout(r, 0));
const DOWN = "\u001b[B";
const MIN = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

function screen(d: ListData, over: Partial<ListHost> = {}, rows?: number) {
  return createListScreen(
    {
      tui: { requestRender() {}, ...(rows ? { terminal: { rows } } : {}) },
      close() {},
      reload: async () => d,
      act() {},
      actGlobal() {},
      ...over,
    },
    d,
  );
}

/** A theme that writes each colour as `{colour:text}`, so a test can see what is coloured. */
const MARKED: LineTheme = { fg: (c: UiColor, t: string) => `{${c}:${t}}`, bold: (t) => `*${t}*` };

/**
 * The names in one agenda group (`Coming up`, `Watching`, `Off and disabled`), in the order the page shows them.
 */
function group(lines: string[], title: string): string[] {
  const at = lines.indexOf(`  ${title}`);
  if (at === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "") break;
    const m = l.match(/(my-[a-z-]+|[a-z]+-[a-z-]+)/);
    if (m) out.push(m[1] as string);
  }
  return out;
}
const comingUp = (lines: string[]) => group(lines, "Coming up");
const watching = (lines: string[]) => group(lines, "Watching");

describe("the first line under the title answers: does anything need me?", () => {
  it("says ✓ Nothing needs you. when nothing does, and it is the page's only colour", () => {
    const calls: UiColor[] = [];
    const s = screen(inboxData(ALL_GOOD), { theme: { fg: (c, t) => (calls.push(c), t) } });
    const lines = s.render(100);
    expect(lines[0]).toMatch(/^Automations\s+watcher on$/);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("  ✓ Nothing needs you.");
    // Fine is the default, so it is quiet: one green ✓, and everything else dim or plain — but for
    // the last message's dim rule and its links.
    expect(calls.filter((c) => c !== "muted" && c !== "dim" && c !== "text" && c !== "borderMuted" && c !== "accent")).toEqual(["success"]);
    s.dispose();
  });

  it("opens on a Needs-you card when something does, with the cursor on it", () => {
    const lines = screen(inboxData(ALL)).render(100);
    expect(lines[2]).toBe("  Needs you");
    expect(lines[3]).toBe("  ❯ ✗ nightly-report failed 3h ago");
    expect(lines.join("\n")).not.toContain("Nothing needs you");
  });

  it("does not count a run that is going as something that needs you", () => {
    const lines = screen(inboxData([PR_DIGEST, TEAM_REVIEW])).render(100);
    expect(lines[2]).toBe("  ✓ Nothing needs you.");
    expect(lines[4]).toBe("  Running now");
  });
});

describe("a card says what happened, why, and the one key", () => {
  it("draws a failure as what, why, the pattern, and r — with leave it, since it runs again on its own", () => {
    const lines = screen(inboxData(ALL)).render(100);
    expect(lines.slice(2, 7)).toEqual([
      "  Needs you",
      "  ❯ ✗ nightly-report failed 3h ago",
      "      gh: HTTP 502 while posting the report to #builds",
      "      2 of the last 7 runs failed · l shows them",
      "      r  run it again            or leave it: it runs again on its own today 22:00",
    ]);
  });

  it("says it more briefly on a narrow terminal, and never wraps", () => {
    const lines = screen(inboxData(ALL)).render(80);
    expect(lines[6]).toBe("      r  run it again            or leave it: it runs again today 22:00");
  });

  it("offers no leave it when nothing would run it again on its own", () => {
    const manual = status("by-hand", { manual: true }, { last: { outcome: "failed", at: new Date(NOW.getTime() - 5 * MIN).toISOString(), reason: "exit 2" } });
    const d = inboxData([manual]);
    const entry = triage(d, NOW).sections[0]?.items[0] as InboxEntry;
    const card = cardFor(entry, d, NOW);
    expect(card).toMatchObject({ name: "by-hand", rest: " failed 5m ago", why: { text: "exit 2" }, key: "r", does: "run it again" });
    expect(card.leave).toBeUndefined();
    // Nor while the watcher is off: a schedule that will not fire is no reason to leave it.
    const off = inboxData([NIGHTLY]);
    off.facts.watcher = { state: "off" };
    const nightly = triage(off, NOW).sections[0]?.items.find((i) => i.name === "nightly-report") as InboxEntry;
    expect(cardFor(nightly, off, NOW).leave).toBeUndefined();
  });

  it("draws a running run as how long, what it is doing now, and s", () => {
    const steps = { [TEAM_REVIEW.key]: { label: "Three reviewers read", note: "2 of 3 reviewers done" } };
    const lines = screen(inboxData(ALL, { steps })).render(100);
    const at = lines.indexOf("  Running now");
    expect(lines.slice(at, at + 4)).toEqual([
      "  Running now",
      "    ▶ my-team-review is running · 3m in, usually takes 7m",
      "      now: Three reviewers read · 2 of 3 reviewers done",
      "      s  show it",
    ]);
  });

  it("colours the glyph, makes the name bold, and leaves the rest of the card plain", () => {
    const lines = screen(inboxData(ALL), { theme: MARKED }).render(100);
    expect(lines[3]).toBe("  *❯* {error:✗} *nightly-report* failed 3h ago");
    expect(lines[6]).toContain("*r*  run it again");
    expect(lines[6]).toContain("{muted:or leave it: it runs again on its own today 22:00}");
  });

  it("makes each running run a card of its own", () => {
    const other = status("other-run", { manual: true }, { running: { pid: 2, runId: "r2", key: "k2", startedAt: new Date(NOW.getTime() - MIN).toISOString(), timeoutMs: 0, postHooks: 0, trigger: "manual" } });
    const lines = screen(inboxData([TEAM_REVIEW, other])).render(100);
    expect(lines.filter((l) => l.includes("▶"))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("s  show it"))).toHaveLength(2);
  });

  it("keeps cards whole when there are too many to fit, and scrolls with the selection", () => {
    const many = ["a-one", "b-two", "c-three", "d-four", "e-five", "f-six", "g-seven"].map((n) => ({ ...NIGHTLY, name: n, key: `user:x:${n}` }));
    const s = screen(inboxData([...many, PR_DIGEST]), {}, 24);
    for (let i = 0; i < 5; i++) s.handleInput(DOWN);
    const lines = s.render(80);
    expect(lines).toHaveLength(24);
    expect(lines[2]).toBe("  ↑ more above");
    // Every card on the page starts with its name: none is cut through the middle.
    const cardLines = lines.filter((l) => /^ {6}r {2}run it again/.test(l)).length;
    expect(lines.filter((l) => /^ {2}[❯ ] ✗ [a-g]-[a-z]+ failed/.test(l))).toHaveLength(cardLines);
    expect(lines.find((l) => l.startsWith("  ❯"))).toContain("f-six");
  });

  it("never prints a key on the hint line that the selected card already shows", () => {
    const off = inboxData([...ALL]);
    off.facts.watcher = { state: "off" };
    for (const d of [inboxData(ALL), off]) {
      const s = screen(d);
      const entries = triage(d, NOW).sections.flatMap((x) => x.items);
      for (const entry of entries) {
        const lines = s.render(100);
        const hints = lines.at(-1) ?? "";
        if (entry.section === "needs" || entry.section === "running") {
          const card = cardFor(entry, d, NOW);
          if (card.key) expect(hints, entry.name).not.toMatch(new RegExp(`(^| )${card.key} `));
        }
        expect(hints).toMatch(/^↑↓ move · enter open\s+\? help · esc close$/);
        s.handleInput(DOWN);
      }
      s.dispose();
    }
  });
});

describe("the agenda is quiet, and its order never jumps", () => {
  it("lists scheduled automations by their next run, then watched ones by name under Watching", () => {
    const lines = screen(inboxData(ALL_GOOD)).render(100);
    expect(comingUp(lines)).toEqual(["my-pr-digest", "my-issue-verify"]);
    expect(watching(lines)).toEqual(["my-pr-review"]);
    expect(lines.slice(4, 11)).toEqual([
      "  Coming up",
      "  ❯ tomorrow 08:00   my-pr-digest        ✓ 6h ago",
      "    Mon 07:00        my-issue-verify     ↷ skipped 3d ago",
      "",
      "  Watching",
      "    every 5m         my-pr-review        ✓ 12d ago",
      "",
    ]);
  });

  it("shows a watch's steady interval, never a countdown: that is on its page", () => {
    const idle = { ...TEAM_REVIEW, running: undefined } as Status;
    for (const d of [inboxData(ALL), inboxData(ALL_GOOD), inboxData([PR_REVIEW, idle, PR_DIGEST])]) {
      const lines = screen(d).render(100);
      for (const l of lines) expect(l).not.toMatch(/\bin \d+[smh]\b|\bnow\s{2,}/);
    }
    const lines = screen(inboxData([PR_REVIEW, idle, PR_DIGEST])).render(100);
    expect(watching(lines)).toEqual(["my-pr-review", "my-team-review"]);
    expect(lines.find((l) => l.includes("my-team-review"))).toMatch(/^ {4}every 15m {8}my-team-review {5}✓ 13m ago$/);
    // The countdown lives on the automation's page.
    expect(automationLead(PR_REVIEW, inboxData([PR_REVIEW]), NOW).text).toBe("my-pr-review is healthy. Its watch checks in 1 minute, then every 5m.");
  });

  it("puts an automation with a schedule and a watch in Coming up, by its next run, and its page names the watch", () => {
    const both = status("both-ways", { manual: true, schedule: { cron: "0 9 * * *", catchUp: "skip" }, watch: { script: "w.js", every: "10m" } }, {
      nextFire: new Date(2026, 9, 22, 21, 0).toISOString(),
      nextCheck: new Date(NOW.getTime() + 2 * MIN).toISOString(),
    });
    const d = inboxData([both, PR_DIGEST, PR_REVIEW]);
    const lines = screen(d).render(100);
    expect(comingUp(lines)).toEqual(["both-ways", "my-pr-digest"]);
    expect(watching(lines)).toEqual(["my-pr-review"]);
    expect(lines.find((l) => l.includes("both-ways"))).toMatch(/^ {2}❯ today 21:00 {6}both-ways/);
    expect(automationLead(both, d, NOW).text).toBe("both-ways is healthy. Next run today at 21:00, then daily. Its watch also checks in 2 minutes, then every 10m.");
  });

  it("draws a group's heading only when it has rows, and keeps it when it is the only one", () => {
    const onlyWatch = screen(inboxData([PR_REVIEW])).render(100);
    expect(onlyWatch).toContain("  Watching");
    expect(onlyWatch).not.toContain("  Coming up");
    const onlySchedule = screen(inboxData([PR_DIGEST])).render(100);
    expect(onlySchedule).toContain("  Coming up");
    expect(onlySchedule).not.toContain("  Watching");
  });

  it("keeps the same order on every timer tick, and re-reads nothing for one", async () => {
    vi.useFakeTimers({ now: NOW });
    // Two watches whose next checks keep overtaking each other: soonest-first would swap them all
    // day.
    const watch = (name: string, inMin: number) =>
      status(name, { manual: true, watch: { script: "w.js", every: "5m" } }, { nextCheck: new Date(NOW.getTime() + inMin * MIN).toISOString() });
    const d = inboxData([watch("zulu-watch", 1), watch("alpha-watch", 4), PR_DIGEST, ISSUE_VERIFY]);
    let reloads = 0;
    let clock = NOW.getTime();
    const s = screen(d, { now: () => new Date(clock), tickMs: 15_000, reload: async () => (reloads++, d) });
    const first = s.render(100).map((l) => l.replace(/\s+$/, ""));
    expect(comingUp(first)).toEqual(["my-pr-digest", "my-issue-verify"]);
    expect(watching(first)).toEqual(["alpha-watch", "zulu-watch"]);
    for (let i = 0; i < 40; i++) {
      clock += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
      // Nothing on the agenda moves or counts: the page is the same page.
      expect(s.render(100).map((l) => l.replace(/\s+$/, ""))).toEqual(first);
    }
    expect(reloads).toBe(0);
    s.dispose();
  });

  it("redraws on the tick, so a running card's time moves", async () => {
    vi.useFakeTimers({ now: NOW });
    let renders = 0;
    let clock = NOW.getTime();
    const d = inboxData(ALL);
    const s = createListScreen({ tui: { requestRender: () => renders++ }, close() {}, reload: async () => d, act() {}, now: () => new Date(clock), tickMs: 15_000 }, d);
    expect(s.render(100).join("\n")).toContain("my-team-review is running · 3m in");
    clock += 10 * MIN;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(renders).toBeGreaterThan(0);
    expect(s.render(100).join("\n")).toContain("my-team-review is running · 13m in");
    s.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-reads on its own when asked to, so an open page keeps up with other processes", async () => {
    vi.useFakeTimers({ now: NOW });
    let next = inboxData(ALL_GOOD);
    const reads: (boolean | undefined)[] = [];
    let slow: (() => void) | undefined;
    const s = createListScreen(
      {
        tui: { requestRender() {} },
        close() {},
        act() {},
        refreshMs: 10_000,
        reload: async (opts) => {
          reads.push(opts?.background);
          if (reads.length === 2) await new Promise<void>((r) => (slow = r));
          return next;
        },
      },
      next,
    );
    s.handleInput(DOWN);
    const cursor = () => s.render(100).find((l) => l.startsWith("  ❯"));
    const before = cursor();
    expect(s.render(100).join("\n")).not.toContain("my-pr-review failed");
    // The watcher ran my-pr-review in another process and it failed: nothing here started it.
    next = inboxData(ALL_GOOD.map((x) => (x.key === PR_REVIEW.key ? { ...x, last: { outcome: "failed" as const, at: NOW.toISOString() } } : x)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toEqual([true]);
    expect(s.render(100).join("\n")).toContain("my-pr-review failed");
    expect(cursor()).toBe(before);
    // A slow read is never stacked on: the next ticks wait for it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toHaveLength(2);
    slow?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toHaveLength(3);
    s.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-reads when a run really starts or ends, and keeps the cursor on its automation", async () => {
    let running: string[] = [];
    let notify: () => void = () => {};
    const runs: ListRuns = { running: () => running, subscribe: (fn) => ((notify = fn), () => {}) };
    let next = inboxData(ALL_GOOD);
    let reloads = 0;
    const s = screen(next, { runs, reload: async () => (reloads++, next) });
    s.handleInput(DOWN);
    s.handleInput(DOWN); // my-pr-review
    expect(s.render(100).find((l) => l.startsWith("  ❯"))).toContain("my-pr-review");
    notify();
    expect(reloads).toBe(0);
    // my-pr-review starts: it moves to Running now, and the cursor goes with it.
    running = [PR_REVIEW.key];
    next = inboxData([{ ...PR_REVIEW, running: { pid: 1, runId: "x", key: PR_REVIEW.key, startedAt: NOW.toISOString(), timeoutMs: 0, postHooks: 0, trigger: "watch" } }, PR_DIGEST, ISSUE_VERIFY, OLD_CLEANUP]);
    notify();
    await settle();
    expect(reloads).toBeGreaterThanOrEqual(1);
    const lines = s.render(100);
    expect(lines.find((l) => l.startsWith("  ❯"))).toBe("  ❯ ▶ my-pr-review is running · 0s in");
    s.dispose();
  });

  it("keeps a paused watch in Watching, saying so in dim yellow where its interval would be", () => {
    const paused = { ...PR_REVIEW, watchPausedAt: new Date(NOW.getTime() - 60 * MIN).toISOString() };
    const d = inboxData([paused, PR_DIGEST]);
    const lines = screen(d, { theme: MARKED }).render(100);
    const row = lines.find((l) => l.includes("my-pr-review")) ?? "";
    expect(row).toContain("{warning:paused · p resumes");
    expect(comingUp(screen(d).render(100))).toEqual(["my-pr-digest"]);
    expect(watching(screen(d).render(100))).toEqual(["my-pr-review"]);
    expect(triage(d, NOW).needs).toBe(0);
  });

  it("puts a repository automation nobody has armed under Off and disabled, with how to arm it", () => {
    const repo = { path: "/repo/.agents/automations", scope: "repository" as const, kind: "agents" as const };
    const notArmed = { ...status("repo-thing", { manual: true }), key: `repository:${repo.path}:repo-thing`, scope: "repository" as const, root: repo, state: "off" as const, reason: "not armed" };
    const d = inboxData([PR_DIGEST, notArmed, OLD_CLEANUP]);
    const tri = triage(d, NOW);
    expect(tri.needs).toBe(0);
    expect(tri.sections.find((s) => s.id === "off")?.items.map((i) => `${i.kind}:${i.name}`)).toEqual(["off:old-cleanup", "not-armed:repo-thing"]);
    const lines = screen(d).render(100);
    expect(lines[2]).toBe("  ✓ Nothing needs you.");
    expect(lines.find((l) => l.includes("repo-thing"))).toMatch(/^ {4}repo-thing\s+not armed · a arms it after a preview$/);
    expect(agendaRow(tri.sections.find((s) => s.id === "off")?.items[1] as InboxEntry, NOW).note?.text).toBe("not armed · a arms it after a preview");
  });

  it("holds what the watcher would start while it is off, and makes the watcher a card with w", () => {
    const d = inboxData(ALL_GOOD);
    d.facts.watcher = { state: "off" };
    const lines = screen(d).render(100);
    expect(lines[0]).toMatch(/watcher off$/);
    expect(lines.slice(2, 6)).toEqual([
      "  Needs you",
      "  ❯ ! The watcher is off — nothing runs on its own",
      "      my-pr-digest, my-issue-verify and my-pr-review wait for it",
      "      w  start it",
    ]);
    expect(lines.filter((l) => l.includes("on hold"))).toHaveLength(3);
  });
});

describe("an automation's page opens with how it is, in a sentence", () => {
  const d = inboxData(ALL);
  const lead = (s: Status) => automationLead(s, d, NOW);

  it("says a healthy one is healthy, and when it next runs", () => {
    expect(lead(PR_DIGEST)).toEqual({ text: "my-pr-digest is healthy. Next run tomorrow at 08:00, then daily.", color: "success" });
    expect(lead(ISSUE_VERIFY)).toEqual({ text: "my-issue-verify is healthy. Next run Mon at 07:00, then Mondays.", color: "success" });
    expect(lead(PR_REVIEW)).toEqual({ text: "my-pr-review is healthy. Its watch checks in 1 minute, then every 5m.", color: "success" });
  });

  it("says a failed one failed, when, and whether it runs again on its own", () => {
    expect(lead(NIGHTLY)).toEqual({ text: "nightly-report failed 3 hours ago. It runs again on its own today at 22:00, then daily.", color: "error" });
  });

  it("says a running one is running, how long so far, how long it usually takes, and when it gives up", () => {
    expect(lead(TEAM_REVIEW)).toEqual({ text: "my-team-review is running: 3 minutes so far, usually 7. Gives up at 1 hour.", color: "accent" });
  });

  it("says a disabled one is disabled, and what enables it", () => {
    expect(lead(OLD_CLEANUP)).toEqual({ text: "old-cleanup is disabled. Nothing starts it, not even r, until you enable it.", color: "muted" });
  });

  it("then says what it does, its last run with what it published, and every action", () => {
    const s = screen(d, {}, 30);
    s.handleInput(DOWN);
    s.handleInput(DOWN); // my-pr-digest
    s.handleInput("\r");
    const lines = s.render(100);
    expect(lines.slice(0, 18)).toEqual([
      "my-pr-digest",
      "",
      "  my-pr-digest is healthy. Next run tomorrow at 08:00, then daily.",
      "",
      "  Every morning, publishes a digest of our PR work to HTML Canvas and records every run, so the",
      "  team starts the day knowing what moved and what is waiting.",
      "",
      "  Last run   ✓ today 08:01 · took 1m",
      "             PR digest 2026-10-22: nothing needs you this morning; two renderer changes merged.",
      "  Message    Digest published          ↗ \u001B]8;;https://canvas.example/d/2026-10-22\u001B\\Canvas digest\u001B]8;;\u001B\\",
      "             Posted to the team chat   ↗ \u001B]8;;https://group.example/m/123\u001B\\Group message\u001B]8;;\u001B\\",
      "",
      "  ❯ r      run now",
      "    l      its last runs",
      "    e      edit it",
      "    c      check: every technical detail",
      "    space  disable it",
      "",
    ]);
    expect(lines.at(-1)).toMatch(/^↑↓ choose · enter do it\s+esc back$/);
    s.handleInput("\u001b");
    expect(s.render(100).find((l) => l.startsWith("  ❯"))).toContain("my-pr-digest");
    s.dispose();
  });

  it("offers the failed one run again first, then dismiss, and says how often it fails", () => {
    const s = screen(d, {}, 30);
    s.handleInput("\r");
    const text = s.render(100).join("\n");
    expect(text).toContain("  Last run   ✗ failed today 10:52 · took 40s\n             gh: HTTP 502 while posting the report to #builds\n             2 of the last 7 runs failed");
    expect(text).toContain("  ❯ r      run it again now\n    d      dismiss: I've seen it");
    s.dispose();
  });
});

describe("a run's page opens with how it is going, and when it is usually done", () => {
  it("leads with the sentence, says who started it, shows its steps, then the expectation", () => {
    const lines = runPageLines(teamRunView(), 100, NOW, undefined, 0, 7 * MIN).map(stripAnsi);
    expect(lines.slice(0, 11)).toEqual([
      "  my-team-review is running: 3 minutes so far, usually 7. Gives up at 1 hour.",
      "  Started by its watch at 13:47.",
      "",
      "  ✓ Pick a PR",
      "  ▶ Review it",
      "      ✓ Map the change",
      "      ▶ Three reviewers read     2 of 3 reviewers done",
      "      · Post the review",
      "  usually done around 13:54",
      "",
      "  Notes so far",
    ]);
    expect(lines[11]).toBe("    Picked acme/webapp#11911   ↗ PR");
    expect(lines.at(-1)).toBe("  Nothing needed from you. It moves back to Coming up when it finishes.");
    expect(runTitleRight(teamRunView(), NOW, 7 * MIN)).toBe("3m in · usually 7m");
  });

  it("puts the chart's own nodes under the body, also for a run rebuilt from its chart", () => {
    const observed = { ...teamRunView(), steps: teamRunView().steps.map((s) => ({ ...s, extra: true })) };
    const lines = runPageLines(observed, 100, NOW).map(stripAnsi);
    expect(lines.slice(3, 8)).toEqual(["  ✓ Pick a PR", "  ▶ Review it", "      ✓ Map the change", "      ▶ Three reviewers read     2 of 3 reviewers done", "      · Post the review"]);
  });

  it("says when a run is taking longer than usual, and leaves the expectation out when there is none", () => {
    const late = runPageLines(teamRunView(), 100, new Date(NOW.getTime() + 10 * MIN), undefined, 0, 7 * MIN).map(stripAnsi);
    expect(late).toContain("  usually done around 13:54 · this one is taking longer");
    const unknown = runPageLines(teamRunView(), 100, NOW).map(stripAnsi);
    expect(unknown[0]).toBe("  my-team-review is running: 3 minutes so far. Gives up at 1 hour.");
    expect(unknown.join("\n")).not.toContain("usually done");
  });
});

describe("every page is exactly the terminal: rows lines, none wider than it", () => {
  const SIZES = [
    [100, 30],
    [80, 24],
  ] as const;
  const view = teamRunView();
  const registry = { all: () => [{ id: "1", view }], subscribe: () => () => {}, dismiss: () => false, refreshObserved() {} } as unknown as RunRegistry;

  for (const [width, rows] of SIZES) {
    it(`at ${width}×${rows}`, () => {
      const pages: [string, () => string[]][] = [];
      const listPage = (d: ListData, keys: string[] = []) => () => {
        const s = screen(d, {}, rows);
        for (const k of keys) s.handleInput(k);
        const out = s.render(width);
        s.dispose();
        return out;
      };
      const off = inboxData(ALL);
      off.facts.watcher = { state: "off" };
      const paused = inboxData([{ ...PR_REVIEW, watchPausedAt: NOW.toISOString() }, PR_DIGEST, OLD_CLEANUP]);
      pages.push(["list-all-good", listPage(inboxData(ALL_GOOD))]);
      pages.push(["list-mixed", listPage(inboxData(ALL))]);
      pages.push(["details", listPage(inboxData(ALL), [DOWN, DOWN, "\r"])]);
      pages.push(["actions", listPage(inboxData(ALL), ["\r"])]);
      pages.push(["help", listPage(inboxData(ALL), ["?"])]);
      pages.push(["question", listPage(inboxData(ALL), ["w"])]);
      pages.push(["watcher-off", listPage(off)]);
      pages.push(["watcher-page", listPage(off, ["\r"])]);
      pages.push(["paused", listPage(paused)]);
      pages.push(["run", () => createStatusWindow({ registry, tui: { requestRender() {}, terminal: { rows } }, now: () => NOW, close() {}, openRunFor: view.key, usual: () => 7 * MIN }).render(width)]);
      pages.push(["log", () => createRunsPage({ tui: { requestRender() {}, terminal: { rows } }, name: "my-pr-digest", runs: DIGEST_RUNS.map((record) => ({ record })), now: () => NOW, close() {} }).render(width)]);
      for (const [label, render] of pages) {
        const lines = render();
        expect(lines, label).toHaveLength(rows);
        for (const l of lines) expect(visibleWidth(l), `${label}: ${l}`).toBeLessThanOrEqual(width);
        expect(lines[0]?.trim(), label).not.toBe("");
        expect(lines.at(-1)?.trim(), label).not.toBe("");
        // One clock: local, never a record's UTC stamp.
        expect(lines.join("\n"), label).not.toMatch(/\d{4}-\d\d-\d\dT\d\d/);
      }
    });
  }
});

describe("one clock: local time", () => {
  it("shows a run's times on the local clock, whatever the records store", () => {
    // The fixture's runs are at 08:00 local; the records hold them as UTC ISO strings.
    expect(DIGEST_RUNS[6]?.startedAt).toMatch(/Z$/);
    const log = createRunsPage({ tui: { requestRender() {} }, name: "my-pr-digest", runs: DIGEST_RUNS.map((record) => ({ record })), now: () => NOW, close() {} }).render(100);
    expect(log[2]).toMatch(/^ {2}❯ ✓ today 08:00 {6}1m {3}PR digest 2026-10-22/);
    expect(log.find((l) => l.includes("Tue 08:00"))).toMatch(/✗ Tue 08:00 {7}22s {3}gather\.js exited 1/);
    expect(log.find((l) => l.includes("Sat 08:00"))).toBe("    ↷ Sat 08:00             skipped: weekend");
    const s = screen(inboxData(ALL), {}, 30);
    s.handleInput("\r");
    expect(s.render(100).join("\n")).toContain("✗ failed today 10:52");
    s.dispose();
  });
});
