/** Saying what happened in a run. */

import { describe, expect, it } from "vitest";

import {
  clipLine,
  clipOutput,
  leadLine,
  outputLines,
  OUTPUT_MAX,
  summaryLine,
} from "../src/summary.js";
import type { RunRecord } from "../src/types.js";

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "20260918-070000-aaaa",
    key: "user:/r:daily-briefing",
    name: "daily-briefing",
    scope: "user",
    root: "/r",
    trigger: "schedule",
    late: false,
    recordedAt: "2026-09-18T07:00:14.000Z",
    startedAt: "2026-09-18T07:00:00.000Z",
    endedAt: "2026-09-18T07:00:14.000Z",
    outcome: "ok",
    ...over,
  } as RunRecord;
}

describe("clipOutput — what of the answer the record keeps", () => {
  it("keeps a short answer whole", () => {
    expect(clipOutput("12 new, 3 urgent")).toEqual({ text: "12 new, 3 urgent" });
  });

  it("trims, because trailing whitespace is not content", () => {
    expect(clipOutput("  hello\n\n")).toEqual({ text: "hello" });
  });

  it("bounds a long answer and says that it did", () => {
    const long = "x".repeat(OUTPUT_MAX + 500);
    const clipped = clipOutput(long);
    expect(clipped?.text).toHaveLength(OUTPUT_MAX);
    expect(clipped?.truncated).toBe(true);
  });

  it("distinguishes 'said nothing' from 'never got there'", () => {
    // An empty string would erase exactly the difference a reader needs.
    expect(clipOutput("")).toBeUndefined();
    expect(clipOutput("   \n ")).toBeUndefined();
    expect(clipOutput(undefined)).toBeUndefined();
  });
});

describe("leadLine — the first thing worth reading", () => {
  // Found on a real run. The body opened with a metadata block, so skipping headings alone left `-
  // Automation: flow-example` as the summary: true, useless, and indistinguishable from a real
  // answer if you are skimming a log.
  it("skips a metadata bullet list in favour of the sentence after it", () => {
    const text = [
      "## Status Report: flow-example",
      "",
      "**Run Details**",
      "- Automation: flow-example",
      "- Trigger: manual",
      "- FM Session: s-2a2b",
      "",
      "**Work Completed**",
      "Both parallel workers completed successfully.",
    ].join("\n");
    expect(leadLine(text)).toBe("Both parallel workers completed successfully.");
  });

  it("falls back to the first bullet when a list is genuinely all there is", () => {
    // A list still beats nothing — the rule is a preference, not a ban.
    expect(leadLine("# Done\n\n- Closed 4 stale pull requests\n- Nudged 2 reviewers")).toBe(
      "- Closed 4 stale pull requests",
    );
  });

  it("recognises numbered items as list items too", () => {
    expect(leadLine("1. Fetched the inbox\n2. Sorted it\n\nNothing needed attention.")).toBe(
      "Nothing needed attention.",
    );
  });

  it("strips heading markers, not just emphasis, when a heading is all there is", () => {
    expect(leadLine("## Status Report: nothing to do")).toBe("Status Report: nothing to do");
  });

  it("skips a heading in favour of the prose under it", () => {
    // "# Morning Briefing" is a worse answer to "what happened?" than the sentence beneath it.
    expect(leadLine("# Morning Briefing\n\n12 items arrived overnight.")).toBe(
      "12 items arrived overnight.",
    );
  });

  it("falls back to the heading when that is all there is, without its hashes", () => {
    // The hashes were markup for a Markdown reader. A log line is not one.
    expect(leadLine("# Nothing to report")).toBe("Nothing to report");
  });

  it("flattens, because the caller has one line", () => {
    expect(leadLine("a\tb   c")).toBe("a b c");
  });

  it("ignores rules and blank lines", () => {
    expect(leadLine("\n---\n\nThe real line.")).toBe("The real line.");
  });

  it("is empty for empty input rather than throwing", () => {
    expect(leadLine("")).toBe("");
  });
});

