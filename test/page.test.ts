// The frame every `/automations` page shares, and the small helpers it is built from.
//
// Line 1 is the title, the last line is the one hint line, and when the terminal's height is known
// the page is exactly that tall — which is what lets it cover pi completely.

import { describe, expect, it } from "vitest";

import { noteRows } from "../src/ui/graph.js";
import { hintLine, pageRows, renderPage, windowBlock } from "../src/ui/page.js";
import { visibleWidth, wrapHanging } from "../src/ui/width.js";
import { momentWords } from "../src/ui/words.js";

describe("renderPage", () => {
  const frame = {
    title: "Automations · All good",
    right: "watcher on",
    body: ["one", "two"],
    hints: [
      { text: "↑↓ move", rank: 4 },
      { text: "enter actions", rank: 2 },
      { text: "r run", rank: 1 },
      { text: "e edit", rank: 3 },
    ],
    pinned: ["? help", "esc close"],
  };

  it("is exactly as tall as the terminal: title, body, padding, and the hint line last", () => {
    for (const [w, rows] of [
      [140, 45],
      [80, 24],
    ] as const) {
      const lines = renderPage(frame, w, rows);
      expect(lines).toHaveLength(rows);
      expect(lines[0]).toMatch(/^Automations · All good\s+watcher on$/);
      expect(lines[2]).toBe("one");
      expect(lines.at(-1)).toMatch(/^↑↓ move · enter actions · r run · e edit\s+\? help · esc close$/);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
    }
  });

  it("cuts a body that does not fit rather than growing past the terminal", () => {
    const lines = renderPage({ ...frame, body: Array.from({ length: 100 }, (_, i) => `row ${i}`) }, 80, 24);
    expect(lines).toHaveLength(24);
    expect(lines.at(-1)).toContain("esc close");
  });

  it("is as tall as its content when the host does not know the terminal's height", () => {
    expect(renderPage(frame, 80, undefined)).toHaveLength(6);
    expect(pageRows({})).toBeUndefined();
    expect(pageRows({ terminal: { rows: 24 } })).toBe(24);
  });

  it("puts a flash where the hints were, for as long as it lasts", () => {
    const lines = renderPage({ ...frame, flash: { text: "started daily", color: "success" } }, 80, 24);
    expect(lines.at(-1)).toBe("started daily");
    expect(lines.filter((l) => l.includes("esc close"))).toHaveLength(0);
  });
});

describe("hintLine", () => {
  it("drops the least important hints first and never the pinned ones", () => {
    const hints = [
      { text: "↑↓ move", rank: 4 },
      { text: "enter actions", rank: 2 },
      { text: "r run", rank: 1 },
      { text: "e edit", rank: 3 },
    ];
    expect(hintLine(hints, ["? help", "esc close"], 60)).toMatch(/^enter actions · r run · e edit\s+\? help · esc close$/);
    expect(hintLine(hints, ["? help", "esc close"], 44)).toMatch(/^enter actions · r run\s+\? help · esc close$/);
    expect(hintLine(hints, ["? help", "esc close"], 22)).toBe("    ? help · esc close");
  });
});

describe("wrapHanging", () => {
  it("continues a labelled value under the value, never at column 0, never mid-word", () => {
    const lines = wrapHanging("  Interpreter   scripts/watch.js runs with the node that pi itself runs on this machine", 50);
    expect(lines[0]).toBe("  Interpreter   scripts/watch.js runs with the");
    for (const l of lines.slice(1)) expect(l.startsWith(" ".repeat(16))).toBe(true);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });

  it("splits a word wider than the line only where it must, starting beside its label", () => {
    const lines = wrapHanging(`  Key           user:${"x".repeat(80)}`, 50);
    expect(lines[0]?.startsWith("  Key           user:")).toBe(true);
    for (const l of lines.slice(1)) expect(l.startsWith(" ".repeat(16))).toBe(true);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });

  it("breaks a long path after a separator rather than inside a name", () => {
    const lines = wrapHanging("  Interpreter   scripts/wait.js → D:\\Users\\me\\AppData\\Local\\mise\\installs\\node\\24.12.0\\node.exe scripts/wait.js", 60);
    expect(lines).toEqual([
      "  Interpreter   scripts/wait.js → D:\\Users\\me\\AppData\\Local\\",
      "                mise\\installs\\node\\24.12.0\\node.exe",
      "                scripts/wait.js",
    ]);
  });

  it("indents a sentence without a label by two", () => {
    const lines = wrapHanging("one two three four five six seven eight nine ten", 20);
    expect(lines[0]).toBe("one two three four");
    expect(lines[1]?.startsWith("  ")).toBe(true);
  });
});

describe("momentWords — the one clock", () => {
  const now = new Date(2026, 9, 22, 12, 4);
  it("is relative within the hour, then today, yesterday, a weekday, a date", () => {
    expect(momentWords(new Date(2026, 9, 22, 11, 38).toISOString(), now)).toBe("26m ago");
    expect(momentWords(new Date(2026, 9, 22, 9, 5).toISOString(), now)).toBe("today 09:05");
    expect(momentWords(new Date(2026, 9, 21, 18, 2).toISOString(), now)).toBe("yesterday 18:02");
    expect(momentWords(new Date(2026, 9, 19, 7, 0).toISOString(), now)).toBe("Mon 07:00");
    expect(momentWords(new Date(2026, 9, 10, 7, 0).toISOString(), now)).toBe("Oct 10");
  });
});

describe("windowBlock", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);

  it("keeps a whole block in view, with a marker where more is hidden", () => {
    const shown = windowBlock(lines, 20, 23, 10);
    expect(shown).toHaveLength(10);
    for (const i of [20, 21, 22, 23]) expect(shown).toContain(`line ${i}`);
    expect(shown[0]).toBe("  ↑ more above");
    expect(shown.at(-1)).toBe("  ↓ more below");
  });

  it("keeps a one-line block in view at the edges and in the middle", () => {
    for (const at of [0, 5, 15, 29]) {
      const shown = windowBlock(lines, at, at, 8);
      expect(shown).toHaveLength(8);
      expect(shown).toContain(`line ${at}`);
    }
  });
});

describe("noteRows", () => {
  it("puts every link in one column after the note's text, clickable and uncoloured", () => {
    const rows = noteRows(
      [
        { ts: "t", text: "Digest published", links: [{ label: "Canvas digest", url: "https://c.test/d" }] },
        { ts: "t", text: "Posted to the team chat", links: [{ label: "Group message", url: "https://t.test/m" }] },
        { ts: "t", text: "No link here", links: [] },
      ],
      80,
      "  ",
    );
    expect(rows[0]).toBe("  Digest published          ↗ \u001B]8;;https://c.test/d\u001B\\Canvas digest\u001B]8;;\u001B\\");
    expect(rows[1]).toBe("  Posted to the team chat   ↗ \u001B]8;;https://t.test/m\u001B\\Group message\u001B]8;;\u001B\\");
    expect(rows[2]).toBe("  No link here");
    for (const r of noteRows([{ ts: "t", text: "x".repeat(200), links: [{ url: "https://a.test/" + "y".repeat(200) }] }], 40)) expect(visibleWidth(r)).toBeLessThanOrEqual(40);
  });
});