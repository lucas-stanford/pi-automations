/** A finished run as a transcript entry. */

import { describe, expect, it } from "vitest";

import {
  collapsedEntryLine,
  entryDataFor,
  expandedEntryLines,
  RUN_ENTRY_TYPE,
  runEntryComponent,
  type RunEntryData,
} from "../src/ui/entry.js";
import { markCrashed, startingView, type RunView } from "../src/ui/run-view.js";
import { visibleWidth } from "../src/ui/width.js";
import type { LineTheme } from "../src/ui/theme.js";
import type { HookResult, Located, RunRecord } from "../src/types.js";

const RED: LineTheme = { fg: (c, text) => `\u001B[31m${c}:${text}\u001B[0m` };

function located(name = "flow-example"): Located {
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

function view(name = "flow-example"): RunView {
  return startingView({
    located: located(name),
    trigger: "manual",
    startedAt: "2026-09-17T10:00:00.000Z",
    timeoutMs: 600_000,
  });
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    key: "user:/a/.agents/automations:flow-example",
    name: "flow-example",
    scope: "user",
    root: "/a/.agents/automations",
    trigger: "manual",
    late: false,
    recordedAt: "2026-09-17T10:01:12.000Z",
    startedAt: "2026-09-17T10:00:00.000Z",
    endedAt: "2026-09-17T10:01:12.000Z",
    outcome: "ok",
    ...over,
  };
}

const hooks: HookResult[] = [
  { phase: "pre", index: 0, kind: "script", source: "counts.js", status: "ok", durationMs: 120 },
  {
    phase: "post",
    index: 0,
    kind: "script",
    source: "record.js",
    status: "failed",
    exit: 3,
    durationMs: 40,
    reason: "exit 3",
  },
];

describe("entryDataFor", () => {
  it("carries the record when there is one", () => {
    const v: RunView = { ...view(), phase: "finished", record: record({ hooks }) };
    const d = entryDataFor(v);
    expect(d.record?.outcome).toBe("ok");
    expect(d.exitCode).toBeUndefined();
    expect(d.stderrTail).toBeUndefined();
  });

  it("carries the exit code and stderr when the child died without one", () => {
    const d = entryDataFor(markCrashed(view(), 20, ["Error: no credentials"]));
    expect(d.record).toBeUndefined();
    expect(d.exitCode).toBe(20);
    expect(d.stderrTail).toEqual(["Error: no credentials"]);
    expect(d.name).toBe("flow-example");
  });

  it("stores provider problems already known when the receipt is created", () => {
    const d = entryDataFor({ ...view(), problems: ["workspace cleanup failed: EBUSY"] });
    expect(d.problems).toEqual(["workspace cleanup failed: EBUSY"]);
  });

  it("uses a stable custom type", () => {
    expect(RUN_ENTRY_TYPE).toBe("pi-automations/run");
  });
});

describe("collapsedEntryLine", () => {
  it("is one line: glyph, name, outcome, duration, hook count and what happened", () => {
    // The collapsed line is the one most people read, so it ends with what the run said rather than
    // with a bare outcome. This record produced nothing, and says so — a blank there would read as
    // a broken surface instead of a quiet run.
    const line = collapsedEntryLine({ name: "x", record: record({ hooks }) }, 100);
    expect(line).toBe("▇ flow-example ok · 1:12 · 2 hooks · ok — no answer, hooks ran");
  });

  it("says why a run was skipped", () => {
    const line = collapsedEntryLine(
      { name: "x", record: record({ outcome: "skipped", reason: "nothing to do" }) },
      100,
    );
    expect(line).toContain("skipped");
    expect(line).toContain("nothing to do");
  });

  it("says a crashed run exited without a record", () => {
    const line = collapsedEntryLine({ name: "inbox-sweep", exitCode: 20 }, 100);
    expect(line).toBe("✗ inbox-sweep exited 20 without a record");
  });

  it("does not claim an exit code it was never given", () => {
    expect(collapsedEntryLine({ name: "x" }, 100)).toContain("exited ? without a record");
  });

  it("names the singular hook correctly", () => {
    const line = collapsedEntryLine({ name: "x", record: record({ hooks: [hooks[0] as HookResult] }) }, 100);
    expect(line).toContain("1 hook");
    expect(line).not.toContain("1 hooks");
  });

  it("omits the duration when the record has no end", () => {
    const r = record();
    delete r.endedAt;
    expect(collapsedEntryLine({ name: "x", record: r }, 100)).toBe(
      "▇ flow-example ok · ok — no answer",
    );
  });

  it("never exceeds the width, coloured or not", () => {
    for (const w of [10, 20, 40, 100]) {
      expect(visibleWidth(collapsedEntryLine({ name: "x", record: record({ hooks }) }, w, RED))).toBeLessThanOrEqual(w);
    }
  });
});

