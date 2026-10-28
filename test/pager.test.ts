/** The shared pager, and the consent overlay built on it. */

import { describe, expect, it } from "vitest";

import { consentActions, createPager, readerActions } from "../src/ui/pager.js";
import { visibleWidth } from "../src/ui/width.js";
import type { LineTheme } from "../src/ui/theme.js";

const RED: LineTheme = { fg: (c, text) => `\u001B[31m${c}:${text}\u001B[0m` };

function harness(opts: {
  lines: string[];
  actions?: ReturnType<typeof consentActions>;
  otherwise?: "ignore" | "reject";
  pageSize?: number;
  theme?: LineTheme;
}) {
  const resolved: boolean[] = [];
  let renders = 0;
  const pager = createPager({
    tui: { requestRender: () => renders++ },
    title: "Arm flow-example",
    lines: opts.lines,
    actions: opts.actions ?? consentActions(),
    otherwise: opts.otherwise ?? "reject",
    resolve: (v) => resolved.push(v),
    ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
    ...(opts.theme ? { theme: opts.theme } : {}),
  });
  return {
    pager,
    resolved,
    get renders() {
      return renders;
    },
  };
}

const PREVIEW = [
  "flow-example — repository automation, off by default",
  "",
  "hooks:",
  "  pre[0]  node counts.js",
  "  post[0] node record.js",
  "",
  "Arming runs these commands with your credentials on this machine.",
];

