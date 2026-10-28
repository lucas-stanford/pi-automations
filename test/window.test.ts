/** The Running page component. */

import { afterAll, describe, expect, it, vi } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { ensureDir, statePaths } from "../src/paths.js";
import { RunRegistry } from "../src/ui/registry.js";
import { createStatusWindow } from "../src/ui/window.js";
import type { Located, RunRecord } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

function located(name: string): Located {
  return {
    automation: {
      name,
      description: "d",
      enabled: true,
      on: { manual: true },
      hooks: { pre: [{ script: "counts.js" }], post: [] },
      body: "b",
    },
    dir: `/a/.agents/automations/${name}`,
    file: `/a/.agents/automations/${name}/AUTOMATION.md`,
    root: { path: "/a/.agents/automations", scope: "user", kind: "agents" },
    key: `user:/a/.agents/automations:${name}`,
  };
}

function record(name: string): RunRecord {
  return {
    id: `run-${name}`,
    key: `user:/a/.agents/automations:${name}`,
    name,
    scope: "user",
    root: "/a/.agents/automations",
    trigger: "manual",
    late: false,
    recordedAt: "2026-09-17T10:00:00.000Z",
    outcome: "ok",
  };
}

function harness(opts: { spinnerMs?: number } = {}) {
  const dir = tempDir("pi-win-");
  ensureDir(statePaths(dir).logs);
  ensureDir(statePaths(dir).locks);
  const registry = new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date() });

  let renders = 0;
  let closed = 0;
  const logged: string[] = [];

  const win = createStatusWindow({
    registry,
    tui: {
      requestRender: () => {
        renders++;
      },
    },
    now: () => new Date("2026-09-17T10:00:42.000Z"),
    close: () => {
      closed++;
    },
    onLog: (v) => logged.push(v.name),
    ...(opts.spinnerMs !== undefined ? { spinnerMs: opts.spinnerMs } : {}),
  });

  return {
    dir,
    registry,
    win,
    logged,
    get renders() {
      return renders;
    },
    get closed() {
      return closed;
    },
  };
}

describe("createStatusWindow — rendering", () => {
  it("says nothing is running when the registry is empty", () => {
    const h = harness();
    const lines = h.win.render(60);
    expect(lines[0]).toMatch(/^Running\s+nothing running$/);
    expect(lines[2]).toBe("  ✓ Nothing running.");
    h.win.dispose();
  });

  it("shows a run as a card as soon as it is registered, and its plan one enter away", () => {
    const h = harness();
    h.registry.addAttached({ located: located("flow-example"), trigger: "manual", timeoutMs: 1000 });
    const lines = h.win.render(80);
    expect(lines[0]).toMatch(/^Running\s+1 running$/);
    expect(lines.slice(2, 6)).toEqual([
      "  Running now",
      expect.stringMatching(/^ {2}❯ ▶ flow-example is running · \d+s in$/),
      expect.stringMatching(/^ {6}started by hand at \d\d:\d\d$/),
      "      enter  show it",
    ]);
    // The card's own key is not repeated on the hint line.
    expect(lines.at(-1)).toMatch(/^↑↓ move · x stop it · l runs\s+esc back$/);
    h.win.handleInput("\r");
    expect(h.win.render(80).join("\n")).toContain("pre hook · counts.js");
    h.win.dispose();
  });

  it("draws a finished run as how it went, what it said, and d", () => {
    const h = harness();
    const id = h.registry.addAttached({ located: located("digest"), trigger: "manual", timeoutMs: 1000 });
    h.registry.applyEvent(id, { event: "record", record: { ...record("digest"), output: { text: "3 merged" } } });
    const lines = h.win.render(80);
    expect(lines[2]).toBe("  Finished");
    expect(lines[3]).toMatch(/^ {2}❯ ✓ digest finished /);
    expect(lines[4]).toBe("      3 merged");
    expect(lines[5]).toBe("      d  dismiss it");
    expect(lines.at(-1)).toMatch(/^↑↓ move · enter open · l runs\s+esc back$/);
    h.win.dispose();
  });

  it("re-renders when the registry changes", () => {
    const h = harness();
    const before = h.renders;
    h.registry.addAttached({ located: located("a"), trigger: "manual", timeoutMs: 1000 });
    expect(h.renders).toBeGreaterThan(before);
    h.win.dispose();
  });
});

