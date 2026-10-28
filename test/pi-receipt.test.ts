/** The transcript receipt, driven through the renderer the pi host actually registers. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAutomationsExtension } from "../src/hosts/pi/extension.js";
import { agentDir, fireLogPath, setAgentDir } from "../src/paths.js";
import { RUN_ENTRY_TYPE, type RunEntryData } from "../src/ui/entry.js";
import { visibleWidth } from "../src/ui/width.js";
import type { RunRecord } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

interface Rendered {
  render: (width: number) => string[];
  invalidate: () => void;
}
type Renderer = (
  entry: { data?: RunEntryData },
  options: { expanded: boolean },
  theme: unknown,
) => Rendered | undefined;

/** Everything the extension is allowed to touch, and the two things it must not. */
function fakePi() {
  const renderers = new Map<string, Renderer>();
  const appended: { type: string; data: RunEntryData }[] = [];
  const forbidden: string[] = [];

  const pi = {
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    registerEntryRenderer: (type: string, fn: Renderer) => renderers.set(type, fn),
    appendEntry: (type: string, data: RunEntryData) => appended.push({ type, data }),
    sendMessage: () => forbidden.push("sendMessage"),
    sendUserMessage: () => forbidden.push("sendUserMessage"),
  };

  return { pi, renderers, appended, forbidden };
}

const THEME = { fg: (_c: string, s: string) => s };

describe("an expanded receipt shows a fault reported after it was written", () => {
  const before = agentDir();
  afterEach(() => {
    setAgentDir(before);
    cleanupTempDirs();
  });

  /** A finished run whose log gained a provider fault after its record. */
  function runWithLateFault(label: string) {
    const home = tempDir(label);
    const dir = path.join(home, "agent");
    const stateDir = path.join(dir, "pi-automations");
    const key = `user:${path.join(home, "roots")}:nightly`;
    const runId = "run-receipt";
    const record = {
      id: runId,
      key,
      name: "nightly",
      trigger: "manual",
      outcome: "ok",
      recordedAt: "2026-09-20T01:00:02Z",
      startedAt: "2026-09-20T01:00:00Z",
      endedAt: "2026-09-20T01:00:02Z",
    } as RunRecord;

    mkdirSync(path.dirname(fireLogPath(stateDir, key)), { recursive: true });
    writeFileSync(
      fireLogPath(stateDir, key),
      `${[
        JSON.stringify({ event: "start", runId, key, trigger: "manual", late: false }),
        JSON.stringify({ event: "record", record }),
        JSON.stringify({ event: "problem", message: "workspace release failed: EBUSY", runId }),
      ].join("\n")}\n`,
    );

    return { dir, key, record, runId };
  }

  function renderExpanded(data: RunEntryData, dir: string) {
    const { pi, renderers, appended, forbidden } = fakePi();
    createAutomationsExtension(pi as never, { agentDir: dir });

    const renderer = renderers.get(RUN_ENTRY_TYPE);
    expect(renderer).toBeTypeOf("function");
    const out = (renderer as Renderer)({ data }, { expanded: true }, THEME);
    return { lines: out?.render(100) ?? [], appended, forbidden };
  }

  it("renders the fault under the receipt it already appended", () => {
    const { dir, key, record, runId } = runWithLateFault("pi-receipt-");
    const data: RunEntryData = { name: "nightly", record, key, runId };

    const { lines, appended, forbidden } = renderExpanded(data, dir);

    expect(lines.join("\n")).toContain("provider: workspace release failed: EBUSY");
    // The run's own outcome is still the headline.
    expect(lines[0]).toContain("nightly");
    // Rendering appends nothing. This says the RENDERER does not write a second receipt; it is not
    // evidence that a real worker appended exactly one, which this fixture never runs.
    expect(appended).toHaveLength(0);
    expect(forbidden).toEqual([]);
  });

  it("falls back to the record when the entry stored no identity", () => {
    // Receipts written before the entry carried its own key and run id.
    const { dir, record } = runWithLateFault("pi-receipt-old-");
    const { lines } = renderExpanded({ name: "nightly", record }, dir);

    expect(lines.join("\n")).toContain("provider: workspace release failed: EBUSY");
  });

  it("adds nothing when the run reported no fault", () => {
    const { dir, key, record } = runWithLateFault("pi-receipt-quiet-");
    // Same log without the fault line.
    writeFileSync(
      fireLogPath(path.join(dir, "pi-automations"), key),
      `${JSON.stringify({ event: "record", record })}\n`,
    );

    const { lines } = renderExpanded({ name: "nightly", record, key, runId: record.id }, dir);

    expect(lines.join("\n")).not.toContain("provider:");
  });

  it("leaves the collapsed line alone, so nothing reads the log to draw one row", () => {
    const { dir, key, record, runId } = runWithLateFault("pi-receipt-collapsed-");
    const { pi, renderers } = fakePi();
    createAutomationsExtension(pi as never, { agentDir: dir });

    const out = (renderers.get(RUN_ENTRY_TYPE) as Renderer)(
      { data: { name: "nightly", record, key, runId } },
      { expanded: false },
      THEME,
    );

    expect(out?.render(100)).toHaveLength(1);
    expect(out?.render(100).join("")).not.toContain("provider:");
  });
});