describe("runEntryComponent", () => {
  const long = record({
    hooks,
    output: { text: "a summary long enough to be cut at any width a terminal is likely to have" },
  });

  it("lays the entry out at the width of each frame, not the width it was built at", () => {
    const entry = runEntryComponent({ name: "x", record: long }, false);
    const wide = entry.render(100);
    const narrow = entry.render(50);

    expect(wide).toEqual([collapsedEntryLine({ name: "x", record: long }, 100)]);
    expect(narrow).toEqual([collapsedEntryLine({ name: "x", record: long }, 50)]);
    expect(visibleWidth(narrow[0] ?? "")).toBeLessThanOrEqual(50);
    expect(narrow).not.toEqual(wide);
  });

  it("draws the expanded entry when asked to", () => {
    const data: RunEntryData = { name: "x", record: long };
    expect(runEntryComponent(data, true).render(60)).toEqual(expandedEntryLines(data, 60));
  });

  it("keeps the lines while the width holds, and lays out afresh after invalidate", () => {
    const entry = runEntryComponent({ name: "x", record: long }, true, RED);
    const first = entry.render(80);
    expect(entry.render(80)).toBe(first);
    entry.invalidate();
    const again = entry.render(80);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });
});

describe("expandedEntryLines", () => {
  it("opens with the collapsed line, then the detail", () => {
    const data: RunEntryData = { name: "x", record: record({ hooks, model: "anthropic/x" }) };
    const lines = expandedEntryLines(data, 100);
    expect(lines[0]).toBe(collapsedEntryLine(data, 100));
    const text = lines.join("\n");
    expect(text).toContain("anthropic/x");
    expect(text).toContain("pre[0] counts.js");
    expect(text).toContain("post[0] record.js");
    expect(text).toContain("exit 3");
  });

  it("shows the error kind and message when the run failed", () => {
    const text = expandedEntryLines(
      {
        name: "x",
        record: record({ outcome: "failed", error: { kind: "timeout", message: "timed out after 10m" } }),
      },
      100,
    ).join("\n");
    expect(text).toContain("timeout: timed out after 10m");
  });

  it("marks a late run", () => {
    const text = expandedEntryLines(
      { name: "x", record: record({ late: true, trigger: "schedule", scheduledFor: "2026-09-17T09:00:00.000Z" }) },
      100,
    ).join("\n");
    expect(text).toContain("late");
    expect(text).toContain("scheduled for 2026-09-17T09:00:00.000Z");
  });

  it("prints the session as a plain path, never as a command", () => {
    const text = expandedEntryLines(
      { name: "x", record: record({ session: { file: "/s/s.jsonl", id: "s1" } }) },
      100,
    ).join("\n");
    expect(text).toContain("session /s/s.jsonl");
    expect(text).not.toContain("pi --session");
  });

  it("surfaces a flow problem rather than swallowing it", () => {
    const text = expandedEntryLines(
      { name: "x", record: record({ flow: { problem: "progress open: LOCK_TIMEOUT" } }) },
      100,
    ).join("\n");
    expect(text).toContain("flow: progress open: LOCK_TIMEOUT");
  });

  it("shows what the run published, with clickable links", () => {
    const text = expandedEntryLines(
      {
        name: "x",
        record: record({
          notes: [
            {
              ts: "2026-01-01T00:00:00Z",
              text: "Posted the review",
              links: [{ label: "review", url: "https://x.test/pr/1#r2" }],
            },
          ],
        }),
      },
      100,
    ).join("\n");
    expect(text).toContain("Posted the review");
    expect(text).toContain("\u001B]8;;https://x.test/pr/1#r2\u001B\\review\u001B]8;;\u001B\\");
  });

  it("wraps the stderr tail instead of cutting it", () => {
    const long = `Error: ${"x".repeat(200)}`;
    const lines = expandedEntryLines({ name: "x", exitCode: 20, stderrTail: [long] }, 40);
    const rejoined = lines
      .slice(1)
      .map((l) => l.replace(/\u001B\[[0-9;]*m/g, ""))
      .join("")
      .trim();
    expect(rejoined).toContain("x".repeat(200));
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });

  it("renders a crash with no record at all", () => {
    const lines = expandedEntryLines({ name: "inbox-sweep", exitCode: 20, stderrTail: ["boom"] }, 80);
    expect(lines[0]).toContain("exited 20 without a record");
    expect(lines.join("\n")).toContain("boom");
  });
});