describe("createStatusWindow — the spinner timer", () => {
  it("does not run while no step is active", () => {
    vi.useFakeTimers();
    try {
      const h = harness({ spinnerMs: 10 });
      h.registry.addAttached({ located: located("a"), trigger: "manual", timeoutMs: 1000 });
      const before = h.renders;
      vi.advanceTimersByTime(100);
      expect(h.renders).toBe(before);
      h.win.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts when a step goes active and stops when the run ends", () => {
    vi.useFakeTimers();
    try {
      const h = harness({ spinnerMs: 10 });
      const id = h.registry.addAttached({
        located: located("a"),
        trigger: "manual",
        timeoutMs: 1000,
      });
      h.registry.applyEvent(id, { event: "hook-start", phase: "pre", index: 0, source: "counts.js" });

      const spinning = h.renders;
      vi.advanceTimersByTime(35);
      expect(h.renders).toBeGreaterThan(spinning);

      h.registry.applyEvent(id, { event: "record", record: record("a") });
      const stopped = h.renders;
      vi.advanceTimersByTime(100);
      expect(h.renders).toBe(stopped);
      h.win.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops on dispose, so a closed window leaves no timer behind", () => {
    vi.useFakeTimers();
    try {
      const h = harness({ spinnerMs: 10 });
      const id = h.registry.addAttached({
        located: located("a"),
        trigger: "manual",
        timeoutMs: 1000,
      });
      h.registry.applyEvent(id, { event: "hook-start", phase: "pre", index: 0, source: "counts.js" });
      h.win.dispose();
      const after = h.renders;
      vi.advanceTimersByTime(200);
      expect(h.renders).toBe(after);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes on dispose, so a later change cannot reach it", () => {
    const h = harness();
    h.win.dispose();
    const after = h.renders;
    h.registry.addAttached({ located: located("a"), trigger: "manual", timeoutMs: 1000 });
    expect(h.renders).toBe(after);
  });
});

describe("createStatusWindow — keys", () => {
  function twoRuns() {
    const h = harness();
    h.registry.addAttached({ located: located("alpha"), trigger: "manual", timeoutMs: 1000 });
    const b = h.registry.addAttached({ located: located("beta"), trigger: "manual", timeoutMs: 1000 });
    return { ...h, b };
  }

  it("esc closes the list", () => {
    const h = harness();
    h.win.handleInput("\u001b");
    expect(h.closed).toBe(1);
    h.win.dispose();
  });

  it("moves the cursor with both arrow encodings and clamps at the ends", () => {
    for (const [up, down] of [
      ["\u001b[A", "\u001b[B"],
      ["\u001bOA", "\u001bOB"],
    ]) {
      const h = twoRuns();
      h.win.handleInput(down as string);
      expect(h.win.render(80).find((l) => l.includes("beta"))?.startsWith("  ❯")).toBe(true);
      h.win.handleInput(down as string);
      expect(h.win.render(80).find((l) => l.includes("beta"))?.startsWith("  ❯")).toBe(true);
      h.win.handleInput(up as string);
      h.win.handleInput(up as string);
      expect(h.win.render(80).find((l) => l.includes("alpha"))?.startsWith("  ❯")).toBe(true);
      h.win.dispose();
    }
  });

  it("enter opens details for the selected row and esc goes back without closing", () => {
    const h = twoRuns();
    h.win.handleInput("\u001b[B");
    h.win.handleInput("\r");
    const detail = h.win.render(80);
    expect(detail[0]).toMatch(/^beta · running\s+\d+s in$/);
    expect(detail.join("\n")).not.toContain("alpha");

    h.win.handleInput("\u001b");
    expect(h.closed).toBe(0);
    expect(h.win.render(80)[0]).toContain("running");
    h.win.dispose();
  });

  it("l reports the selected run, not the first one", () => {
    const h = twoRuns();
    h.win.handleInput("\u001b[B");
    h.win.handleInput("l");
    expect(h.logged).toEqual(["beta"]);
    h.win.dispose();
  });

  it("d refuses a running row and removes a finished one", () => {
    const h = twoRuns();
    h.win.handleInput("d");
    expect(h.registry.size).toBe(2);

    h.registry.applyEvent(h.b, { event: "record", record: record("beta") });
    // beta is finished, so it sorts last; move to it.
    h.win.handleInput("\u001b[B");
    h.win.handleInput("d");
    expect(h.registry.size).toBe(1);
    h.win.dispose();
  });

  it("keeps the cursor inside the list when a run disappears from under it", () => {
    const h = twoRuns();
    h.win.handleInput("\u001b[B");
    h.registry.applyEvent(h.b, { event: "record", record: record("beta") });
    h.registry.dismiss(h.b);
    // Must not throw and must not render a cursor past the end.
    expect(() => h.win.render(80)).not.toThrow();
    expect(h.win.render(80).find((l) => l.includes("alpha"))?.startsWith("  ❯")).toBe(true);
    h.win.dispose();
  });

  it("closes the details view when the run it was showing is dismissed elsewhere", () => {
    const h = twoRuns();
    h.win.handleInput("\u001b[B");
    h.registry.applyEvent(h.b, { event: "record", record: record("beta") });
    h.win.handleInput("\r");
    expect(h.win.render(80)[0]).toBe("beta · ok");

    h.registry.dismiss(h.b);
    expect(h.win.render(80)[0]).not.toContain("beta");
    expect(h.win.render(80)[0]).toMatch(/^Running\s+1 running$/);
    h.win.dispose();
  });

  it("ignores keys it does not own", () => {
    const h = twoRuns();
    const before = h.win.render(80).join("\n");
    for (const k of ["x", "\u0003", "Z", "\u001b[Z"]) h.win.handleInput(k);
    expect(h.win.render(80).join("\n")).toBe(before);
    expect(h.closed).toBe(0);
    h.win.dispose();
  });

  it("v does nothing: the window is always the whole screen", () => {
    const h = twoRuns();
    const before = h.win.render(80).join("\n");
    expect(before).not.toContain("v view");
    h.win.handleInput("v");
    expect(h.win.render(80).join("\n")).toBe(before);
    expect(h.closed).toBe(0);
    h.win.dispose();
  });

  it("uses the real terminal height so paging cannot skip clipped graph rows", () => {
    const dir = tempDir("pi-win-short-");
    ensureDir(statePaths(dir).logs);
    const registry = new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date() });
    const graph = Array.from({ length: 30 }, (_, index) => `graph row ${index + 1}`);
    const win = createStatusWindow({
      registry,
      tui: { requestRender: () => {}, terminal: { rows: 24 } },
      now: () => new Date(),
      close: () => {},
      flowView: () => ({ kind: "graph", lines: graph }),
    });
    const id = registry.addAttached({
      located: located("short-terminal"),
      trigger: "manual",
      timeoutMs: 1000,
    });
    registry.applyEvent(id, { event: "flow", run: "s-1" });

    win.handleInput("\r");
    win.handleInput("g");
    const page = win.render(80);
    expect(page).toHaveLength(24);
    const first = page.join("\n");
    expect(first).toContain("graph row 1\n");
    expect(first).toContain("graph row 20");
    expect(first).not.toContain("graph row 21");
    expect(first).toContain("rows 1-20 of 30");

    win.handleInput("\u001b[6~");
    const second = win.render(80).join("\n");
    expect(second).toContain("graph row 21");
    expect(second).toContain("graph row 30");
    expect(second).toContain("rows 11-30 of 30");
    win.dispose();
  });

  it("survives every key on an empty list", () => {
    const h = harness();
    for (const k of ["\u001b[A", "\u001b[B", "\r", "d", "l", "R", "\u001b[5~"]) {
      expect(() => h.win.handleInput(k)).not.toThrow();
    }
    h.win.dispose();
  });
});

describe("createStatusWindow — a render host that has gone away", () => {
  it("stops touching it after the first failure instead of throwing per event", () => {
    const dir = tempDir("pi-win-dead-");
    ensureDir(statePaths(dir).logs);
    const registry = new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date() });
    let calls = 0;
    const win = createStatusWindow({
      registry,
      tui: {
        requestRender: () => {
          calls++;
          throw new Error("stale TUI");
        },
      },
      now: () => new Date(),
      close: () => {},
    });

    expect(() =>
      registry.addAttached({ located: located("a"), trigger: "manual", timeoutMs: 1000 }),
    ).not.toThrow();
    const first = calls;
    registry.addAttached({ located: located("b"), trigger: "manual", timeoutMs: 1000 });
    expect(calls).toBe(first);
    win.dispose();
  });
});

