/** The environment a run hands over, and the environment it must never touch. */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { progressEnvironment } from "../src/progress.js";
import { hookEnv, runScriptHook, type RunInfo } from "../src/hooks.js";
import { runLocalScript } from "../src/providers/scripts.js";
import { nodeIdFor } from "../src/nodes.js";
import { classifyFireError } from "../src/model.js";
import {
  createPiRuntime,
  OVERLAPPING_SESSION_MESSAGE,
} from "../src/providers/pi/runtime.js";
import { fire, type SessionHandle } from "../src/run.js";
import type {
  AutomationRuntime,
  RunContext,
  RuntimeModelRef,
  RuntimeSessionStart,
  StartFlowTracking,
} from "../src/core/contracts.js";
import type { ModelRuntimeLike } from "../src/model.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";
import { HOST_NOW, isolatedAutomation, isolatedFireDeps } from "./helpers/isolated-host.js";

afterAll(cleanupTempDirs);

const WORKER = path.join(import.meta.dirname, "helpers", "env-worker.js");
const MANUAL = { trigger: "manual" as const, now: () => HOST_NOW };

/** Every key and value, as one comparable string. */
function envSnapshot(): string {
  return JSON.stringify(
    Object.keys(process.env)
      .sort()
      .map((k) => [k, process.env[k]]),
  );
}

/** Keys this file sets on the parent for a test, removed afterwards whatever happens. */
const touched = new Set<string>();
function setParent(key: string, value: string): void {
  touched.add(key);
  process.env[key] = value;
}
afterEach(() => {
  for (const key of touched) delete process.env[key];
  touched.clear();
});

