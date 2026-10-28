// The runs page (`l`), the check page (`c`) and every other `/automations` page, at the two sizes
// people actually use: 140×45 and 80×24.

import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { listingModel } from "../src/listing.js";
import type { Located, RunRecord, Status } from "../src/types.js";
import { checkPageLines } from "../src/ui/check.js";
import { createListScreen, type ListData } from "../src/ui/list.js";
import { consentActions, createPager, readerActions } from "../src/ui/pager.js";
import { RunRegistry } from "../src/ui/registry.js";
import { createRunsPage } from "../src/ui/runs.js";
import { visibleWidth } from "../src/ui/width.js";
import { createStatusWindow } from "../src/ui/window.js";
import { ensureDir, statePaths } from "../src/paths.js";
import { tempDir } from "./helpers/temp.js";

const NOW = new Date(2026, 9, 22, 12, 4, 0);
const HOME = "/home/me";
const SIZES = [
  [140, 45],
  [100, 30],
  [80, 24],
] as const;
const HINTS = /esc close|esc back|any key closes|\? help|y stop the watcher/;

const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

function automation(name: string, on: NonNullable<Status["automation"]>["on"], description = `${name} does one useful thing every day for the team.`): NonNullable<Status["automation"]> {
  return { name, description, enabled: true, on, hooks: { pre: [{ script: "scripts/pick.js" }], post: [] }, body: "b", model: "github-copilot/gpt-6.1-sol" };
}

function status(name: string, over: Partial<Status> = {}): Status {
  const root = `${HOME}/.agents/automations`;
  return {
    key: `user:${root}:${name}`,
    name,
    scope: "user",
    root: { path: root, scope: "user", kind: "agents" },
    dir: `${root}/${name}`,
    state: "armed",
    effectiveTimeoutMs: 600_000,
    staggerSec: 0,
    automation: automation(name, { manual: true, watch: { script: "scripts/watch.js", every: "15m" } }),
    nextCheck: ahead(3 * 60_000),
    ...over,
  } as Status;
}

function record(name: string, id: string, startedAgo: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    key: `user:${HOME}/.agents/automations:${name}`,
    name,
    scope: "user",
    root: `${HOME}/.agents/automations`,
    trigger: "watch",
    late: false,
    recordedAt: ago(startedAgo - 8 * 60_000),
    startedAt: ago(startedAgo),
    endedAt: ago(startedAgo - 8 * 60_000),
    outcome: "ok",
    output: { text: `acme/webapp#${id} feat(plugin-builder): build the hash-verified package on Create, reviewed with receipts` },
    ...over,
  };
}

const NOTES = [
  { ts: ago(26 * 60_000), text: "Review posted on the pull request", links: [{ label: "PR #11911", url: "https://github.test/pr/11911" }] },
  { ts: ago(25 * 60_000), text: "Told the team", links: [{ label: "Group", url: "https://group.test/m/1" }, { url: "https://canvas.test/d/9" }] },
];

const mixed: Status[] = [
  status("my-team-review", { last: { outcome: "ok", at: ago(26 * 60_000) } }),
  status("nightly-report", { last: { outcome: "failed", at: ago(2 * 3_600_000) } }),
  status("slow-sync", { running: { pid: 1, runId: "r", key: "k", startedAt: ago(192_000), timeoutMs: 1_800_000, postHooks: 0, trigger: "manual" } }),
  status("old-cleanup", { state: "disabled" }),
  status("repo-thing", { scope: "repository", state: "off", reason: "not armed", key: "repository:/repo/.agents/automations:repo-thing", root: { path: "/repo/.agents/automations", scope: "repository", kind: "agents" }, dir: "/repo/.agents/automations/repo-thing" }),
];

function listData(statuses: Status[], watcher: ListData["facts"]["watcher"] = { state: "on", lastTickAt: ago(30_000) }): ListData {
  const counts = { armed: 0, off: 0, disabled: 0, invalid: 0 };
  for (const s of statuses) counts[s.state]++;
  const records = [record("my-team-review", "a", 30 * 3_600_000), record("my-team-review", "b", 26 * 60_000, { notes: NOTES })];
  return {
    model: listingModel(statuses, { home: HOME, projectRoots: ["/repo"], now: NOW }),
    facts: { counts, running: statuses.filter((s) => s.running).length, watcher },
    details: {
      [statuses[0]?.key ?? ""]: { records, lastRecord: records[1] as RunRecord },
      [statuses[1]?.key ?? ""]: { records: [record("nightly-report", "f", 2 * 3_600_000, { outcome: "failed", error: { kind: "body", message: "gh: HTTP 502 while posting the report" } })] },
    },
    now: NOW,
  };
}