describe("createStatusWindow — one run's page", () => {
  it("opens straight onto the run the list asked for, and esc goes back to where it was opened from", () => {
    const dir = tempDir("pi-win-open-");
    ensureDir(statePaths(dir).logs);
    const registry = new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date() });
    registry.addAttached({ located: located("alpha"), trigger: "manual", timeoutMs: 1000 });
    registry.addAttached({ located: located("beta"), trigger: "manual", timeoutMs: 60_000 });
    let closed = 0;
    const win = createStatusWindow({
      registry,
      tui: { requestRender: () => {} },
      now: () => new Date(Date.now() + 192_000),
      close: () => closed++,
      openRunFor: located("beta").key,
    });
    const page = win.render(80);
    expect(page[0]).toMatch(/^beta · running\s+3m in$/);
    expect(page.join("\n")).toContain("beta is running: 3 minutes so far. Gives up at 1 minute.");
    expect(page.join("\n")).toContain("pre hook · counts.js");
    expect(page.at(-1)).toMatch(/^x stop it · s session\s+esc back$/);
    win.handleInput("\u001b");
    expect(closed).toBe(1);
    win.dispose();
  });

  it("shows what a finished run published, with its links, above the technical detail", () => {
    const h = harness();
    const id = h.registry.addAttached({ located: located("digest"), trigger: "manual", timeoutMs: 1000 });
    h.registry.applyEvent(id, {
      event: "record",
      record: { ...record("digest"), output: { text: "3 merged" }, notes: [{ ts: "2026-09-17T10:00:00.000Z", text: "Published", links: [{ label: "canvas", url: "https://c.test/1" }] }] },
    });
    h.win.handleInput("\r");
    const text = h.win.render(100).join("\n");
    expect(text.indexOf("Notes")).toBeLessThan(text.indexOf("Details"));
    expect(text).toContain("Published");
    expect(text).toContain("\u001B]8;;https://c.test/1\u001B\\canvas");
    expect(text).toContain("3 merged");
    h.win.dispose();
  });
});