describe("what an expanded receipt keeps when the log cannot answer", () => {
  const before = agentDir();
  afterEach(() => {
    setAgentDir(before);
    cleanupTempDirs();
  });

  /** A receipt with its own stored diagnostic, and a home whose log we control. */
  function storedReceipt(label: string, log?: string) {
    const home = tempDir(label);
    const dir = path.join(home, "agent");
    const stateDir = path.join(dir, "pi-automations");
    const key = `user:${path.join(home, "roots")}:nightly`;
    const runId = "run-stored";
    const record = {
      id: runId,
      key,
      name: "nightly",
      trigger: "manual",
      outcome: "ok",
      recordedAt: "2026-09-20T01:00:02Z",
      startedAt: "2026-09-20T01:00:00Z",
      endedAt: "2026-09-20T01:00:02Z",
    } as RunRecord;

    if (log !== undefined) {
      mkdirSync(path.dirname(fireLogPath(stateDir, key)), { recursive: true });
      writeFileSync(fireLogPath(stateDir, key), log);
    }

    const data: RunEntryData = {
      name: "nightly",
      record,
      key,
      runId,
      problems: ["saved receipt diagnostic"],
    };
    return { dir, key, runId, record, data };
  }

  function render(data: RunEntryData, dir: string): string[] {
    const { pi, renderers } = fakePi();
    createAutomationsExtension(pi as never, { agentDir: dir });
    const out = (renderers.get(RUN_ENTRY_TYPE) as Renderer)({ data }, { expanded: true }, THEME);
    return out?.render(100) ?? [];
  }

  it("keeps a stored diagnostic when there is no log at all", () => {
    const { dir, data } = storedReceipt("pi-stored-nolog-");

    // The stored copy is exactly what a receipt has once its log is gone; a read that finds nothing
    // must not be allowed to erase it.
    expect(render(data, dir).join("\n")).toContain("provider: saved receipt diagnostic");
  });

  it("keeps it when the log exists but holds nothing for this run", () => {
    const { dir, key, data } = storedReceipt(
      "pi-stored-otherrun-",
      `${JSON.stringify({ event: "problem", message: "another run's fault", runId: "run-other" })}\n`,
    );
    expect(key).toContain("nightly");

    const text = render(data, dir).join("\n");
    expect(text).toContain("provider: saved receipt diagnostic");
    // And the other run's fault does not arrive with it.
    expect(text).not.toContain("another run's fault");
  });

  it("keeps it when the log cannot be read", () => {
    const { dir, key, data } = storedReceipt("pi-stored-unreadable-");
    // A directory where the log file belongs: every read of it fails.
    mkdirSync(fireLogPath(path.join(dir, "pi-automations"), key), { recursive: true });

    expect(render(data, dir).join("\n")).toContain("provider: saved receipt diagnostic");
  });

  it("adds a fresh fault to the stored one rather than replacing it", () => {
    const { dir, runId, data } = storedReceipt(
      "pi-stored-fresh-",
      `${JSON.stringify({ event: "problem", message: "fresh log diagnostic", runId: "run-stored" })}\n`,
    );
    expect(runId).toBe("run-stored");

    const text = render(data, dir).join("\n");
    expect(text).toContain("provider: saved receipt diagnostic");
    expect(text).toContain("provider: fresh log diagnostic");
  });

  it("shows a fault held in both places exactly once", () => {
    const { dir, data } = storedReceipt(
      "pi-stored-dupe-",
      `${JSON.stringify({ event: "problem", message: "saved receipt diagnostic", runId: "run-stored" })}\n`,
    );

    const text = render(data, dir).join("\n");
    expect(text.split("provider: saved receipt diagnostic").length - 1).toBe(1);
  });
});

describe("a receipt fits the width pi draws it at", () => {
  // pi stops drawing, and writes pi-tui-crash.log, when any line is wider than the terminal. The
  // receipt was laid out once at a fixed 100 columns, so this run's collapsed line (98 columns)
  // crashed an 87-column terminal.
  const before = agentDir();
  afterEach(() => {
    setAgentDir(before);
    cleanupTempDirs();
  });

  const record = {
    id: "run-wide",
    key: "user:/roots:my-issue-verify",
    name: "my-issue-verify",
    trigger: "manual",
    outcome: "ok",
    recordedAt: "2026-10-01T20:53:00Z",
    startedAt: "2026-10-01T20:37:45Z",
    endedAt: "2026-10-01T20:53:00Z",
    hooks: [
      { phase: "pre", index: 0, kind: "script", source: "scripts/pick.js", status: "ok", durationMs: 900 },
    ],
    output: {
      text: "#4607 Newly created skill files don't appear in the right panel until the page is reloaded",
    },
  } as RunRecord;

  function drawn(expanded: boolean): Rendered {
    const { pi, renderers } = fakePi();
    createAutomationsExtension(pi as never, { agentDir: path.join(tempDir("pi-receipt-wide-"), "agent") });
    const out = (renderers.get(RUN_ENTRY_TYPE) as Renderer)(
      { data: { name: record.name, record } },
      { expanded },
      THEME,
    );
    expect(out).toBeDefined();
    return out as Rendered;
  }

  it("is a run that the old fixed width would have drawn past an 87-column terminal", () => {
    // The control: a fixture too short to overflow would let the next case pass vacuously.
    expect(visibleWidth(drawn(false).render(100)[0] ?? "")).toBeGreaterThan(87);
  });

  it.each([87, 60, 30])("keeps every line within %i columns, collapsed and expanded", (width) => {
    for (const expanded of [false, true]) {
      const lines = drawn(expanded).render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
    }
  });
});