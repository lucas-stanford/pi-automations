/** The flow VIEWER — drawing a run's chart, which is a different job from recording it. */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createFlowViewer } from "../src/hosts/pi/flow-viewer.js";
import { snapshotFromRecord, type ProgressSnapshot } from "../src/progress.js";
import { findFmRenderer, fmRender, fmRenderer, resetFmRendererCache } from "../src/providers/fm/render.js";
import type { RenderChart } from "../src/core/contracts.js";
import type { RunRecord } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const FAKE_FM = path.join(import.meta.dirname, "helpers", "fake-fm.mjs");

const CHART = 'flowchart TD\n  pre0["Pick"] --> body["Do it"]\n  body --> read["Read"]\n';

function snapshot(revision = 3, over: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    run: "r-1",
    key: "user:/r:demo",
    name: "demo",
    chart: CHART,
    openedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      { id: "pre0", label: "Pick", status: "done", text: "picked #12", successors: ["body"] },
      { id: "body", label: "Do it", status: "active", text: null, successors: ["read"] },
      { id: "read", label: "Read", status: "pending", text: null, successors: [] },
    ],
    taken: [["pre0", "body"]],
    notes: [],
    closed: false,
    revision,
    ...over,
  };
}

function counting(out: (args: Parameters<RenderChart>[0]) => ReturnType<RenderChart>) {
  const calls: Parameters<RenderChart>[0][] = [];
  const render: RenderChart = (args) => {
    calls.push(args);
    return out(args);
  };
  return { render, calls };
}

describe("no renderer: the step list, never an error", () => {
  it("draws glyph, label, status and the last message for every node", () => {
    const pane = createFlowViewer().pane(snapshot(), 80);
    expect(pane?.kind).toBe("list");
    expect(pane?.lines).toHaveLength(3);
    expect(pane?.lines[0]).toContain("✓ Pick");
    expect(pane?.lines[0]).toContain("done");
    expect(pane?.lines[0]).toContain("picked #12");
    expect(pane?.lines[1]).toContain("▶ Do it");
  });

  it("has no pane for a run that is not tracked", () => {
    expect(createFlowViewer().pane(undefined, 80)).toBeUndefined();
    expect(createFlowViewer().lines(undefined)).toBeUndefined();
  });

  it("falls back to the list when the renderer fails, and keeps the problem", () => {
    const { render } = counting(() => ({ problem: "fm render: cannot draw this chart" }));
    const viewer = createFlowViewer({ render });
    const pane = viewer.pane(snapshot(), 80);
    expect(pane?.kind).toBe("list");
    expect(pane?.lines.join("\n")).toContain("Pick");
    expect(viewer.problem).toBe("fm render: cannot draw this chart");
  });

  it("falls back to the list when the renderer throws", () => {
    const viewer = createFlowViewer({
      render: () => {
        throw new Error("boom");
      },
    });
    expect(viewer.pane(snapshot(), 80)?.kind).toBe("list");
  });
});

