import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { mermaidLabel, planFromAutomation, readFlowPlan } from "../src/flow-plan.js";
import { nodeIdFor } from "../src/nodes.js";
import { progressTracking, readProgress } from "../src/progress.js";
import { progressCli } from "../src/progress-cli.js";
import type { FlowTrackingRequest } from "../src/core/contracts.js";
import type { Automation } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

function automation(over: Partial<Automation> = {}): Automation {
  return {
    name: "daily-briefing",
    description: "d",
    enabled: true,
    on: { manual: true },
    hooks: { pre: [], post: [] },
    body: "Write it.",
    ...over,
  };
}
describe("planFromAutomation", () => {
  it("gives a single body node to an automation with no hooks", () => {
    const plan = planFromAutomation(automation());
    expect(plan).toContain("flowchart TD");
    expect(plan).toContain('body["body: daily-briefing"]');
    expect(plan).not.toContain("-->");
  });

  it("lays out pre hooks, the body, then post hooks, in order", () => {
    const plan = planFromAutomation(
      automation({
        hooks: {
          pre: [{ script: "counts.js" }, { prompt: "continue?" }],
          post: [{ script: "post.js" }],
        },
      }),
    );
    expect(plan).toContain("pre0 --> pre1");
    expect(plan).toContain("pre1 --> body");
    expect(plan).toContain("body --> post0");
    expect(plan).toContain('pre0["pre[0] counts.js"]');
    expect(plan).toContain('pre1["pre[1] prompt"]');
    expect(plan).toContain('post0["post[0] post.js"]');
  });

  it("uses plain node ids — letters, digits, hyphen and underscore only", () => {
    const plan = planFromAutomation(
      automation({ name: "a.b c", hooks: { pre: [{ script: "x.js" }], post: [] } }),
    );
    for (const line of plan.split("\n").slice(1)) {
      const id = /^\s{2}([A-Za-z0-9_-]+)/.exec(line);
      if (line.trim()) expect(id, line).not.toBeNull();
    }
  });

  it("quotes labels, because a script path contains the shape delimiters", () => {
    // `pre[0] x.js` inside an unquoted label would be read as a node shape.
    expect(mermaidLabel("pre[0] x.js")).toBe('"pre[0] x.js"');
    expect(mermaidLabel('he said "hi"')).toBe(`"he said 'hi'"`);
  });

  it("names nodes the way the tracker addresses them", () => {
    expect(nodeIdFor("pre", 0)).toBe("pre0");
    expect(nodeIdFor("post", 2)).toBe("post2");
    expect(nodeIdFor("body")).toBe("body");
  });
});

describe("readFlowPlan", () => {
  it("reads an automation's own flow.mmd", () => {
    const dir = tempDir("pi-flow-own-");
    writeFileSync(path.join(dir, "flow.mmd"), "flowchart LR\n  a --> b\n");
    expect(readFlowPlan(dir)).toContain("a --> b");
  });

  it("reads the flowchart in AUTOMATION.md before a legacy flow.mmd", () => {
    const dir = tempDir("pi-flow-block-");
    writeFileSync(path.join(dir, "AUTOMATION.md"), "---\nname: daily-briefing\n---\n\n# Daily\n\n```mermaid\nflowchart TD\n  body[Body]\n```\n");
    writeFileSync(path.join(dir, "flow.mmd"), "flowchart LR\n  old --> chart\n");
    expect(readFlowPlan(dir)).toBe("flowchart TD\n  body[Body]\n");
  });

  it("returns nothing when there is none, or when it is empty", () => {
    const dir = tempDir("pi-flow-none-");
    expect(readFlowPlan(dir)).toBeUndefined();
    writeFileSync(path.join(dir, "AUTOMATION.md"), "```mermaid\n\n```\n");
    writeFileSync(path.join(dir, "flow.mmd"), "flowchart LR\n  a --> b\n");
    expect(readFlowPlan(dir)).toContain("a --> b");
    rmSync(path.join(dir, "flow.mmd"));
    writeFileSync(path.join(dir, "flow.mmd"), "   \n");
    expect(readFlowPlan(dir)).toBeUndefined();
  });
});

