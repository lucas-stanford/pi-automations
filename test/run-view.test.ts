/** The run model. */

import { describe, expect, it } from "vitest";

import {
  activeStep,
  applyFireEvent,
  elapsedMs,
  isRunning,
  markCrashed,
  mergeFlowNodes,
  nameFromKey,
  observedView,
  parseFireLine,
  planFor,
  replayFireLog,
  STDERR_TAIL_MAX,
  startingView,
  type FlowNodeLike,
  type RunView,
} from "../src/ui/run-view.js";
import type { FireEvent, HookResult, Located, RunLockInfo, RunRecord } from "../src/types.js";

function located(pre: string[], post: string[], name = "flow-example"): Located {
  return {
    automation: {
      name,
      description: "d",
      enabled: true,
      on: { manual: true },
      hooks: {
        pre: pre.map((s) => ({ script: s })),
        post: post.map((s) => ({ script: s })),
      },
      body: "b",
    },
    dir: "/a/.agents/automations/flow-example",
    file: "/a/.agents/automations/flow-example/AUTOMATION.md",
    root: { path: "/a/.agents/automations", scope: "user", kind: "agents" },
    key: `user:/a/.agents/automations:${name}`,
  };
}

function view(pre: string[] = ["counts.js"], post: string[] = ["record.js"]): RunView {
  return startingView({
    located: located(pre, post),
    trigger: "manual",
    startedAt: "2026-09-17T10:00:00.000Z",
    timeoutMs: 600_000,
  });
}

function hook(
  phase: "pre" | "post",
  index: number,
  status: HookResult["status"],
  reason?: string,
): HookResult {
  return {
    phase,
    index,
    kind: "script",
    source: phase === "pre" ? "counts.js" : "record.js",
    status,
    durationMs: 120,
    ...(reason ? { reason } : {}),
  };
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
    recordedAt: "2026-09-17T10:01:00.000Z",
    startedAt: "2026-09-17T10:00:00.000Z",
    endedAt: "2026-09-17T10:01:00.000Z",
    outcome: "ok",
    ...over,
  };
}

const START: FireEvent = {
  event: "start",
  runId: "run-1",
  key: "user:/a/.agents/automations:flow-example",
  trigger: "manual",
  late: false,
};

function fold(v: RunView, events: FireEvent[]): RunView {
  return events.reduce(applyFireEvent, v);
}

function stateOf(v: RunView, id: string): string | undefined {
  return v.steps.find((s) => s.id === id)?.state;
}

describe("planFor", () => {
  it("names every step before anything has run, using the flow node ids", () => {
    const steps = planFor(located(["a.js", "b.js"], ["c.js"]));
    expect(steps.map((s) => s.id)).toEqual(["pre0", "pre1", "body", "post0"]);
    expect(steps.every((s) => s.state === "pending")).toBe(true);
    expect(steps[0]?.label).toBe("pre[0] a.js");
  });

  it("labels a prompt hook as a prompt", () => {
    const l = located([], []);
    l.automation.hooks.pre = [{ prompt: "summarise" }];
    expect(planFor(l)[0]?.label).toBe("pre[0] prompt");
  });

  it("always includes a body, even with no hooks at all", () => {
    expect(planFor(located([], [])).map((s) => s.id)).toEqual(["body"]);
  });
});