describe("createStatusWindow — the graph view", () => {
  function tracked() {
    const h = harness();
    const id = h.registry.addAttached({
      located: located("flow-demo"),
      trigger: "manual",
      timeoutMs: 1000,
    });
    h.registry.applyEvent(id, { event: "flow", run: "s-1" });
    return { ...h, id };
  }

  it("offers the graph key only for a tracked run", () => {
    const plain = harness();
    plain.registry.addAttached({ located: located("a"), trigger: "manual", timeoutMs: 1000 });
    plain.win.handleInput("\r");
    expect(plain.win.render(80).join("\n")).not.toContain("g flowchart");
    plain.win.dispose();

    const h = tracked();
    h.win.handleInput("\r");
    expect(h.win.render(80).join("\n")).toContain("g flowchart");
    h.win.dispose();
  });

  it("g shows what the host provides, and says so in the title", () => {
    const dir = tempDir("pi-win-graph-");
    ensureDir(statePaths(dir).logs);
    const registry = new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date() });
    const win = createStatusWindow({
      registry,
      tui: { requestRender: () => {} },
      now: () => new Date(),
      close: () => {},
      flowView: () => ({ kind: "graph", lines: ["┌─ fetch ─┐"] }),
    });
    const id = registry.addAttached({
      located: located("flow-demo"),
      trigger: "manual",
      timeoutMs: 1000,
    });
    registry.applyEvent(id, { event: "flow", run: "s-1" });

    win.handleInput("\r");
    win.handleInput("g");
    const out = win.render(80);
    expect(out[0]).toBe("flow-demo · flowchart");
    expect(out.join("\n")).toContain("fetch");
    win.dispose();
  });

  it("esc leaves the graph for the details, not for the list", () => {
    const h = tracked();
    h.win.handleInput("\r");
    h.win.handleInput("g");
    h.win.handleInput("\u001b");
    expect(h.win.render(80)[0]).toMatch(/^flow-demo · running/);
    expect(h.closed).toBe(0);

    h.win.handleInput("\u001b");
    expect(h.win.render(80)[0]).toMatch(/^Running\s+1 running$/);
    expect(h.closed).toBe(0);
    h.win.dispose();
  });

  it("distinguishes an untracked run from one whose progress cannot be read", () => {
    // Tracked, but nothing to draw it with: the progress is what is missing, not the flowchart.
    const h = tracked();
    h.win.handleInput("\r");
    h.win.handleInput("g");
    expect(h.win.render(80).join("\n")).toContain("cannot be read right now");
    h.win.dispose();

    // Untracked: the useful answer names the file to add.
    const p = harness();
    p.registry.addAttached({ located: located("plain"), trigger: "manual", timeoutMs: 1000 });
    p.win.handleInput("\r");
    p.win.handleInput("g");
    const text = p.win.render(80).join("\n");
    expect(text).toContain("not tracked");
    expect(text).toContain("```mermaid flowchart");
    p.win.dispose();
  });

  it("has no o key any more: fm no longer has a web page to open", () => {
    const h = tracked();
    h.win.handleInput("\r");
    const text = h.win.render(80).join("\n");
    expect(text).toContain("g flowchart");
    expect(text).not.toContain("o open");
    expect(() => h.win.handleInput("o")).not.toThrow();
    h.win.dispose();
  });
});
describe("createStatusWindow — a graph taller than the pane", () => {
  function withGraph(lines: string[]) {
    const dir = tempDir("pi-win-tall-");
    ensureDir(statePaths(dir).logs);
    const registry = new RunRegistry({ stateDir: dir, config: DEFAULTS, now: () => new Date() });
    const win = createStatusWindow({
      registry,
      tui: { requestRender: () => {} },
      now: () => new Date(),
      close: () => {},
      flowView: () => ({ kind: "graph", lines }),
    });
    const id = registry.addAttached({
      located: located("flow-demo"),
      trigger: "manual",
      timeoutMs: 1000,
    });
    registry.applyEvent(id, { event: "flow", run: "s-1" });
    win.handleInput("\r");
    win.handleInput("g");
    return win;
  }

  const tall = Array.from({ length: 50 }, (_, i) => `row-${i}`);

  it("shows a short graph whole, with no scroll marker", () => {
    const win = withGraph(["a", "b", "c"]);
    const text = win.render(80).join("\n");
    expect(text).toContain("a");
    expect(text).not.toContain("rows 1-");
    win.dispose();
  });

  it("does NOT silently cut a tall graph — it says what it is showing", () => {
    const win = withGraph(tall);
    const text = win.render(80).join("\n");
    expect(text).toMatch(/rows 1-\d+ of 50/);
    expect(text).toContain("row-0");
    expect(text).not.toContain("row-49");
    win.dispose();
  });

  it("scrolls to the bottom and clamps there", () => {
    const win = withGraph(tall);
    for (let i = 0; i < 100; i++) win.handleInput("\u001b[B");
    const text = win.render(80).join("\n");
    expect(text).toContain("row-49");
    expect(text).toMatch(/of 50/);
    win.dispose();
  });

  it("End jumps to the bottom and Home back to the top", () => {
    const win = withGraph(tall);
    win.handleInput("\u001b[F");
    expect(win.render(80).join("\n")).toContain("row-49");
    win.handleInput("\u001b[H");
    expect(win.render(80).join("\n")).toContain("row-0");
    win.dispose();
  });

  it("arrows scroll the chart rather than moving the row cursor", () => {
    const win = withGraph(tall);
    win.handleInput("\u001b[B");
    const text = win.render(80).join("\n");
    expect(text).toContain("row-1");
    expect(text).not.toContain("row-0\n");
    win.dispose();
  });

  it("forgets the scroll position when the graph is closed and reopened", () => {
    const win = withGraph(tall);
    win.handleInput("\u001b[F");
    expect(win.render(80).join("\n")).toContain("row-49");
    win.handleInput("\u001b"); // back to details
    win.handleInput("g"); // and into the graph again
    expect(win.render(80).join("\n")).toContain("row-0");
    win.dispose();
  });
});