describe("which runs are tracked", () => {
  function request(over: { flowTracking?: Record<string, boolean>; force?: boolean; automation?: Automation } = {}) {
    const dir = tempDir("pi-flow-track-");
    const stateDir = tempDir("pi-flow-state-");
    const problems: string[] = [];
    const req: FlowTrackingRequest = {
      context: Object.freeze({
        runId: "20260101-000000-abcd",
        key: "user:/r:daily-briefing",
        name: "daily-briefing",
        scope: "user" as const,
        trigger: "manual" as const,
        late: false,
        automationDir: dir,
        rootDir: path.dirname(dir),
        stateDir,
      }),
      automation: over.automation ?? automation(),
      config: { ...DEFAULTS, flowTracking: over.flowTracking ?? {} },
      ...(over.force ? { force: true } : {}),
      onProblem: (m) => problems.push(m),
    };
    return { req, dir, stateDir, problems };
  }

  it("keeps notes, and no chart, by default — the chart is opt-in", () => {
    const r = request();
    const t = progressTracking(r.req);
    expect(t?.start()).toBe("20260101-000000-abcd");
    expect(t?.charted).toBe(false);
    expect(readProgress(r.stateDir, "20260101-000000-abcd")?.nodes).toEqual([]);
    // Nothing to name, so no node: a defaulted `pa say` is then NO_CHART, not UNKNOWN_NODE.
    const env = t?.environment("body");
    expect(env).toMatchObject({ AUTOMATION_RUN: "20260101-000000-abcd", AUTOMATION_STATE_DIR: r.stateDir });
    expect(env).not.toHaveProperty("AUTOMATION_NODE");
    expect(t?.guide?.()).toContain("pa note");
    expect(t?.guide?.()).not.toContain("pa step");
  });

  it("turns on by itself when the automation ships a flowchart, and tracks on that chart", () => {
    const r = request();
    writeFileSync(path.join(r.dir, "AUTOMATION.md"), "```mermaid\nflowchart TD\n  a[\"Start\"] --> b\n```\n");
    const t = progressTracking(r.req);
    expect(t?.start()).toBe("20260101-000000-abcd");
    expect(readProgress(r.stateDir, "20260101-000000-abcd")?.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("turns on when the key is named in config, on the run's own shape", () => {
    const r = request({
      flowTracking: { "user:/r:daily-briefing": true },
      automation: automation({ hooks: { pre: [{ script: "x.js" }], post: [] } }),
    });
    const t = progressTracking(r.req);
    t?.start();
    expect(readProgress(r.stateDir, "20260101-000000-abcd")?.nodes.map((n) => n.id)).toEqual(["pre0", "body"]);
  });

  // `force` is what the list screen's "run and watch the flowchart" action asks for: a different
  // way to ask for a run, not a different kind of run. Nothing durable changes.
  it("tracks this one run when forced, with no chart and no config entry", () => {
    const r = request({ force: true });
    expect(progressTracking(r.req)?.start()).toBe("20260101-000000-abcd");
    expect(progressTracking(request().req)?.charted).toBe(false);
  });

  it("needs no renderer at all: nothing but a small file in the state directory", () => {
    const r = request({ force: true });
    progressTracking(r.req)?.start();
    expect(readdirSync(path.join(r.stateDir, "progress"))).toEqual(["20260101-000000-abcd.jsonl"]);
    expect(existsSync(path.join(r.dir, ".flows"))).toBe(false);
  });

  it("keeps only notes for a chart with no nodes, and says so", () => {
    const r = request();
    writeFileSync(path.join(r.dir, "AUTOMATION.md"), "```mermaid\nflowchart TD\n  %% nothing yet\n```\n");
    const t = progressTracking(r.req);
    expect(t?.start()).toBe("20260101-000000-abcd");
    expect(t?.charted).toBe(false);
    expect(r.problems.join()).toContain("no nodes, so only notes are kept");
    expect(readdirSync(path.join(r.stateDir, "progress"))).toEqual(["20260101-000000-abcd.jsonl"]);
  });

  it("names a node only when the chart has it, so a defaulted pa finds the one running node", () => {
    const r = request();
    writeFileSync(path.join(r.dir, "AUTOMATION.md"), "```mermaid\nflowchart TD\n  read --> draft\n```\n");
    const t = progressTracking(r.req);
    t?.start();
    // pi would hand the body "body" and a hook "pre0" — neither is on this chart.
    const env = t?.environment("body") ?? {};
    expect("AUTOMATION_NODE" in env).toBe(false);
    expect(t?.environment("pre0")).not.toHaveProperty("AUTOMATION_NODE");
    expect(t?.environment("read")).toHaveProperty("AUTOMATION_NODE", "read");

    const pa = (...argv: string[]) => progressCli([...argv, "--json"], env);
    expect(pa("step", "read").code).toBe(0);
    const said = pa("say", "found it");
    expect(said.code).toBe(0);
    expect(JSON.parse(said.stdout).data.node.id).toBe("read");
    const next = pa("next", "draft");
    expect(next.code).toBe(0);
    expect(readProgress(r.stateDir, "20260101-000000-abcd")?.taken).toEqual([["read", "draft"]]);
  });
  it("gives the body and every hook the same run, each on its own node", () => {
    const r = request({ force: true, automation: automation({ hooks: { pre: [{ script: "x.js" }], post: [] } }) });
    const t = progressTracking(r.req);
    t?.start();
    const body = t?.environment("body");
    const pre = t?.environment(nodeIdFor("pre", 0));
    expect(body).toMatchObject({
      AUTOMATION_RUN: "20260101-000000-abcd",
      AUTOMATION_STATE_DIR: r.stateDir,
      AUTOMATION_NODE: "body",
    });
    expect(pre?.AUTOMATION_RUN).toBe(body?.AUTOMATION_RUN);
    expect(pre?.AUTOMATION_NODE).toBe("pre0");
  });
});

describe("config", () => {
  it("defaults flow tracking to off", () => {
    expect(DEFAULTS.flowTracking).toEqual({});
    expect(DEFAULTS.fmPath).toBeUndefined();
  });
});