/** A run's chart, coloured and fitted: fm's text graph, or the step list. */

import { describe, expect, it } from "vitest";

import { FLOW_GLYPH } from "../src/flow-plan.js";
import {
  buildGraphLines,
  buildStepListLines,
  hyperlink,
  linkLine,
  noteLines,
  colorGraphLine,
  graphTooWideLine,
  graphWidth,
} from "../src/ui/graph.js";
import { visibleWidth } from "../src/ui/width.js";
import type { LineTheme } from "../src/ui/theme.js";

/** Marks the colour so a test can say which one was used. */
const TAG: LineTheme = { fg: (c, text) => `<${c}>${text}</${c}>` };

const GRAPH = [
  "┌─────────────────────────────────────┐   ",
  "│                                     │   ",
  "│ fetch inbox ✓ 0s · 12 new, 3 urgent │   ",
  "│                                     │   ",
  "└──────────────────┬──────────────────┘   ",
  "                   │                      ",
  "                   ▼                      ",
  "╭─────────────────────────────────────╮   ",
  "<        anything urgent? ▶ 16s       >┐  ",
  "╰──────────────────┬──────────────────╯│  ",
];

const NODES = [
  { id: "fetch", label: "fetch inbox", status: "done", text: "12 new, 3 urgent" },
  { id: "urgent", label: "anything urgent?", status: "waiting", text: null },
  { id: "page", label: "page the on-call", status: "failed", text: "paged" },
  { id: "digest", label: "write the digest", status: "skipped" },
  { id: "later", label: "later", status: "pending" },
];

describe("graphWidth", () => {
  it("measures the widest line, ignoring fm's trailing padding", () => {
    // fm pads every line to a common width; the widest REAL content is the branch line, which
    // carries an extra edge character past the box: 40 columns, not the box's own 39.
    expect(graphWidth(GRAPH)).toBe(40);
  });

  it("is zero for nothing", () => {
    expect(graphWidth([])).toBe(0);
    expect(graphWidth(["", "   "])).toBe(0);
  });
});

describe("colorGraphLine", () => {
  it("colours each status glyph and nothing else", () => {
    const out = colorGraphLine("│ fetch inbox ✓ 0s │", TAG);
    expect(out).toContain("<success>✓</success>");
    expect(out).toContain("fetch inbox");
    expect(out).not.toContain("<success>fetch");
  });

  it("uses a distinct colour per status", () => {
    const seen = new Map<string, string>();
    for (const [status, glyph] of Object.entries(FLOW_GLYPH)) {
      const out = colorGraphLine(glyph, TAG);
      const m = /<([a-z]+)>/.exec(out);
      expect(m, `${status} (${glyph}) was not coloured`).not.toBeNull();
      seen.set(status, m?.[1] as string);
    }
    expect(seen.get("done")).toBe("success");
    expect(seen.get("failed")).toBe("error");
    expect(seen.get("active")).toBe("accent");
    expect(seen.get("skipped")).toBe("dim");
    expect(seen.get("waiting")).toBe("warning");
    expect(seen.get("pending")).toBe("muted");
  });

  it("leaves the box-drawing characters alone", () => {
    expect(colorGraphLine("┌───┬───┐", TAG)).toBe("┌───┬───┐");
  });

  it("does not mistake punctuation for an unknown status", () => {
    const out = colorGraphLine("anything urgent? ? unknown", TAG);
    expect(out).toContain("urgent?");
    expect(out).toContain("<warning>?</warning> unknown");
    expect(out).not.toContain("urgent<warning>?</warning>");
  });

  it("does not touch a line fm already coloured itself", () => {
    const ansi = "\u001B[32m✓\u001B[0m done";
    expect(colorGraphLine(ansi, TAG)).toBe(ansi);
  });

  it("changes nothing under the plain theme", () => {
    expect(colorGraphLine(GRAPH[2] as string)).toBe(GRAPH[2]);
  });
});

describe("buildGraphLines", () => {
  it("returns the graph when it fits", () => {
    const lines = buildGraphLines({ lines: GRAPH, width: 60 });
    expect(lines).toBeDefined();
    expect(lines).toHaveLength(GRAPH.length);
    expect(lines?.[2]).toContain("fetch inbox");
  });

  it("returns NOTHING rather than a clipped graph", () => {
    expect(buildGraphLines({ lines: GRAPH, width: 39 })).toBeUndefined();
    expect(buildGraphLines({ lines: GRAPH, width: 10 })).toBeUndefined();
  });

  it("fits exactly at its own width, and not one column below", () => {
    expect(buildGraphLines({ lines: GRAPH, width: 40 })).toBeDefined();
    expect(buildGraphLines({ lines: GRAPH, width: 39 })).toBeUndefined();
  });

  it("never exceeds the pane, coloured or not", () => {
    for (const theme of [undefined, TAG]) {
      const lines = buildGraphLines({ lines: GRAPH, width: 60, ...(theme ? { theme } : {}) });
      for (const l of lines ?? []) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
    }
  });

  it("colours the glyphs it drew", () => {
    const lines = buildGraphLines({ lines: GRAPH, width: 60, theme: TAG });
    expect(lines?.join("\n")).toContain("<success>✓</success>");
    expect(lines?.join("\n")).toContain("<accent>▶</accent>");
  });
});