/** Run the bounded worker with an explicit environment and read back what it saw. */
function runWorker(
  env: Record<string, string>,
  args: string[] = [],
): { pid: number; self: Record<string, string | null>; child: Record<string, string | null> | null } {
  const r = spawnSync(process.execPath, [WORKER, ...args], {
    encoding: "utf8",
    windowsHide: true,
    // An EXPLICIT environment, so nothing of this test process leaks in and the child's view is
    // exactly what a worker would have handed it.
    env: { ...env, PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
  });
  if (r.status !== 0) throw new Error(`worker failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** A model reference from a runtime, without any SDK anywhere. */
function fakeCatalog(): ModelRuntimeLike {
  return {
    providers: () => ["anthropic"],
    getModel: (provider: string, id: string) => ({ id, provider }),
    checkAuth: async () => true,
    defaultModel: () => ({ provider: "anthropic", id: "default", display: "anthropic/default" }),
  } as ModelRuntimeLike;
}

function piRuntimeWith(startPiSession: (start: {
  cwd: string;
  model: unknown;
  native: unknown;
  signal: AbortSignal;
}) => Promise<SessionHandle>) {
  return createPiRuntime({
    loadServices: async () => ({ catalog: fakeCatalog(), openSession: startPiSession as never }),
  });
}

function handle(): SessionHandle {
  return {
    file: "/sessions/x.jsonl",
    id: "x",
    prompt: async () => "done",
    dispose: () => {},
  };
}

const START = { cwd: "/work", signal: new AbortController().signal };

function contextFor(): RunContext {
  return Object.freeze({
    runId: "run-1",
    key: "user:/a:x",
    name: "x",
    scope: "user" as const,
    trigger: "manual" as const,
    late: false,
    automationDir: "/a/x",
    rootDir: "/a",
    stateDir: "/state",
  });
}

describe("core hands the environment over, and never writes it", () => {
  it("leaves the parent environment byte-identical across a whole run", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "env-clean" });
    const before = envSnapshot();

    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir));

    expect(rec.outcome).toBe("ok");
    expect(envSnapshot()).toBe(before);
  });

  it("leaves it byte-identical when two runs are in flight together", async () => {
    const one = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "env-race-a" });
    const two = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "env-race-b" });
    const before = envSnapshot();

    const [a, b] = await Promise.all([
      fire(one.located, MANUAL, isolatedFireDeps(one.stateDir)),
      fire(two.located, MANUAL, isolatedFireDeps(two.stateDir)),
    ]);

    expect([a.outcome, b.outcome]).toEqual(["ok", "ok"]);
    expect(envSnapshot()).toBe(before);
  });

  it("hands the runtime a frozen context and an overlay it did not apply", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "env-handover" });
    let seen: RuntimeSessionStart | undefined;

    const runtime: AutomationRuntime = {
      resolveModel: async () =>
        Object.freeze({ provider: "p", id: "m", display: "p/m" }) as RuntimeModelRef,
      startSession: async (start) => {
        seen = start;
        return handle();
      },
    };

    await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir, { runtime }));

    expect(seen).toBeDefined();
    expect(Object.isFrozen(seen?.context)).toBe(true);
    expect(seen?.context.runId).toBeTruthy();
    expect(seen?.context.key).toBe(a.located.key);
    expect(seen?.context.stateDir).toBe(a.stateDir);
    // Untracked run: nothing to overlay, and core did not invent one.
    expect(seen?.env).toBeUndefined();
  });

  it("refuses to let an integration edit the context it was given", () => {
    const context = contextFor();
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      (context as unknown as { runId: string }).runId = "someone-elses-run";
    }).toThrow();
    expect(context.runId).toBe("run-1");
  });

  it("writes process.env nowhere under src/ except the pi worker", () => {
    // The behavioural checks above prove today's paths. This one proves there is no OTHER path: a
    // new `process.env.X = …` anywhere in core, a provider or the UI fails here.
    const root = path.join(import.meta.dirname, "..", "src");

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);

    const WRITE = /process\.env(\.\w+|\[[^\]]+\])\s*=[^=]/;
    const offenders = files
      .filter((f) => WRITE.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).replace(/\\/g, "/"))
      .sort();

    expect(files.length).toBeGreaterThan(20);
    expect(offenders).toEqual(["providers/pi/runtime.ts"]);

    // And the scan can fail: the same rule applied to a synthetic writer finds it.
    expect(WRITE.test('process.env.AUTOMATION_NODE = "body";')).toBe(true);
    expect(WRITE.test('const x = process.env.AUTOMATION_NODE === "body";')).toBe(false);
  });
});

// ------------------------------------------------------------------ tracking is composed, not
// built

/** A tracker that records what it was asked, with no store and no subprocess anywhere. */
function fakeTracking(over: { fail?: string; problem?: string } = {}) {
  const calls: string[] = [];
  let started = false;

  const start: StartFlowTracking = (request) => {
    calls.push(`request:${request.context.key}:${request.force ? "forced" : "normal"}`);
    if (over.problem !== undefined) {
      // Requested, but the tracker could not be built. The run is not affected; the reason is.
      request.onProblem?.(over.problem);
      return undefined;
    }
    return {
      start: () => {
        started = true;
        calls.push("start");
        if (over.fail) request.onProblem?.(over.fail);
        return "session-1";
      },
      next: (node) => calls.push(`next:${node}`),
      step: (node) => calls.push(`step:${node}`),
      mark: (node, status) => calls.push(`mark:${node}:${status}`),
      say: () => calls.push("say"),
      end: (status) => {
        calls.push(`end:${status}`);
        return started
          ? {
              chart: "flowchart TD\n  body",
              steps: [{ id: "body", label: "body", status: "done" as const, text: "wrote it" }],
              taken: [],
              notes: [{ ts: "2026-01-01T00:00:00.000Z", text: "posted", links: [{ label: "pr", url: "https://x.test/1" }] }],
            }
          : undefined;
      },
      environment: (node) => progressEnvironment({ runId: "session-1", stateDir: "/state", node }),
    };
  };

  return { start, calls };
}

describe("tracking is something the host composes", () => {
  it("does not track at all when nothing was composed", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "untracked" });
    const rec = await fire(a.located, MANUAL, isolatedFireDeps(a.stateDir));

    expect(rec.outcome).toBe("ok");
    // Not tracked, and not noisy about it: no steps, no problem, no key at all.
    expect(rec.flow).toBeUndefined();
    expect(rec.steps).toBeUndefined();
  });

  it("tracks the whole run through whatever it was given", async () => {
    const a = isolatedAutomation({
      frontmatter: "on:\n  manual: true\nhooks:\n  post:\n    - prompt: Say goodbye.\n",
      name: "tracked",
    });
    const tracking = fakeTracking();
    const events: string[] = [];

    const rec = await fire(
      a.located,
      { ...MANUAL, emit: (e) => events.push(e.event) },
      isolatedFireDeps(a.stateDir, { startTracking: tracking.start }),
    );

    expect(rec.outcome).toBe("ok");
    // What the tracker recorded is folded into the record, and there was no problem to report.
    expect(rec.flow).toBeUndefined();
    expect(rec.chart).toBe("flowchart TD\n  body");
    expect(rec.steps).toEqual([{ id: "body", label: "body", status: "done", text: "wrote it" }]);
    expect(rec.taken).toBeUndefined();
    expect(rec.notes?.[0]?.links).toEqual([{ label: "pr", url: "https://x.test/1" }]);
    expect(events).toContain("flow");

    // The lifecycle it drove: begin, the body, its outcome, the post hook, and a close.
    expect(tracking.calls[0]).toBe(`request:${a.located.key}:normal`);
    expect(tracking.calls).toContain("start");
    expect(tracking.calls).toContain("next:body");
    expect(tracking.calls).toContain("mark:body:done");
    expect(tracking.calls).toContain("step:post0");
    expect(tracking.calls).toContain("end:ok");
  });

  it("asks for a forced run explicitly, without touching the automation's own config", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "forced" });
    const tracking = fakeTracking();

    await fire(
      a.located,
      { ...MANUAL, forceFlow: true },
      isolatedFireDeps(a.stateDir, { startTracking: tracking.start }),
    );

    expect(tracking.calls[0]).toBe(`request:${a.located.key}:forced`);
  });

  it("keeps the actionable problem when tracking was asked for and could not start", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "unwritable" });
    const tracking = fakeTracking({
      problem: "progress open: EACCES the state directory is read-only",
    });

    const rec = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, { startTracking: tracking.start }),
    );

    // The automation is unaffected; the reason is on the record, not in the outcome.
    expect(rec.outcome).toBe("ok");
    expect(rec.flow).toEqual({ problem: "progress open: EACCES the state directory is read-only" });
  });

  it("keeps the problem when tracking degrades AFTER it started", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "degraded" });
    const tracking = fakeTracking({ fail: "progress step: LOCK_TIMEOUT" });

    const rec = await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, { startTracking: tracking.start }),
    );

    expect(rec.outcome).toBe("ok");
    expect(rec.steps).toBeDefined();
    expect(rec.flow?.problem).toBe("progress step: LOCK_TIMEOUT");
  });

  it("makes no SECOND environment change to track a run", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "tracked-env" });
    const tracking = fakeTracking();
    const before = envSnapshot();

    await fire(
      a.located,
      MANUAL,
      isolatedFireDeps(a.stateDir, { startTracking: tracking.start }),
    );

    // Tracking contributes DATA. The only thing that ever applies it is the runtime, in its own
    // worker, and the fixture runtime here applies nothing at all.
    expect(envSnapshot()).toBe(before);
  });

  it("gives the body and each hook the same run on their own nodes", () => {
    const tracking = fakeTracking();
    const flow = tracking.start({
      context: contextFor(),
      automation: { name: "x" } as never,
      config: DEFAULTS,
    });
    expect(flow).toBeDefined();
    if (!flow) return;

    const body = flow.environment("body");
    const pre = flow.environment(nodeIdFor("pre", 0));

    expect(body.AUTOMATION_RUN).toBe(pre.AUTOMATION_RUN);
    expect(body.AUTOMATION_STATE_DIR).toBe(pre.AUTOMATION_STATE_DIR);
    expect(body.AUTOMATION_NODE).toBe("body");
    expect(pre.AUTOMATION_NODE).toBe("pre0");
  });
});

describe("the pi worker applies the overlay, and puts it back", () => {
  const overlay = progressEnvironment({ runId: "s-1", stateDir: "/state", node: "body" });

  it("applies it BEFORE the session starts", async () => {
    let atStart: Record<string, string | undefined> = {};
    const runtime = piRuntimeWith(async () => {
      // The starter is what builds the resource loader and calls createAgentSession, so what it
      // sees here is what the SDK — and everything the SDK spawns — will see.
      atStart = { ...process.env };
      return handle();
    });

    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const session = await runtime.startSession({ ...START, model, context: contextFor(), env: overlay });

    expect(atStart.AUTOMATION_RUN).toBe("s-1");
    expect(atStart.AUTOMATION_NODE).toBe("body");
    expect(atStart.AUTOMATION_STATE_DIR).toBe("/state");
    await session.dispose();
  });

  it("restores on disposal, deleting keys that were not there before", async () => {
    const before = envSnapshot();
    const runtime = piRuntimeWith(async () => handle());

    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const session = await runtime.startSession({ ...START, model, context: contextFor(), env: overlay });
    expect(process.env.AUTOMATION_RUN).toBe("s-1");

    await session.dispose();

    expect(envSnapshot()).toBe(before);
    expect("AUTOMATION_RUN" in process.env).toBe(false);
  });

  it("restores a PREVIOUS value rather than deleting it", async () => {
    setParent("AUTOMATION_RUN", "the-host-was-already-using-this");
    const before = envSnapshot();
    const runtime = piRuntimeWith(async () => handle());

    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const session = await runtime.startSession({ ...START, model, context: contextFor(), env: overlay });
    expect(process.env.AUTOMATION_RUN).toBe("s-1");
    await session.dispose();

    expect(process.env.AUTOMATION_RUN).toBe("the-host-was-already-using-this");
    expect(envSnapshot()).toBe(before);
  });

  it("restores when STARTUP FAILS, so the worker is not left wearing an identity", async () => {
    const before = envSnapshot();
    const runtime = piRuntimeWith(async () => {
      throw new Error("the SDK refused");
    });

    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    await expect(
      runtime.startSession({ ...START, model, context: contextFor(), env: overlay }),
    ).rejects.toThrow("the SDK refused");

    expect(envSnapshot()).toBe(before);
  });

  it("does nothing at all when there is no overlay", async () => {
    const before = envSnapshot();
    const runtime = piRuntimeWith(async () => handle());
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const session = await runtime.startSession({ ...START, model, context: contextFor() });
    expect(envSnapshot()).toBe(before);
    await session.dispose();
    expect(envSnapshot()).toBe(before);
  });
});

describe("one automation per worker", () => {
  const overlay = progressEnvironment({ runId: "s-first", stateDir: "/state", node: "body" });

  it("refuses a second session without disturbing the first", async () => {
    const before = envSnapshot();
    const runtime = piRuntimeWith(async () => handle());

    const first = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const session = await runtime.startSession({ ...START, model: first, context: contextFor(), env: overlay });

    const second = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const refusal = await runtime
      .startSession({
        ...START,
        model: second,
        context: contextFor(),
        env: progressEnvironment({ runId: "s-second", stateDir: "/elsewhere", node: "body" }),
      })
      .catch((e: unknown) => e);

    expect((refusal as Error).message).toBe(OVERLAPPING_SESSION_MESSAGE);
    // The FIRST session's environment is untouched by the refusal — not overwritten, not restored.
    expect(process.env.AUTOMATION_RUN).toBe("s-first");
    expect(process.env.AUTOMATION_STATE_DIR).toBe("/state");

    // And the first session still owns its own cleanup.
    await session.dispose();
    expect(envSnapshot()).toBe(before);
  });

  it("is a HOST failure, not the agent's and not the model's", () => {
    const runtime = piRuntimeWith(async () => handle());
    expect(runtime).toBeDefined();
    const refusal = Object.assign(new Error(OVERLAPPING_SESSION_MESSAGE), { kind: "host" });
    expect(classifyFireError(refusal)).toBe("host");
    // An unrecognised failure is still `agent`: declaring a kind is opt-in, not a new default.
    expect(classifyFireError(new Error("something else went wrong"))).toBe("agent");
    // And a nonsense kind is ignored rather than trusted.
    expect(classifyFireError(Object.assign(new Error("x"), { kind: "catastrophe" }))).toBe("agent");
  });

  it("lets the worker start another session once the first is disposed", async () => {
    const runtime = piRuntimeWith(async () => handle());
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");

    const first = await runtime.startSession({ ...START, model, context: contextFor(), env: overlay });
    await first.dispose();

    const second = await runtime.startSession({ ...START, model, context: contextFor(), env: overlay });
    expect(second.id).toBe("x");
    await second.dispose();
  });
});

describe("a replacement tracker reaches the body AND every hook", () => {
  // A tracker that returns values core could not have invented.
  //
  // `AUTOMATION_NODE` is prefixed, so "the provider produced this" and "core reconstructed this"
  // are distinguishable: core's old assembly would have written exactly `pre0`, never `via:pre0`.
  function replacementTracker() {
    const asked: string[] = [];
    return {
      asked,
      context: {
        environment: (node: string) => {
          asked.push(node);
          return Object.freeze({
            AUTOMATION_RUN: "replacement-session",
            AUTOMATION_STATE_DIR: "/replacement/state",
            AUTOMATION_NODE: `via:${node}`,
          });
        },
      },
    };
  }

  const located = { automation: { name: "a" }, key: "k", root: { scope: "user" }, dir: "/d" };
  const run: RunInfo = { id: "r1", trigger: "manual" } as RunInfo;

  it("hands each hook the PROVIDER's overlay for its own node, not a reconstruction", () => {
    const tracker = replacementTracker();
    const pre = hookEnv(located as never, run, "pre", 0, undefined, undefined, tracker.context);
    const post = hookEnv(located as never, run, "post", 0, "ok", undefined, tracker.context);

    expect(pre.AUTOMATION_NODE).toBe("via:pre0");
    expect(post.AUTOMATION_NODE).toBe("via:post0");
    expect(pre.AUTOMATION_RUN).toBe("replacement-session");
    // The tracker was ASKED, once per node — the values did not come from anywhere else.
    expect(tracker.asked).toEqual(["pre0", "post0"]);
  });

  it("puts those values into real pre, body and post children", () => {
    const tracker = replacementTracker();
    const pre = hookEnv(located as never, run, "pre", 0, undefined, undefined, tracker.context);
    const post = hookEnv(located as never, run, "post", 0, "ok", undefined, tracker.context);
    const body = tracker.context.environment("body");

    const inPre = runWorker({ ...pre });
    const inBody = runWorker({ ...body });
    const inPost = runWorker({ ...post });

    // Three real processes, three distinct node identities, all of them the provider's.
    expect(inPre.self.AUTOMATION_NODE).toBe("via:pre0");
    expect(inBody.self.AUTOMATION_NODE).toBe("via:body");
    expect(inPost.self.AUTOMATION_NODE).toBe("via:post0");
    expect(inPre.self.AUTOMATION_RUN).toBe("replacement-session");
    expect(inBody.self.AUTOMATION_RUN).toBe("replacement-session");
    expect(inPost.self.AUTOMATION_RUN).toBe("replacement-session");
    expect(new Set([inPre.pid, inBody.pid, inPost.pid]).size).toBe(3);
  });

  it("contributes nothing at all when the run is untracked", () => {
    const pre = hookEnv(located as never, run, "pre", 0);
    const post = hookEnv(located as never, run, "post", 0, "ok");

    for (const env of [pre, post]) {
      expect(env.AUTOMATION_RUN).toBeUndefined();
      expect(env.AUTOMATION_NODE).toBeUndefined();
      expect(env.AUTOMATION_STATE_DIR).toBeUndefined();
    }
    // And the run's own identity is still there, because that was never the tracker's to give.
    expect(pre.AUTOMATION_NAME).toBe("a");
  });

  it("reports on every phase, and exports no chart identity of its own", () => {
    const tracker = replacementTracker();
    const pre = hookEnv(located as never, run, "pre", 0, undefined, undefined, tracker.context);
    const post = hookEnv(located as never, run, "post", 0, "ok", undefined, tracker.context);

    expect(pre.AUTOMATION_NODE).toBe("via:pre0");
    expect(post.AUTOMATION_NODE).toBe("via:post0");
    for (const env of [pre, post]) {
      for (const k of Object.keys(env)) expect(k).not.toMatch(/AUTOMATION_FLOW|AUTOMATION_FM|^FM_/);
    }
  });
});

describe("what a real child actually inherits", () => {
  it("gives two workers their own identities, and neither sees the other's", () => {
    const one = runWorker({ AUTOMATION_RUN: "session-one", AUTOMATION_NODE: "body", AUTOMATION_STATE_DIR: "/one" });
    const two = runWorker({ AUTOMATION_RUN: "session-two", AUTOMATION_NODE: "pre0", AUTOMATION_STATE_DIR: "/two" });

    expect(one.self.AUTOMATION_RUN).toBe("session-one");
    expect(two.self.AUTOMATION_RUN).toBe("session-two");
    expect(one.self.AUTOMATION_NODE).toBe("body");
    expect(two.self.AUTOMATION_NODE).toBe("pre0");
    expect(one.pid).not.toBe(two.pid);
    // Two isolated processes, not one reading a shared value.
    expect(one.self.AUTOMATION_STATE_DIR).toBe("/one");
    expect(two.self.AUTOMATION_STATE_DIR).toBe("/two");
  });

  it("passes the identity down to what the worker itself spawns", () => {
    // This is the SDK-subagent shape: the worker spawns a child with no environment of its own, so
    // whatever the child reports it inherited.
    const r = runWorker(
      { AUTOMATION_RUN: "session-one", AUTOMATION_NODE: "body", AUTOMATION_STATE_DIR: "/one" },
      ["--spawn-child"],
    );

    expect(r.child).not.toBeNull();
    expect(r.child?.AUTOMATION_RUN).toBe("session-one");
    expect(r.child?.AUTOMATION_NODE).toBe("body");
  });

  it("gives a HOOK child its own node, and the body's node to nobody else", async () => {
    const dir = tempDir("pi-env-hook-");
    mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "report.js");
    writeFileSync(
      script,
      "const k=['AUTOMATION_RUN','AUTOMATION_NODE','AUTOMATION_STATE_DIR','AUTOMATION_OUTCOME','MY_API_KEY','MY_TOKEN','MY_SECRET'];" +
        "const o={};for(const n of k)o[n]=Object.prototype.hasOwnProperty.call(process.env,n)?process.env[n]:null;" +
        "console.log(JSON.stringify(o));\n",
    );

    const located = {
      automation: {
        name: "hooked",
        description: "d",
        enabled: true,
        on: { manual: true },
        hooks: { pre: [{ script: "report.js" }], post: [{ script: "report.js" }] },
        body: "b",
      },
      dir,
      file: path.join(dir, "AUTOMATION.md"),
      root: { path: dir, scope: "user" as const, kind: "agents" as const },
      key: "user:/a:hooked",
    };
    const run: RunInfo = { runId: "run-hooks", trigger: "manual", late: false };
    const flow = {
      environment: (node: string) => progressEnvironment({ runId: "s-hooks", stateDir: "/state", node }),
    };

    // A credential in the PARENT, which the hook child must never receive.
    setParent("MY_API_KEY", "super-secret");
    setParent("MY_TOKEN", "also-secret");
    setParent("MY_SECRET", "likewise");

    const pre = await runScriptHook(
      located as never,
      { script: "report.js" },
      "pre",
      0,
      run,
      undefined,
      { config: DEFAULTS, runScript: runLocalScript, timeoutMs: 8000, flow } as never,
    );
    const post = await runScriptHook(
      located as never,
      { script: "report.js" },
      "post",
      0,
      run,
      undefined,
      { config: DEFAULTS, runScript: runLocalScript, timeoutMs: 8000, flow } as never,
      { outcome: "ok" as const },
    );

    expect(pre.result.status).toBe("ok");
    expect(post.result.status).toBe("ok");

    // Both hooks report onto the chart; each on ITS OWN node, and neither on the body's.
    const preEnv = hookEnv(located as never, run, "pre", 0, undefined, undefined, flow);
    const postEnv = hookEnv(located as never, run, "post", 0, "ok", undefined, flow);
    expect(preEnv.AUTOMATION_NODE).toBe(nodeIdFor("pre", 0));
    expect(postEnv.AUTOMATION_NODE).toBe(nodeIdFor("post", 0));
    expect(preEnv.AUTOMATION_NODE).not.toBe(postEnv.AUTOMATION_NODE);
    expect(preEnv.AUTOMATION_NODE).not.toBe(nodeIdFor("body"));
    expect(preEnv.AUTOMATION_RUN).toBe("s-hooks");
    expect(postEnv.AUTOMATION_RUN).toBe("s-hooks");

    // How the run went is post-only: a pre hook runs before there is an outcome.
    expect(preEnv.AUTOMATION_OUTCOME).toBeUndefined();
    expect(postEnv.AUTOMATION_OUTCOME).toBe("ok");

    // And nothing that looks like a credential is in either.
    for (const env of [preEnv, postEnv]) {
      for (const key of Object.keys(env)) expect(key).not.toMatch(/(_API_KEY|_TOKEN|_SECRET)$/i);
    }
  });

  it("strips credentials from the environment a real hook child is given", async () => {
    const dir = tempDir("pi-env-secret-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "leak.js"),
      "const bad=Object.keys(process.env).filter(k=>/(_API_KEY|_TOKEN|_SECRET)$/i.test(k));" +
        "if(bad.length){console.error('LEAKED '+bad.join(','));process.exit(9);}\n",
    );

    setParent("MY_API_KEY", "super-secret");
    setParent("ANOTHER_TOKEN", "also-secret");
    setParent("THIRD_SECRET", "likewise");

    const located = {
      automation: {
        name: "secretive",
        description: "d",
        enabled: true,
        on: { manual: true },
        hooks: { pre: [{ script: "leak.js" }], post: [] },
        body: "b",
      },
      dir,
      file: path.join(dir, "AUTOMATION.md"),
      root: { path: dir, scope: "user" as const, kind: "agents" as const },
      key: "user:/a:secretive",
    };

    const result = await runScriptHook(
      located as never,
      { script: "leak.js" },
      "pre",
      0,
      { runId: "run-secret", trigger: "manual", late: false },
      undefined,
      { config: DEFAULTS, runScript: runLocalScript, timeoutMs: 8000 } as never,
    );

    // The child exits 9 only if it found one, and a non-zero pre hook stops the run — so an "ok"
    // here IS the proof.
    expect(result.result.status).toBe("ok");
    expect(result.result.exit).toBe(0);
  });
});