describe("clipLine", () => {
  it("leaves a short line alone", () => {
    expect(clipLine("short", 20)).toBe("short");
  });

  it("cuts on a word boundary and says it was cut", () => {
    const out = clipLine("the quick brown fox jumps over the lazy dog", 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });

  it("still cuts when there is no word boundary to use", () => {
    expect(clipLine("x".repeat(50), 10)).toHaveLength(11);
  });
});

describe("summaryLine — one honest line, whatever happened", () => {
  it("leads with what an ok run said", () => {
    const r = rec({ output: { text: "# Briefing\n\n12 new, 3 urgent. Nothing blocking." } });
    expect(summaryLine(r)).toBe("12 new, 3 urgent. Nothing blocking.");
  });

  it("says so when an ok run produced nothing", () => {
    // Real state, not a failure: an automation whose work is entirely in its hooks.
    expect(summaryLine(rec())).toBe("ok — no answer");
  });

  it("credits the hooks when they were the work", () => {
    const r = rec({
      hooks: [{ phase: "post", index: 0, kind: "script", source: "file.js", status: "ok", durationMs: 5 }],
    } as Partial<RunRecord>);
    expect(summaryLine(r)).toBe("ok — no answer, hooks ran");
  });

  it("gives a skipped run the reason, which is the actionable part", () => {
    const r = rec({ outcome: "skipped", reason: "pre[0] check.js exited 1: nothing to do" });
    expect(summaryLine(r)).toBe("pre[0] check.js exited 1: nothing to do");
  });

  it("names the error kind on a failure", () => {
    const r = rec({
      outcome: "failed",
      error: { kind: "timeout", message: "run timed out after 20m" },
    });
    expect(summaryLine(r)).toBe("timeout: run timed out after 20m");
  });

  it("counts collapsed missed ticks", () => {
    expect(summaryLine(rec({ outcome: "missed", count: 4 }))).toBe("missed 4 scheduled runs");
    expect(summaryLine(rec({ outcome: "missed" }))).toBe("missed a scheduled run");
  });

  it("says who stopped an aborted run", () => {
    const r = rec({ outcome: "aborted", reason: "stopped by request" });
    expect(summaryLine(r)).toBe("stopped by request");
  });

  it("is NEVER empty, for any outcome", () => {
    // A blank where a summary should be reads as a broken surface, not as a quiet morning.
    for (const outcome of ["ok", "skipped", "failed", "missed", "aborted"] as const) {
      const line = summaryLine(rec({ outcome }));
      expect(line.trim(), `outcome ${outcome}`).not.toBe("");
    }
  });

  it("respects the width it is given", () => {
    const r = rec({ output: { text: "a ".repeat(400) } });
    for (const w of [20, 60, 96, 240]) {
      expect(summaryLine(r, w).length).toBeLessThanOrEqual(w + 1);
    }
  });

  it("never returns something with a newline in it", () => {
    const r = rec({ output: { text: "first line\nsecond line\nthird" } });
    expect(summaryLine(r)).not.toMatch(/[\r\n]/);
  });
});

describe("outputLines — the produced text, for a pane", () => {
  const r = rec({
    output: { text: "Paragraph one is here.\n\nParagraph two is a little longer than the first." },
  });

  // Found by rendering a real record rather than by a test: a hard chop reads as corruption ("Three
  // messages a / re flagged urgent") and a person skimming stops to work out what broke.
  it("wraps on word boundaries, never mid-word", () => {
    const long = rec({
      output: {
        text: "Three messages are flagged urgent: the billing rollback, the on-call handover, and a customer escalation from Friday.",
      },
    });
    for (const w of [24, 40, 76]) {
      const lines = outputLines(long, w, 20);
      expect(lines.length).toBeGreaterThan(1);
      // Rejoining on single spaces must reproduce the text: that is only true if every break fell
      // on a space.
      expect(lines.join(" ")).toBe(long.output?.text);
      for (const l of lines) {
        expect(l.length).toBeLessThanOrEqual(w);
        expect(l.startsWith(" ")).toBe(false);
        expect(l.endsWith(" ")).toBe(false);
      }
    }
  });

  it("still breaks a single word too long to fit, so one URL cannot widen the pane", () => {
    const url = `https://example.test/${"x".repeat(90)}`;
    const lines = outputLines(rec({ output: { text: url } }), 30, 20);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    expect(lines.join("")).toBe(url);
  });

  // The model wrote Markdown for a Markdown reader; this is a terminal pane.
  it("strips emphasis, so a heading does not arrive wearing asterisks", () => {    const lines = outputLines(
      rec({ output: { text: "**Overnight Briefing**\n\nIt found `3` things and _one_ of them is urgent." } }),
      76,
      20,
    );
    expect(lines[0]).toBe("Overnight Briefing");
    expect(lines.join(" ")).not.toContain("*");
    expect(lines.join(" ")).not.toContain("`");
    expect(lines.join(" ")).toContain("one of them is urgent");
  });

  it("strips heading markers too, so `## Status Report` does not arrive with its hashes", () => {
    const lines = outputLines(
      rec({ output: { text: "## Status Report: flow-example\n\nBoth workers finished." } }),
      76,
      20,
    );
    expect(lines[0]).toBe("Status Report: flow-example");
    expect(lines.join(" ")).not.toContain("#");
  });

  it("wraps to the width it is given", () => {
    for (const w of [20, 40, 80]) {
      for (const l of outputLines(r, w, 20)) expect(l.length).toBeLessThanOrEqual(w);
    }
  });

  it("stops at the line budget", () => {
    expect(outputLines(r, 20, 3)).toHaveLength(3);
  });

  it("marks the end when there is more than it showed", () => {
    const lines = outputLines(r, 20, 3);
    expect(lines[2]?.endsWith("…")).toBe(true);
  });

  it("does not mark the end when everything fitted", () => {
    const short = rec({ output: { text: "all of it" } });
    expect(outputLines(short, 40, 6)).toEqual(["all of it"]);
  });

  it("is empty when the run produced nothing", () => {
    expect(outputLines(rec(), 40)).toEqual([]);
  });

  it("is empty rather than broken at a useless width", () => {
    expect(outputLines(r, 0)).toEqual([]);
  });
});

describe("leadLine — headings come in more than one shape", () => {
  // Both of these were seen on real runs. A title is a worse answer to "what happened?" than the
  // sentence beneath it, whichever way the model chose to mark it up.
  it("skips a bold pseudo-heading, which is what models actually emit", () => {
    expect(
      leadLine("**Overnight Briefing**\n\n12 new items and 2 pull requests arrived."),
    ).toBe("12 new items and 2 pull requests arrived.");
  });

  it("skips an underscored one too", () => {
    expect(leadLine("__Report__\n\nAll clear.")).toBe("All clear.");
  });

  it("keeps the heading when it is the only thing said", () => {
    expect(leadLine("**Nothing to report**")).toBe("Nothing to report");
  });

  it("strips emphasis from the line it picks, because one line has no room for syntax", () => {
    expect(leadLine("There are **3** urgent items and `2` PRs.")).toBe(
      "There are 3 urgent items and 2 PRs.",
    );
  });

  it("does not mangle ordinary punctuation or in-word underscores", () => {
    expect(leadLine("Updated my_file_name.ts and moved on.")).toBe(
      "Updated my_file_name.ts and moved on.",
    );
  });
});