describe("a renderer: the graph, and never a clipped one", () => {
  it("draws the graph when it fits, from the chart and the statuses", () => {
    const { render, calls } = counting(() => ({ text: "[Pick ✓]\n[Do it ▶]\n" }));
    const pane = createFlowViewer({ render }).pane(snapshot(), 80);
    expect(pane).toEqual({ kind: "graph", lines: ["[Pick ✓]", "[Do it ▶]"] });
    expect(calls[0]).toEqual({
      plan: CHART,
      state: { nodes: { pre0: "done", body: "active", read: "pending" }, taken: [["pre0", "body"]] },
      format: "text",
    });
  });

  it("shows the list, and says why, when the graph is wider than the pane", () => {
    const { render } = counting(() => ({ text: `${"─".repeat(120)}\n` }));
    const pane = createFlowViewer({ render }).pane(snapshot(), 60);
    expect(pane?.kind).toBe("list");
    expect(pane?.lines.at(-1)).toContain("120 columns wide");
    expect(pane?.lines[0]).toContain("Pick");
  });

  it("renders once per revision, and again when the run moves", () => {
    const { render, calls } = counting(() => ({ text: "[x]\n" }));
    const viewer = createFlowViewer({ render });
    viewer.pane(snapshot(3), 80);
    viewer.pane(snapshot(3), 80);
    expect(calls).toHaveLength(1);
    viewer.pane(snapshot(4), 80);
    expect(calls).toHaveLength(2);
    viewer.clear();
    viewer.pane(snapshot(4), 80);
    expect(calls).toHaveLength(3);
  });

  it("gives a finished run's entry plain step lines, with no renderer involved", () => {
    const { render, calls } = counting(() => ({ text: "[x]\n" }));
    const lines = createFlowViewer({ render }).lines(snapshot());
    expect(lines?.join("\n")).toContain("Pick");
    expect(lines?.join("")).not.toContain("\u001b[");
    expect(calls).toHaveLength(0);
  });

  it("draws a finished run from its record alone", () => {
    const rec = {
      id: "r-9",
      key: "user:/r:demo",
      name: "demo",
      scope: "user",
      root: "/r",
      trigger: "manual",
      late: false,
      recordedAt: "2026-01-01T00:00:00.000Z",
      outcome: "ok",
      chart: CHART,
      steps: [
        { id: "pre0", label: "Pick", status: "done" },
        { id: "body", label: "Do it", status: "done", text: "wrote it" },
        { id: "read", label: "Read", status: "skipped" },
      ],
      taken: [["pre0", "body"]],
    } as RunRecord;
    const { render, calls } = counting(() => ({ text: "[ok]\n" }));
    createFlowViewer({ render }).pane(snapshotFromRecord(rec), 80);
    expect(calls[0]?.state).toEqual({
      nodes: { pre0: "done", body: "done", read: "skipped" },
      taken: [["pre0", "body"]],
    });
  });
});

describe("fm render, through a stub with fm's interface", () => {
  afterEach(() => {
    resetFmRendererCache();
    delete process.env.FAKE_FM_LOG;
    delete process.env.FAKE_FM_FAIL;
  });

  it("is found when it answers `render --help`, and refused when the path does not exist", () => {
    expect(findFmRenderer(FAKE_FM)).toBe(FAKE_FM);
    expect(findFmRenderer(path.join(tempDir("no-fm-"), "fm"))).toBeUndefined();
  });

  it("is given the plan in a file and the state on stdin", () => {
    const log = path.join(tempDir("fake-fm-log-"), "calls.jsonl");
    process.env.FAKE_FM_LOG = log;
    const out = fmRender(FAKE_FM, {
      plan: CHART,
      state: { nodes: { pre0: "done", body: "active" }, taken: [["pre0", "body"]] },
      format: "text",
    });
    expect(out).toEqual({ text: "[Pick ✓]\n[Do it ▶]\n[Read ?]\npre0 ==> body\n" });
    const call = JSON.parse(readFileSync(log, "utf8").trim()) as { format: string; state: unknown };
    expect(call.format).toBe("text");
    expect(call.state).toEqual({ nodes: { pre0: "done", body: "active" }, taken: [["pre0", "body"]] });
  });

  it("draws the pane as a graph", () => {
    const pane = createFlowViewer({ render: fmRenderer(() => FAKE_FM) }).pane(snapshot(), 80);
    expect(pane?.kind).toBe("graph");
    expect(pane?.lines.join("\n")).toContain("[Do it ▶]");
  });

  it("falls back to the step list when fm fails, and when there is no fm at all", () => {
    process.env.FAKE_FM_FAIL = "1";
    const failing = createFlowViewer({ render: fmRenderer(() => FAKE_FM) });
    const pane = failing.pane(snapshot(), 80);
    expect(pane?.kind).toBe("list");
    expect(failing.problem).toContain("cannot draw this chart");

    const none = createFlowViewer({ render: fmRenderer(() => undefined) }).pane(snapshot(), 80);
    expect(none?.kind).toBe("list");
    expect(none?.lines[0]).toContain("Pick");
  });

  it("renders SVG for the report", () => {
    const out = fmRender(FAKE_FM, { plan: CHART, state: { nodes: {}, taken: [] }, format: "svg" });
    expect("text" in out && out.text).toContain("<svg");
  });
});