describe("createPager — reading", () => {
  it("shows the title and the lines", () => {
    const h = harness({ lines: PREVIEW });
    const text = h.pager.render(80).join("\n");
    expect(text).toContain("Arm flow-example");
    expect(text).toContain("node counts.js");
    expect(text).toContain("Arming runs these commands");
  });

  it("shows the key hints in the footer", () => {
    const h = harness({ lines: PREVIEW });
    const text = h.pager.render(80).join("\n");
    expect(text).toContain("y arm");
    expect(text).toContain("keep off");
  });

  it("wraps long lines instead of truncating them", () => {
    const long = `  pre[0] node ${"a".repeat(200)}.js`;
    const lines = harness({ lines: [long], pageSize: 40 }).pager.render(40);
    const body = lines
      .map((l) => l.replace(/\u001B\[[0-9;]*m/g, ""))
      .join("")
      .replace(/\s+/g, "");
    expect(body).toContain("a".repeat(200));
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });

  it("never exceeds the width it was given, coloured or not", () => {
    for (const w of [20, 40, 100]) {
      const h = harness({ lines: PREVIEW, theme: RED });
      for (const l of h.pager.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
    }
  });
});

describe("createPager — scrolling", () => {
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);

  it("says where it is when the content does not fit", () => {
    const h = harness({ lines: many, pageSize: 5 });
    expect(h.pager.render(80).at(-1)).toMatch(/^↑↓ scroll · rows 1-5 of 40/);
  });

  it("scrolls down and back up, and says where it is on the hint line", () => {
    const h = harness({ lines: many, pageSize: 5 });
    h.pager.handleInput("\u001b[B");
    h.pager.handleInput("\u001b[B");
    const text = h.pager.render(80);
    expect(text.join("\n")).toContain("line 2");
    expect(text.at(-1)).toContain("↑↓ scroll · rows 3-7 of 40");
    h.pager.handleInput("\u001b[A");
    expect(h.pager.render(80).at(-1)).toContain("rows 2-6 of 40");
  });

  it("clamps at both ends rather than scrolling into nothing", () => {
    const h = harness({ lines: many, pageSize: 5, actions: readerActions(), otherwise: "ignore" });
    for (let i = 0; i < 100; i++) h.pager.handleInput("\u001b[B");
    const bottom = h.pager.render(80).join("\n");
    expect(bottom).toContain("line 39");
    expect(bottom).toContain("rows 36-40 of 40");
    for (let i = 0; i < 100; i++) h.pager.handleInput("\u001b[A");
    expect(h.pager.render(80).join("\n")).toContain("rows 1-5 of 40");
  });

  it("pages and jumps to the ends", () => {
    const h = harness({ lines: many, pageSize: 5, actions: readerActions(), otherwise: "ignore" });
    h.pager.handleInput("\u001b[6~");
    expect(h.pager.render(80).join("\n")).toContain("line 5");
    h.pager.handleInput("\u001b[F");
    expect(h.pager.render(80).join("\n")).toContain("line 39");
    h.pager.handleInput("\u001b[H");
    expect(h.pager.render(80).join("\n")).toContain("line 0");
  });

  it("does not offer scroll hints when everything fits", () => {
    const h = harness({ lines: ["a", "b"], pageSize: 20 });
    const text = h.pager.render(80).join("\n");
    expect(text).not.toContain("scroll");
    expect(text).not.toContain("rows ");
  });
});

describe("consent — only y arms", () => {
  it("y resolves true", () => {
    for (const k of ["y", "Y"]) {
      const h = harness({ lines: PREVIEW });
      h.pager.handleInput(k);
      expect(h.resolved).toEqual([true]);
    }
  });

  it("n and esc resolve false", () => {
    for (const k of ["n", "N", "\u001b"]) {
      const h = harness({ lines: PREVIEW });
      h.pager.handleInput(k);
      expect(h.resolved).toEqual([false]);
    }
  });

  it("EVERY other printable key keeps it off", () => {
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
    for (const k of printable) {
      if (k === "y" || k === "Y") continue;
      const h = harness({ lines: PREVIEW });
      h.pager.handleInput(k);
      expect(h.resolved, `key ${JSON.stringify(k)} must not arm`).toEqual([false]);
    }
  });

  it("control keys and unknown escape sequences keep it off too", () => {
    for (const k of ["\u0003", "\r", "\n", "\t", "\u001b[Z", "\u001bOP", "\u007f"]) {
      const h = harness({ lines: PREVIEW });
      h.pager.handleInput(k);
      expect(h.resolved, `key ${JSON.stringify(k)} must not arm`).toEqual([false]);
    }
  });

  it("scrolling is not an answer — reading the preview must not arm or refuse it", () => {
    const h = harness({ lines: Array.from({ length: 40 }, (_, i) => `l${i}`), pageSize: 5 });
    for (const k of ["\u001b[A", "\u001b[B", "\u001b[5~", "\u001b[6~", "\u001b[H", "\u001b[F"]) {
      h.pager.handleInput(k);
    }
    expect(h.resolved).toEqual([]);
  });
});

describe("readerActions", () => {
  it("closes on esc and q, and ignores everything else", () => {
    for (const k of ["\u001b", "q"]) {
      const h = harness({ lines: ["x"], actions: readerActions(), otherwise: "ignore" });
      h.pager.handleInput(k);
      expect(h.resolved).toEqual([false]);
    }
    const h = harness({ lines: ["x"], actions: readerActions(), otherwise: "ignore" });
    for (const k of ["a", "y", "\r"]) h.pager.handleInput(k);
    expect(h.resolved).toEqual([]);
  });

  it("offers enter only when there is something to show", () => {
    expect(readerActions().some((a) => a.hint.includes("enter"))).toBe(false);
    let ran = 0;
    const actions = readerActions(() => ran++);
    expect(actions.some((a) => a.hint.includes("enter"))).toBe(true);
    const h = harness({ lines: ["x"], actions, otherwise: "ignore" });
    h.pager.handleInput("\r");
    expect(ran).toBe(1);
    expect(h.resolved).toEqual([]);
  });
});

describe("createPager — a render host that has gone away", () => {
  it("stops touching it after the first failure", () => {
    let calls = 0;
    const pager = createPager({
      tui: {
        requestRender: () => {
          calls++;
          throw new Error("stale");
        },
      },
      title: "t",
      lines: Array.from({ length: 40 }, (_, i) => `l${i}`),
      actions: readerActions(),
      otherwise: "ignore",
      resolve: () => {},
      pageSize: 5,
    });
    expect(() => pager.handleInput("\u001b[B")).not.toThrow();
    const first = calls;
    pager.handleInput("\u001b[B");
    expect(calls).toBe(first);
    pager.dispose();
  });
});