function expectFullScreen(lines: string[], width: number, rows: number, label: string): void {
  expect(lines, label).toHaveLength(rows);
  for (const l of lines) expect(visibleWidth(l), `${label}: ${l}`).toBeLessThanOrEqual(width);
  // One hint line, and it is the last.
  expect(lines.filter((l) => HINTS.test(l)), label).toHaveLength(1);
  expect(lines.at(-1), label).toMatch(HINTS);
  expect(lines[0]?.trim(), label).not.toBe("");
}

describe("every page fills the terminal exactly, at 140×45, 100×30 and 80×24", () => {
  for (const [width, rows] of SIZES) {
    const tui = { requestRender: () => {}, terminal: { rows } };

    it(`the list, its help, its menu and its question, at ${width}×${rows}`, () => {
      const pages: [string, (s: ReturnType<typeof createListScreen>) => void][] = [
        ["list", () => {}],
        ["help", (s) => s.handleInput("?")],
        ["menu", (s) => s.handleInput("\r")],
        ["question", (s) => s.handleInput("w")],
      ];
      for (const [label, open] of pages) {
        const d = listData(mixed);
        const screen = createListScreen({ tui, close() {}, reload: async () => d, act() {}, actGlobal() {} }, d);
        open(screen);
        expectFullScreen(screen.render(width), width, rows, `${label} ${width}×${rows}`);
        screen.dispose();
      }
    });

    it(`the list never wraps a row or a detail at ${width}×${rows}`, () => {
      const d = listData(mixed);
      const screen = createListScreen({ tui, close() {}, reload: async () => d, act() {} }, d);
      for (let i = 0; i < mixed.length; i++) {
        const lines = screen.render(width);
        expectFullScreen(lines, width, rows, `row ${i}`);
        screen.handleInput("\u001b[B");
      }
      screen.dispose();
    });

    it(`the runs page and the check page at ${width}×${rows}`, () => {
      const runs = createRunsPage({
        tui,
        name: "my-team-review",
        runs: Array.from({ length: 30 }, (_, i) => ({ record: record("my-team-review", String(i), (30 - i) * 3_600_000, i === 29 ? { notes: NOTES } : {}) })),
        now: () => NOW,
        close() {},
      });
      expectFullScreen(runs.render(width), width, rows, "runs");

      const check = createPager({
        tui,
        title: "my-team-review · check",
        lines: checkPageLines({ status: mixed[0] as Status, now: NOW, home: HOME, config: DEFAULTS, records: [record("my-team-review", "a", 3_600_000)], digest: `sha256:${"a".repeat(64)}`, interpreters: { "scripts/watch.js": `D:\\Users\\me\\AppData\\Local\\mise\\installs\\node\\24.12.0\\node.exe scripts/watch.js` } }),
        actions: readerActions(),
        otherwise: "ignore",
        resolve() {},
      });
      expectFullScreen(check.render(width), width, rows, "check");

      const consent = createPager({ tui, title: "Arm repo-thing", lines: Array.from({ length: 60 }, (_, i) => `line ${i}`), actions: consentActions(), otherwise: "reject", resolve() {} });
      const page = consent.render(width);
      expect(page).toHaveLength(rows);
      expect(page.at(-1)).toMatch(/y arm · n \/ esc keep off$/);
    });

    it(`the Running page, a run page and its flowchart at ${width}×${rows}`, () => {
      const dir = tempDir("pi-full-win-");
      ensureDir(statePaths(dir).logs);
      const registry = new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => NOW });
      const located: Located = {
        automation: automation("slow-sync", { manual: true }),
        dir: `${HOME}/.agents/automations/slow-sync`,
        file: `${HOME}/.agents/automations/slow-sync/AUTOMATION.md`,
        root: { path: `${HOME}/.agents/automations`, scope: "user", kind: "agents" },
        key: `user:${HOME}/.agents/automations:slow-sync`,
      };
      const id = registry.addAttached({ located, trigger: "manual", timeoutMs: 1_800_000 });
      registry.applyEvent(id, { event: "flow", run: "s-1" });
      const win = createStatusWindow({ registry, tui, now: () => new Date(NOW.getTime() + 60_000), close() {}, flowView: () => ({ kind: "graph", lines: Array.from({ length: 80 }, (_, i) => `node ${i}`) }) });
      expectFullScreen(win.render(width), width, rows, "runs list");
      win.handleInput("\r");
      const page = win.render(width);
      expectFullScreen(page, width, rows, "run page");
      expect(page[0]).toMatch(/^slow-sync · running\s+1m in$/);
      win.handleInput("g");
      expectFullScreen(win.render(width), width, rows, "chart");
      win.dispose();
    });
  }
});