describe("graphTooWideLine", () => {
  it("names both widths, because the question is how much wider the terminal must be", () => {
    const line = graphTooWideLine(120, 80);
    expect(line).toContain("120");
    expect(line).toContain("80");
  });

  it("says what is shown instead, and offers no key that no longer exists", () => {
    expect(graphTooWideLine(120, 80)).toContain("showing the steps instead");
    expect(graphTooWideLine(120, 80)).not.toContain("press o");
  });
});

describe("buildStepListLines", () => {
  it("shows glyph, label, status and the last message, one node per line", () => {
    // The tag theme spends columns on its own markers, so the pane is wide enough for them.
    const lines = buildStepListLines(NODES, 200, TAG);
    expect(lines).toHaveLength(5);
    const text = lines.join("\n");
    expect(text).toContain("fetch inbox");
    expect(text).toContain("12 new, 3 urgent");
    expect(text).toContain("<success>✓</success>");
    expect(text).toContain("<error>✗</error>");
    expect(text).toContain("<dim>↷</dim>");
    expect(text).toContain("<warning>⏸</warning>");
    expect(lines[4]).toContain("<muted>later");
  });

  it("clips to the width it was given", () => {
    for (const l of buildStepListLines(NODES, 30, TAG)) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(30);
    }
  });

  it("survives empty input and a status it does not know", () => {
    expect(buildStepListLines([], 40)).toEqual([]);
    expect(buildStepListLines([{ id: "x", label: "x", status: "weird" }], 40)[0]).toContain("?");
  });
});

describe("links and notes", () => {
  it("wraps a link in OSC 8, label on screen and URL behind it", () => {
    expect(hyperlink("https://x.test/a", "review")).toBe("\u001B]8;;https://x.test/a\u001B\\review\u001B]8;;\u001B\\");
  });

  it("shows the URL as text too when the label is not the URL", () => {
    const line = linkLine({ label: "review", url: "https://x.test/a" }, 80, "  ");
    expect(line).toContain(hyperlink("https://x.test/a", "review"));
    expect(line).toContain(hyperlink("https://x.test/a", "https://x.test/a"));
  });

  it("never runs past the width, and never cuts the escape that closes a link", () => {
    const long = { label: "the pull request review comment", url: `https://x.test/${"a".repeat(200)}` };
    for (const w of [20, 40, 80]) {
      const line = linkLine(long, w, "    ");
      expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      expect(line.endsWith("\u001B]8;;\u001B\\")).toBe(true);
    }
  });

  it("lists each note, then its links under it", () => {
    const lines = noteLines(
      [{ ts: "2026-01-01T00:00:00Z", text: "Posted the\nreview", links: [{ label: "review", url: "https://x.test/r" }, { url: "https://x.test/d" }] }],
      80,
    );
    expect(lines[0]).toBe("  Posted the review");
    expect(lines[1]).toContain(hyperlink("https://x.test/r", "review"));
    expect(lines[2]).toContain(hyperlink("https://x.test/d", "https://x.test/d"));
  });
});

describe("text from outside, drawn in a terminal", () => {
  const PAYLOAD = "https://example.com/a\u001b]8;;https://evil.example\u001b\\b\u0007";
  /** What is left once this package's own OSC 8 hyperlinks are taken out: no escape, no bell. */
  const leftover = (s: string) => s.replace(/\u001B\]8;;[^\u001B\u0007]*\u001B\\/g, "");

  it("cannot end a hyperlink early or open another one, from the URL or the label", () => {
    // As an older record or a hand-edited file might hold it, never having been through parseLink.
    const line = linkLine({ label: `re\u001b]8;;https://evil.example\u0007view`, url: PAYLOAD }, 200, "  ");
    expect(leftover(line)).not.toMatch(/[\u001B\u0007]/);
    expect(hyperlink(PAYLOAD, PAYLOAD)).toBe(`\u001B]8;;${PAYLOAD.replace(/[\u001B\u0007]/g, "")}\u001B\\${PAYLOAD.replace(/[\u001B\u0007]/g, "")}\u001B]8;;\u001B\\`);
  });

  it("strips them from note text and from a step's label and message", () => {
    const notes = noteLines([{ ts: "t", text: `posted\u001b[2J${PAYLOAD}`, links: [{ url: PAYLOAD }] }], 300);
    for (const l of notes) expect(leftover(l)).not.toMatch(/[\u001B\u0007\u009B]/);
    const steps = buildStepListLines([{ id: "a", label: "evil\u001b]8;;x\u0007", status: "done", text: "said\u009b2J" }], 200);
    expect(steps[0]).not.toMatch(/[\u001B\u0007\u009B]/);
    expect(steps[0]).toContain("evil]8;;x");
  });
});