describe("applyFireEvent — a run that works", () => {
  it("walks pending to done across every step", () => {
    let v = fold(view(), [START]);
    expect(v.phase).toBe("running");
    expect(v.runId).toBe("run-1");

    v = applyFireEvent(v, { event: "hook-start", phase: "pre", index: 0, source: "counts.js" });
    expect(stateOf(v, "pre0")).toBe("active");
    expect(activeStep(v)?.id).toBe("pre0");

    v = applyFireEvent(v, { event: "hook-end", result: hook("pre", 0, "ok") });
    expect(stateOf(v, "pre0")).toBe("done");
    expect(v.steps[0]?.durationMs).toBe(120);

    v = applyFireEvent(v, { event: "body-start", model: "anthropic/claude", cwd: "/a" });
    expect(stateOf(v, "body")).toBe("active");
    expect(v.steps.find((s) => s.id === "body")?.label).toContain("anthropic/claude");

    v = applyFireEvent(v, { event: "body-end", chars: 42 });
    expect(stateOf(v, "body")).toBe("done");

    v = applyFireEvent(v, { event: "hook-start", phase: "post", index: 0, source: "record.js" });
    v = applyFireEvent(v, { event: "hook-end", result: hook("post", 0, "ok") });
    v = applyFireEvent(v, {
      event: "record",
      record: record({ hooks: [hook("pre", 0, "ok"), hook("post", 0, "ok")] }),
    });

    expect(v.phase).toBe("finished");
    expect(isRunning(v)).toBe(false);
    expect(v.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
    expect(v.record?.outcome).toBe("ok");
  });

  it("never mutates the view it was given", () => {
    const before = view();
    const snapshot = JSON.stringify(before);
    applyFireEvent(before, START);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("applyFireEvent — a pre hook stops the run", () => {
  it("settles the body and the later pre hook as not-run, and keeps the post hook's real result", () => {
    // run.ts BREAKS out of the pre loop on a skip, so pre1 and the body emit nothing at all.
    let v = fold(view(["counts.js", "second.js"], ["record.js"]), [
      START,
      { event: "hook-start", phase: "pre", index: 0, source: "counts.js" },
      { event: "hook-end", result: hook("pre", 0, "skipped", "nothing to do") },
      { event: "hook-start", phase: "post", index: 0, source: "record.js" },
      { event: "hook-end", result: hook("post", 0, "ok") },
    ]);
    expect(stateOf(v, "pre1")).toBe("pending");
    expect(stateOf(v, "body")).toBe("pending");

    v = applyFireEvent(v, {
      event: "record",
      record: record({
        outcome: "skipped",
        reason: "nothing to do",
        hooks: [hook("pre", 0, "skipped", "nothing to do"), hook("post", 0, "ok")],
      }),
    });

    expect(stateOf(v, "pre0")).toBe("skipped");
    expect(v.steps[0]?.reason).toBe("nothing to do");
    expect(stateOf(v, "pre1")).toBe("skipped");
    expect(v.steps[1]?.reason).toBe("did not run");
    expect(stateOf(v, "body")).toBe("skipped");
    expect(stateOf(v, "post0")).toBe("done");
  });

  it("records a failing pre hook as failed, not skipped", () => {
    const v = fold(view(), [
      START,
      { event: "hook-start", phase: "pre", index: 0, source: "counts.js" },
      { event: "hook-end", result: hook("pre", 0, "failed", "exit 3") },
      {
        event: "record",
        record: record({
          outcome: "failed",
          error: { kind: "hook", message: "exit 3" },
          hooks: [hook("pre", 0, "failed", "exit 3")],
        }),
      },
    ]);
    expect(stateOf(v, "pre0")).toBe("failed");
    expect(stateOf(v, "body")).toBe("skipped");
  });
});

describe("applyFireEvent — timeout", () => {
  it("fails the body it was in the middle of and carries the timeout message", () => {
    const v = fold(view([], []), [
      START,
      { event: "body-start", model: "m", cwd: "/a" },
      {
        event: "record",
        record: record({
          outcome: "failed",
          error: { kind: "timeout", message: "run timed out after 10m" },
        }),
      },
    ]);
    expect(stateOf(v, "body")).toBe("failed");
    expect(v.steps[0]?.reason).toBe("run timed out after 10m");
  });
});

describe("markCrashed", () => {
  it("fails the active step, keeps the exit code and bounds the stderr tail", () => {
    const running = fold(view(), [
      START,
      { event: "hook-start", phase: "pre", index: 0, source: "counts.js" },
    ]);
    const tail = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    const v = markCrashed(running, 20, tail);

    expect(v.phase).toBe("crashed");
    expect(v.exitCode).toBe(20);
    expect(v.stderrTail).toHaveLength(STDERR_TAIL_MAX);
    expect(v.stderrTail[STDERR_TAIL_MAX - 1]).toBe("line 119");
    expect(stateOf(v, "pre0")).toBe("failed");
    expect(v.steps[0]?.reason).toBe("process exited");
    expect(isRunning(v)).toBe(false);
  });

  it("leaves a finished run alone — a record already told the truth", () => {
    const done = fold(view([], []), [START, { event: "record", record: record() }]);
    expect(markCrashed(done, 20, ["late noise"])).toBe(done);
  });

  it("leaves steps that never started as pending, rather than inventing a failure", () => {
    const v = markCrashed(fold(view(), [START]), 1, []);
    expect(stateOf(v, "pre0")).toBe("pending");
    expect(stateOf(v, "body")).toBe("pending");
  });
});

describe("parseFireLine", () => {
  it("parses each event kind", () => {
    expect(parseFireLine(JSON.stringify(START))?.event).toBe("start");
    expect(parseFireLine(JSON.stringify({ event: "body-end", chars: 1 }))?.event).toBe("body-end");
  });

  it("ignores stderr, blank lines and prose", () => {
    expect(parseFireLine("")).toBeUndefined();
    expect(parseFireLine("   ")).toBeUndefined();
    expect(parseFireLine("Error: no credentials")).toBeUndefined();
    expect(parseFireLine("    at file:///x.js:1:1")).toBeUndefined();
  });

  it("ignores malformed JSON and JSON that is not a FireEvent", () => {
    expect(parseFireLine('{"event":"start"')).toBeUndefined();
    expect(parseFireLine("{}")).toBeUndefined();
    expect(parseFireLine('{"event":"something-else"}')).toBeUndefined();
    expect(parseFireLine("[1,2,3]")).toBeUndefined();
    expect(parseFireLine("null")).toBeUndefined();
  });

  it("tolerates surrounding whitespace, including a CR from a Windows pipe", () => {
    expect(parseFireLine(`  ${JSON.stringify(START)}\r`)?.event).toBe("start");
  });
});

describe("replayFireLog", () => {
  const lock: RunLockInfo = {
    pid: 4812,
    runId: "run-2",
    key: "user:/a/.agents/automations:flow-example",
    startedAt: "2026-09-17T10:00:00.000Z",
    timeoutMs: 600_000,
    postHooks: 0,
    trigger: "schedule",
  };

  it("finds the run it was asked for in a log holding two runs and interleaved stderr", () => {
    const lines = [
      JSON.stringify({ ...START, runId: "run-1" }),
      "some stderr from the first run",
      JSON.stringify({ event: "record", record: record({ id: "run-1" }) }),
      "npm notice noise",
      JSON.stringify({ ...START, runId: "run-2" }),
      JSON.stringify({ event: "hook-start", phase: "pre", index: 0, source: "counts.js" }),
      "a warning on stderr",
      JSON.stringify({ event: "hook-end", result: hook("pre", 0, "ok") }),
      JSON.stringify({ event: "body-start", model: "m", cwd: "/a" }),
    ];
    const v = replayFireLog(observedView(lock), lines, "run-2");
    expect(v).toBeDefined();
    expect(v?.runId).toBe("run-2");
    expect(v?.phase).toBe("running");
    // The plan came from the log, not from a Located — pre0 is known because an event named it.
    expect(stateOf(v as RunView, "pre0")).toBe("done");
    expect(stateOf(v as RunView, "body")).toBe("active");
    expect(v?.record).toBeUndefined();
  });

  it("stops at the record belonging to its own run", () => {
    const lines = [
      JSON.stringify({ ...START, runId: "run-2" }),
      JSON.stringify({ event: "body-start", model: "m", cwd: "/a" }),
      JSON.stringify({ event: "body-end", chars: 3 }),
      JSON.stringify({ event: "record", record: record({ id: "run-2" }) }),
      JSON.stringify({ ...START, runId: "run-3" }),
      JSON.stringify({ event: "body-start", model: "m", cwd: "/a" }),
    ];
    const v = replayFireLog(observedView(lock), lines, "run-2");
    expect(v?.phase).toBe("finished");
    expect(v?.record?.id).toBe("run-2");
  });

  it("returns undefined when the log has no start for that run", () => {
    expect(replayFireLog(observedView(lock), ["noise", "{}"], "run-2")).toBeUndefined();
    expect(replayFireLog(observedView(lock), [], "run-2")).toBeUndefined();
  });

  it("picks the LAST matching start, so a re-used run id cannot replay stale steps", () => {
    const lines = [
      JSON.stringify({ ...START, runId: "run-2" }),
      JSON.stringify({ event: "hook-start", phase: "pre", index: 0, source: "old.js" }),
      JSON.stringify({ ...START, runId: "run-2" }),
    ];
    const v = replayFireLog(observedView(lock), lines, "run-2");
    expect(v?.steps).toHaveLength(0);
  });
});

describe("observedView", () => {
  it("carries everything the lock knows and nothing it does not", () => {
    const v = observedView({
      pid: 4812,
      runId: "run-9",
      key: "repository:/repo/.agents/automations:daily-briefing",
      startedAt: "2026-09-17T09:00:00.000Z",
      timeoutMs: 1_200_000,
      postHooks: 1,
      trigger: "schedule",
      scheduledFor: "2026-09-17T09:00:00.000Z",
    });
    expect(v.name).toBe("daily-briefing");
    expect(v.source).toBe("observed");
    expect(v.pid).toBe(4812);
    expect(v.steps).toEqual([]);
    expect(v.phase).toBe("running");
    expect(v.scheduledFor).toBe("2026-09-17T09:00:00.000Z");
  });
});

describe("clocks", () => {
  const v = view();

  it("measures elapsed time against the run's start", () => {
    const now = new Date("2026-09-17T10:00:42.000Z");
    expect(elapsedMs(v, now)).toBe(42_000);
  });

  it("floors at zero rather than reporting a negative age from a skewed clock", () => {
    expect(elapsedMs(v, new Date("2026-09-17T09:59:00.000Z"))).toBe(0);
  });

  it("reads an unparseable start as zero rather than NaN", () => {
    expect(elapsedMs({ ...v, startedAt: "not a date" }, new Date())).toBe(0);
  });
});

describe("nameFromKey", () => {
  it("takes everything after the last colon", () => {
    expect(nameFromKey("user:/a/b:flow-example")).toBe("flow-example");
    expect(nameFromKey("repository:C:/repo/.agents:x")).toBe("x");
    expect(nameFromKey("bare")).toBe("bare");
  });
});

describe("applyFireEvent — the flow event", () => {
  it("records the run id its progress is kept under without touching anything else", () => {
    const before = fold(view(), [START]);
    const after = applyFireEvent(before, { event: "flow", run: "r-1" });
    expect(after.flow).toEqual({ run: "r-1" });
    expect(after.steps).toEqual(before.steps);
    expect(after.phase).toBe(before.phase);
  });

  it("takes it from a record that carries steps, so a replayed or observed run has it too", () => {
    const v = fold(view([], []), [
      START,
      {
        event: "record",
        record: record({
          chart: "flowchart TD\n  body",
          steps: [{ id: "body", label: "body", status: "done" }],
          notes: [{ ts: "2026-01-01T00:00:00Z", text: "posted", links: [{ url: "https://x.test" }] }],
        }),
      },
    ]);
    expect(v.flow).toEqual({ run: v.record?.id });
    expect(v.notes?.[0]?.text).toBe("posted");
  });

  it("ignores a record whose only flow field is a problem", () => {
    const v = fold(view([], []), [START, { event: "record", record: record({ flow: { problem: "x" } }) }]);
    expect(v.flow).toBeUndefined();
  });

  it("leaves flow undefined for an untracked run", () => {
    expect(fold(view([], []), [START, { event: "record", record: record() }]).flow).toBeUndefined();
  });
});

describe("mergeFlowNodes", () => {
  const nodes = (over: Partial<FlowNodeLike>[] = []) =>
    [
      { id: "pre0", label: "fetch inbox", status: "done", text: "12 new, 3 urgent" },
      { id: "body", label: "write the digest", status: "active", text: null },
      ...over,
    ] as FlowNodeLike[];

  it("takes fm's label and node text onto the steps pi already knows", () => {
    const v = mergeFlowNodes(view(["counts.js"], []), nodes());
    const pre0 = v.steps.find((s) => s.id === "pre0");
    expect(pre0?.label).toBe("fetch inbox");
    expect(pre0?.note).toBe("12 new, 3 urgent");
    expect(v.steps.find((s) => s.id === "body")?.label).toBe("write the digest");
  });

  it("NEVER takes fm's status for a step pi owns", () => {
    // fm says done and active; pi has seen neither event yet.
    const v = mergeFlowNodes(view(["counts.js"], []), nodes());
    expect(v.steps.find((s) => s.id === "pre0")?.state).toBe("pending");
    expect(v.steps.find((s) => s.id === "body")?.state).toBe("pending");
  });

  it("keeps pi's state when the two disagree outright", () => {
    const running = fold(view(["counts.js"], []), [
      START,
      { event: "hook-start", phase: "pre", index: 0, source: "counts.js" },
      { event: "hook-end", result: hook("pre", 0, "failed", "exit 3") },
    ]);
    const v = mergeFlowNodes(running, nodes());
    expect(v.steps.find((s) => s.id === "pre0")?.state).toBe("failed");
  });

  it("appends a node fm knows and pi does not, marked as fm's", () => {
    const v = mergeFlowNodes(
      view([], []),
      nodes([{ id: "urgent", label: "page the on-call", status: "failed", text: "paged" }]),
    );
    const extra = v.steps.find((s) => s.id === "urgent");
    expect(extra).toBeDefined();
    expect(extra?.extra).toBe(true);
    expect(extra?.state).toBe("failed");
    expect(extra?.note).toBe("paged");
  });

  it("refreshes existing fm-only steps on every poll without freezing their initial status", () => {
    let v = view([], []);
    const poll = (status: string) => {
      v = mergeFlowNodes(v, [
        { id: "body", label: "Controller", status: "done", text: null },
        { id: "reviewer", label: "Reviewer", status, text: status === "done" ? "receipt saved" : null },
      ]);
    };
    poll("pending");
    poll("active");
    expect(v.steps.find((s) => s.id === "reviewer")?.state).toBe("active");
    poll("done");
    expect(v.steps.find((s) => s.id === "reviewer")?.state).toBe("done");
    expect(v.steps.find((s) => s.id === "reviewer")?.note).toBe("receipt saved");
    // A retry can move fm's own row back to active, then to another ending.
    poll("active");
    poll("failed");
    expect(v.steps.find((s) => s.id === "reviewer")?.state).toBe("failed");
    expect(v.steps.find((s) => s.id === "reviewer")?.note).toBeUndefined();
    expect(v.steps.filter((s) => s.id === "reviewer")).toHaveLength(1);
    // Being in the same array does NOT make an fm-only row authoritative for the host body.
    expect(v.steps.find((s) => s.id === "body")?.state).toBe("pending");
  });

  it("shows an interrupted fm-only node as failed, not newly pending", () => {
    const before = mergeFlowNodes(view([], []), [
      { id: "worker", label: "Worker", status: "active", text: null },
    ]);
    const after = mergeFlowNodes(before, [
      { id: "worker", label: "Worker", status: "interrupted", text: "run ended" },
    ]);
    expect(after.steps.find((s) => s.id === "worker")?.state).toBe("failed");
    expect(before.steps.find((s) => s.id === "worker")?.state).toBe("active");
  });

  it("reads fm's waiting as active — something is happening to that node", () => {
    const v = mergeFlowNodes(view([], []), [
      { id: "gate", label: "waiting for approval", status: "waiting", text: null },
    ]);
    expect(v.steps.find((s) => s.id === "gate")?.state).toBe("active");
  });

  it("reads a status it does not know as pending rather than dropping the node", () => {
    const v = mergeFlowNodes(view([], []), [
      { id: "odd", label: "odd", status: "teleported", text: null },
    ]);
    expect(v.steps.find((s) => s.id === "odd")?.state).toBe("pending");
  });

  it("does not replace a real label with a node id", () => {
    // parseFlowState falls back to the id when fm has no label; that must not overwrite ours.
    const v = mergeFlowNodes(view(["counts.js"], []), [
      { id: "pre0", label: "pre0", status: "done", text: null },
    ]);
    expect(v.steps.find((s) => s.id === "pre0")?.label).toBe("pre[0] counts.js");
  });

  it("clears a note fm no longer has", () => {
    const withNote = mergeFlowNodes(view(["counts.js"], []), nodes());
    expect(withNote.steps.find((s) => s.id === "pre0")?.note).toBeDefined();
    const cleared = mergeFlowNodes(withNote, [
      { id: "pre0", label: "fetch inbox", status: "done", text: "" },
    ]);
    expect(cleared.steps.find((s) => s.id === "pre0")?.note).toBeUndefined();
  });

  it("is a no-op for an empty node list, and never mutates its input", () => {
    const v = view();
    const snapshot = JSON.stringify(v);
    expect(mergeFlowNodes(v, [])).toBe(v);
    mergeFlowNodes(v, nodes());
    expect(JSON.stringify(v)).toBe(snapshot);
  });
});

describe("parseFireLine — the flow event", () => {
  it("parses it; without this the whole fm merge is silently dead", () => {
    const e = parseFireLine(JSON.stringify({ event: "flow", run: "r-1" }));
    expect(e?.event).toBe("flow");
  });

  it("accepts EVERY member of the FireEvent union", () => {
    // A member added to the type but not to this allow-list is dropped without a word — which is
    // exactly how the flow event was lost the first time.
    const samples: FireEvent[] = [
      { event: "start", runId: "r", key: "k", trigger: "manual", late: false },
      { event: "flow", run: "r" },
      { event: "hook-start", phase: "pre", index: 0, source: "x.js" },
      { event: "hook-end", result: hook("pre", 0, "ok") },
      { event: "body-start", model: "m", cwd: "/a" },
      { event: "body-end", chars: 1 },
      { event: "record", record: record() },
    ];
    for (const s of samples) {
      expect(parseFireLine(JSON.stringify(s))?.event, `${s.event} was dropped`).toBe(s.event);
    }
  });
});