describe("the list's first lines", () => {
  const page = (statuses: Status[], watcher?: ListData["facts"]["watcher"]): string[] => {
    const d = listData(statuses, watcher);
    const screen = createListScreen({ tui: { requestRender() {} }, close() {}, reload: async () => d, act() {}, actGlobal() {} }, d);
    const lines = screen.render(120);
    screen.dispose();
    return lines;
  };

  it("say where you are, then answer whether anything needs you", () => {
    const good = page([status("a"), status("b")]);
    expect(good[0]).toMatch(/^Automations\s+watcher on$/);
    expect(good[2]).toBe("  ✓ Nothing needs you.");
    // Running is not a problem: the answer is still that nothing needs you.
    expect(page([status("a"), mixed[2] as Status])[2]).toBe("  ✓ Nothing needs you.");
    const bad = page(mixed);
    expect(bad[2]).toBe("  Needs you");
    expect(bad[3]).toMatch(/^ {2}❯ ✗ nightly-report failed 2h ago$/);
    const off = page([status("a")], { state: "off" });
    expect(off[0]).toMatch(/^Automations\s+watcher off$/);
    expect(off[3]).toBe("  ❯ ! The watcher is off — nothing runs on its own");
  });
});

describe("the runs page", () => {
  const runs = [
    { record: record("r", "old", 26 * 3_600_000) },
    { record: record("r", "mid", 3 * 3_600_000, { outcome: "failed", error: { kind: "body", message: "gh: HTTP 502" } }) },
    { record: record("r", "new", 26 * 60_000, { notes: NOTES }), problems: ["the workspace did not release"] },
  ];

  it("lists the runs newest first, in local time, the same clock as the list", () => {
    const page = createRunsPage({ tui: { requestRender() {} }, name: "r", runs, now: () => NOW, close() {} });
    const lines = page.render(120);
    expect(lines[0]).toBe("r · runs");
    const rows = lines.filter((l) => /^ {2}[❯ ] [✓✗]/.test(l));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^ {2}❯ ✓ 26m ago {9}8m {3}acme\/webapp#new/);
    expect(rows[1]).toMatch(/^ {4}✗ today 09:04 {5}8m {3}gh: HTTP 502$/);
    expect(rows[2]).toMatch(/^ {4}✓ yesterday 10:04 8m {3}acme\/webapp#old/);
    expect(lines.join("\n")).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });

  it("shows the selected run's notes with their links, and what a provider said about it", () => {
    const page = createRunsPage({ tui: { requestRender() {} }, name: "r", runs, now: () => NOW, close() {} });
    const text = page.render(120).join("\n");
    expect(text).toContain("Review posted on the pull request");
    expect(text).toContain("\u001B]8;;https://github.test/pr/11911\u001B\\PR #11911\u001B]8;;\u001B\\");
    expect(text).toContain("provider: the workspace did not release");
    page.handleInput("\u001b[B");
    const second = page.render(120).join("\n");
    expect(second).toMatch(/^ {2}❯ ✗ today 09:04/m);
    expect(second).not.toContain("Review posted");
  });

  it("closes on esc or q, and says so when there is nothing to show", () => {
    let closed = 0;
    const page = createRunsPage({ tui: { requestRender() {} }, name: "r", runs: [], now: () => NOW, close: () => closed++ });
    expect(page.render(80).join("\n")).toContain("r has not run yet");
    page.handleInput("\u001b");
    page.handleInput("q");
    expect(closed).toBe(2);
  });
});

describe("the check page", () => {
  it("groups everything technical under Schedule, Last check, Runs, Setup and Files", () => {
    const s = status("my-team-review", {
      watch: { checkedAt: ago(11 * 60_000), exit: 3, durationMs: 5000, said: "nothing to review", firedAt: ago(26 * 60_000) },
    });
    const lines = checkPageLines({ status: s, now: NOW, home: HOME, config: DEFAULTS, records: [record("my-team-review", "a", 26 * 60_000)], digest: "sha256:abc", interpreters: { "scripts/pick.js": "node scripts/pick.js" } });
    expect(lines.filter((l) => /^[A-Z]/.test(l))).toEqual(["Schedule", "Last check", "Runs", "Setup", "Files"]);
    const text = lines.join("\n");
    expect(text).toContain("  Checked       11m ago · nothing to do (exit 3) · took 5s");
    expect(text).toContain("  It said       “nothing to review”");
    expect(text).toContain("  Next check    in 3m");
    expect(text).toContain("  Model         github-copilot/gpt-6.1-sol");
    expect(text).toContain("  Interpreter   scripts/pick.js → node scripts/pick.js");
    expect(text).toContain("  Digest        sha256:abc");
    expect(text).toContain("  Directory     ~/.agents/automations/my-team-review");
  });

  it("opens with the problem when the file is broken", () => {
    const lines = checkPageLines({ status: status("broken", { state: "invalid", reason: "on.schedule.cron: not a 5-field cron expression" }), now: NOW, home: HOME, config: DEFAULTS });
    expect(lines[0]).toBe("Problem");
    expect(lines[1]).toContain("Error         on.schedule.cron");
    expect(lines[2]).toContain("Hint          a cron is five fields");
  });
});
