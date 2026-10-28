/** The line builders for the Running page, the footer and the widget strip. */

import { describe, expect, it } from "vitest";

import {
  clock,
  renderRunningLines,
  runningFooter,
  sourceText,
  widgetLines,
} from "../src/ui/running.js";
import { observedView, startingView, type RunView } from "../src/ui/run-view.js";
import type { Located, RunLockInfo, RunRecord } from "../src/types.js";

const NOW = new Date("2026-09-17T10:00:42.000Z");

function located(name: string, pre = 1, post = 1): Located {
  return {
    automation: {
      name,
      description: "d",
      enabled: true,
      on: { manual: true },
      hooks: {
        pre: Array.from({ length: pre }, (_, i) => ({ script: `counts${i}.js` })),
        post: Array.from({ length: post }, (_, i) => ({ script: `record${i}.js` })),
      },
      body: "b",
    },
    dir: `/a/.agents/automations/${name}`,
    file: `/a/.agents/automations/${name}/AUTOMATION.md`,
    root: { path: "/a/.agents/automations", scope: "user", kind: "agents" },
    key: `user:/a/.agents/automations:${name}`,
  };
}

function running(name: string, ageMs = 42_000): RunView {
  return startingView({
    located: located(name),
    trigger: "manual",
    startedAt: new Date(NOW.getTime() - ageMs).toISOString(),
    timeoutMs: 600_000,
  });
}

const LOCK: RunLockInfo = {
  pid: 4812,
  runId: "run-2",
  key: "user:/a/.agents/automations:daily-briefing",
  startedAt: new Date(NOW.getTime() - 190_000).toISOString(),
  timeoutMs: 1_200_000,
  postHooks: 0,
  trigger: "schedule",
};

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    key: "user:/a/.agents/automations:flow-example",
    name: "flow-example",
    scope: "user",
    root: "/a/.agents/automations",
    trigger: "manual",
    late: false,
    recordedAt: NOW.toISOString(),
    startedAt: "2026-09-17T09:59:00.000Z",
    endedAt: "2026-09-17T10:00:03.000Z",
    outcome: "ok",
    ...over,
  };
}

describe("clock", () => {
  it("is m:ss below an hour and h:mm:ss above it", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(42_000)).toBe("0:42");
    expect(clock(190_000)).toBe("3:10");
    expect(clock(3_600_000)).toBe("1:00:00");
    expect(clock(3_725_000)).toBe("1:02:05");
  });

  it("never reports a negative time", () => {
    expect(clock(-5000)).toBe("0:00");
  });
});

describe("runningFooter", () => {
  it("is undefined when nothing runs, so the caller falls back to the quiet summary", () => {
    expect(runningFooter([], NOW)).toBeUndefined();
    const done: RunView = { ...running("c"), phase: "finished", record: record() };
    expect(runningFooter([done], NOW)).toBeUndefined();
  });

  it("names one run", () => {
    expect(runningFooter([running("flow-example")], NOW)).toBe("◐ flow-example running 0:42");
  });

  it("counts and lists several", () => {
    const line = runningFooter([running("flow-example"), running("daily-briefing", 190_000)], NOW);
    expect(line).toBe("◐ 2 running · flow-example 0:42 · daily-briefing 3:10");
  });
});

describe("renderRunningLines", () => {
  it("says nothing running rather than printing an empty answer", () => {
    expect(renderRunningLines([], NOW)).toEqual(["nothing running"]);
  });

  it("gives one line per run, with the active step when there is one", () => {
    const v = running("flow-example");
    const active: RunView = {
      ...v,
      steps: v.steps.map((s) => (s.id === "body" ? { ...s, state: "active" as const } : s)),
    };
    const [line] = renderRunningLines([active, observedView(LOCK)], NOW);
    expect(line).toContain("flow-example");
    expect(line).toContain("manual");
    expect(line).toContain("0:42");
    expect(line).toContain("body");
    expect(line).toContain("this session");
  });

  it("admits when an observed run has no step detail", () => {
    expect(renderRunningLines([observedView(LOCK)], NOW)[0]).toContain("no step detail yet");
  });

  it("carries no escape sequences — it is read by pi -p and by the CLI", () => {
    for (const l of renderRunningLines([running("a"), observedView(LOCK)], NOW)) {
      // eslint-disable-next-line no-control-regex
      expect(l).not.toMatch(/\u001B/);
    }
  });
});

describe("sourceText and widgetLines", () => {
  it("distinguishes this session from a detached pid", () => {
    expect(sourceText(running("a"))).toBe("this session");
    expect(sourceText(observedView(LOCK))).toBe("background · pid 4812");
  });

  it("gives the strip one compact line per running run and nothing for finished ones", () => {
    const done: RunView = { ...running("c"), phase: "finished", record: record() };
    const lines = widgetLines([running("flow-example"), done], NOW, 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("flow-example");
    expect(lines[0]).toContain("0:42");
  });
});
