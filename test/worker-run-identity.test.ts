/** The JOINED worker identity proof. */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nodeIdFor } from "../src/nodes.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const HELPERS = path.join(import.meta.dirname, "helpers");
const RUN_WORKER = path.join(HELPERS, "run-worker.js");
const ENV_WORKER = path.join(HELPERS, "env-worker.js");

/** Credentials the workers are given, so hook filtering is exercised rather than assumed. */
const SECRETS = {
  WORKER_API_KEY: "super-secret",
  WORKER_TOKEN: "also-secret",
  WORKER_SECRET: "likewise",
  WORKER_ORDINARY: "visible",
};

interface WorkerReport {
  id: string;
  pid: number;
  sdkPresent: boolean;
  sdkDetail: string;
  injected: { catalogLoads: number; sessionStarts: number; promptsAsked: number };
  before: Record<string, string | null>;
  duringSession: Record<string, string | null>;
  after: Record<string, string | null>;
  sdkChild: Record<string, string | null>;
  pre: Record<string, string | null>;
  post: Record<string, string | null>;
  barrier: { used: boolean; peerPid?: number };
  record: { outcome: string; reason: string | null; hooks: Array<Record<string, unknown>> };
}

// Launch one worker, and remember its pid so it can be cleaned up by identity.
//
// The environment is built EXPLICITLY and contains no flow identity of any kind. That is the whole
// premise: anything the report shows had to be produced by the run.
function launch(
  args: string[],
  live: Set<number>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN_WORKER, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        HOME: process.env.HOME ?? "",
        USERPROFILE: process.env.USERPROFILE ?? "",
        ...SECRETS,
      },
    });
    if (child.pid !== undefined) live.add(child.pid);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (child.pid !== undefined) live.delete(child.pid);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Kill exactly the pids this test started, and nothing else. */
function reap(live: Set<number>): void {
  for (const pid of live) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  live.clear();
}

/** The two simultaneous workers, run once and shared by every assertion below. */
let ALPHA: WorkerReport;
let BRAVO: WorkerReport;
let PARENT_ENV_BEFORE = "";
let PARENT_ENV_AFTER = "";

const live = new Set<number>();

/** Launch both workers ONCE, in `beforeAll`, with a budget of its own. */
async function runBoth(): Promise<void> {
  PARENT_ENV_BEFORE = JSON.stringify(process.env);

  const base = tempDir("pi-joined-");
  const barrier = path.join(base, "barrier");
  mkdirSync(barrier, { recursive: true });

  const make = (id: string) => {
    const root = path.join(base, id, "roots");
    const state = path.join(base, id, "state");
    mkdirSync(root, { recursive: true });
    mkdirSync(state, { recursive: true });
    return [
      "--id", id,
      "--root", root,
      "--state", state,
      "--session", `run-${id}`,
      "--barrier", barrier,
      "--peer", id === "alpha" ? "bravo" : "alpha",
    ];
  };

  const timer = setTimeout(() => reap(live), 90_000);
  try {
    const [a, b] = await Promise.all([launch(make("alpha"), live), launch(make("bravo"), live)]);

    // A worker that could not do its job must never look like one that did.
    if (a.code !== 0) throw new Error(`alpha exited ${a.code}: ${a.stderr}`);
    if (b.code !== 0) throw new Error(`bravo exited ${b.code}: ${b.stderr}`);

    ALPHA = JSON.parse(a.stdout.trim().split("\n").pop() as string) as WorkerReport;
    BRAVO = JSON.parse(b.stdout.trim().split("\n").pop() as string) as WorkerReport;
  } finally {
    clearTimeout(timer);
    reap(live);
  }

  PARENT_ENV_AFTER = JSON.stringify(process.env);
}

beforeAll(runBoth, 180_000);

describe("two real workers, each running a real fire", () => {
  it("is given no flow identity at all when it starts", () => {
    // The premise, asserted rather than assumed. If this ever fails, nothing below means anything.
    for (const w of [ALPHA, BRAVO]) {
      expect(w.before).toEqual({ AUTOMATION_RUN: null, AUTOMATION_NODE: null, AUTOMATION_STATE_DIR: null });
    }
  });

  it("wears the body's identity while its session is open", () => {
    expect(ALPHA.duringSession.AUTOMATION_RUN).toBe("run-alpha");
    expect(ALPHA.duringSession.AUTOMATION_NODE).toBe("body");
    expect(BRAVO.duringSession.AUTOMATION_RUN).toBe("run-bravo");
    expect(BRAVO.duringSession.AUTOMATION_NODE).toBe("body");
    // It came from tracking, through core, to the adapter — the launch environment had none of it.
    expect(ALPHA.duringSession.AUTOMATION_STATE_DIR).toContain("state");
  });

  it("hands that identity to a child the SDK spawns, with no environment of its own", () => {
    expect(ALPHA.sdkChild.AUTOMATION_RUN).toBe("run-alpha");
    expect(ALPHA.sdkChild.AUTOMATION_NODE).toBe("body");
    expect(BRAVO.sdkChild.AUTOMATION_RUN).toBe("run-bravo");
    expect(BRAVO.sdkChild.AUTOMATION_NODE).toBe("body");
  });

  it("gives the SDK child the flow identity and NOT the hook table", () => {
    // The overlay is the progress identity. The hook table belongs to a hook's environment, and a
    // subagent inheriting a hook's variables would report under a phase it is not in.
    expect(ALPHA.sdkChild.AUTOMATION_NAME).toBeNull();
    expect(ALPHA.sdkChild.AUTOMATION_PHASE).toBeNull();
    expect(ALPHA.sdkChild.AUTOMATION_RUN_ID).toBeNull();
  });

  it("gives each hook child its OWN node, from the same run", () => {
    for (const w of [ALPHA, BRAVO]) {
      expect(w.pre.AUTOMATION_NODE).toBe(nodeIdFor("pre", 0));
      expect(w.post.AUTOMATION_NODE).toBe(nodeIdFor("post", 0));
      // Same session as the body, different node — that is what keeps two things running at once
      // from colliding on the chart.
      expect(w.pre.AUTOMATION_RUN).toBe(w.duringSession.AUTOMATION_RUN);
      expect(w.post.AUTOMATION_RUN).toBe(w.duringSession.AUTOMATION_RUN);
      expect(w.pre.AUTOMATION_NODE).not.toBe(w.duringSession.AUTOMATION_NODE);
    }
  });

  it("tells only POST hooks how the run went, and every hook the same state directory", () => {
    for (const w of [ALPHA, BRAVO]) {
      expect(w.pre.AUTOMATION_OUTCOME).toBeNull();
      expect(w.post.AUTOMATION_OUTCOME).toBe("ok");
      expect(w.pre.AUTOMATION_STATE_DIR).toBe(w.duringSession.AUTOMATION_STATE_DIR);
      expect(w.post.AUTOMATION_STATE_DIR).toBe(w.duringSession.AUTOMATION_STATE_DIR);
    }
  });

  it("filters credentials out of a real hook child, selectively", () => {
    for (const w of [ALPHA, BRAVO]) {
      for (const phase of [w.pre, w.post]) {
        expect(phase.WORKER_API_KEY).toBeNull();
        expect(phase.WORKER_TOKEN).toBeNull();
        expect(phase.WORKER_SECRET).toBeNull();
        // Selective, not blanket: an ordinary variable still reaches the hook, so the filter is
        // doing something narrower than "hand over nothing".
        expect(phase.WORKER_ORDINARY).toBe("visible");
      }
    }
  });
});

describe("the two sessions are live at the same moment", () => {
  it("meets its peer at the barrier, inside the session", () => {
    // Both reports came from the far side of a rendezvous that happens AFTER the overlay is applied
    // and BEFORE the session returns, so each worker was wearing its identity while the other was
    // wearing a different one. Without this, "distinct" could just mean "sequential".
    expect(ALPHA.barrier.used).toBe(true);
    expect(BRAVO.barrier.used).toBe(true);
    expect(ALPHA.barrier.peerPid).toBe(BRAVO.pid);
    expect(BRAVO.barrier.peerPid).toBe(ALPHA.pid);
  });

  it("keeps the two run identities apart in every child", () => {
    expect(ALPHA.pid).not.toBe(BRAVO.pid);
    expect(ALPHA.duringSession.AUTOMATION_RUN).not.toBe(BRAVO.duringSession.AUTOMATION_RUN);
    expect(ALPHA.sdkChild.AUTOMATION_RUN).not.toBe(BRAVO.sdkChild.AUTOMATION_RUN);
    expect(ALPHA.pre.AUTOMATION_RUN).not.toBe(BRAVO.pre.AUTOMATION_RUN);
    expect(ALPHA.post.AUTOMATION_RUN).not.toBe(BRAVO.post.AUTOMATION_RUN);
    // Different runs entirely, not one run observed twice.
    expect(ALPHA.pre.AUTOMATION_RUN_ID).not.toBe(BRAVO.pre.AUTOMATION_RUN_ID);
  });
});

describe("nothing keeps the identity after the run", () => {
  it("restores each worker's own environment", () => {
    for (const w of [ALPHA, BRAVO]) {
      // Absent again, not blanked: `AUTOMATION_RUN=""` is not the same as no `AUTOMATION_RUN` to
      // anything reading it.
      expect(w.after).toEqual({ AUTOMATION_RUN: null, AUTOMATION_NODE: null, AUTOMATION_STATE_DIR: null });
    }
  });

  it("leaves the parent test process byte-unchanged", () => {
    expect(PARENT_ENV_AFTER).toBe(PARENT_ENV_BEFORE);
    expect(process.env.AUTOMATION_RUN).toBeUndefined();
    expect(process.env.AUTOMATION_NODE).toBeUndefined();
  });

  it("completed a real run, so none of the above is vacuous", () => {
    for (const w of [ALPHA, BRAVO]) {
      expect(w.record.outcome).toBe("ok");
      expect(w.record.hooks).toEqual([
        { phase: "pre", index: 0, status: "ok" },
        { phase: "post", index: 0, status: "ok" },
      ]);
    }
  });
});

describe("no model call was possible", () => {
  it("reached the injected seams, exactly once each", () => {
    for (const w of [ALPHA, BRAVO]) {
      // This is the control, and it is falsifiable: if either injection were ignored, the adapter
      // would have constructed the real loader instead and these would be 0.
      expect(w.injected.catalogLoads).toBe(1);
      expect(w.injected.sessionStarts).toBe(1);
      expect(w.injected.promptsAsked).toBe(1);
    }
  });

  it("states honestly whether the SDK is even reachable here", () => {
    // Deliberately NOT asserted either way.
    expect(typeof ALPHA.sdkPresent).toBe("boolean");
    expect(ALPHA.sdkPresent).toBe(BRAVO.sdkPresent);
  });
});

describe("the worker fixture resolves its own path correctly", () => {
  it("relaunches itself from a directory containing a space", async () => {
    const dir = path.join(tempDir("pi-spacey-"), "a folder with spaces");
    mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, "env-worker.js");
    copyFileSync(ENV_WORKER, copy);

    const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [copy, "--spawn-child"], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, AUTOMATION_RUN: "spacey", AUTOMATION_NODE: "body" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
        child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      },
    );

    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.child).not.toBeNull();
    expect(report.child.AUTOMATION_RUN).toBe("spacey");
  });

  it("shows exactly why the old path expression could not have worked", () => {
    // Falsifiable, and not Windows-only.
    const dir = path.join(tempDir("pi-spacey-why-"), "a folder with spaces");
    mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, "env-worker.js");
    copyFileSync(ENV_WORKER, copy);

    const url = pathToFileURL(copy).href;
    const old = new URL(url).pathname.replace(/^\//, "");
    const now = fileURLToPath(url);

    expect(old).toContain("%20");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(now)).toBe(true);
    expect(now).toBe(copy);
  });
});

describe("a worker that cannot do its job never reports success", () => {
  it("exits non-zero and writes no report when its child cannot start", async () => {
    const base = tempDir("pi-joined-broken-");
    const root = path.join(base, "roots");
    const state = path.join(base, "state");
    mkdirSync(root, { recursive: true });
    mkdirSync(state, { recursive: true });
    // The session's reporting child, pointed at a file that is not there. Everything else about
    // this run is exactly the working one above, so the ONLY difference is a child that cannot
    // launch — which is precisely the case that must not come back looking like data.
    const missing = path.join(base, "no-such-child.js");

    const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            RUN_WORKER,
            "--id", "broken",
            "--root", root,
            "--state", state,
            "--session", "fm-broken",
            "--child", missing,
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
        child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      },
    );

    expect(r.code).not.toBe(0);
    // Not a report with empty fields — no report at all. A test asserting against one of those
    // would be asserting against a run that never happened.
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toBeTruthy();
    // Its own timeout, well above the 10s default.
  }, 60_000);

  it("leaves no silent fallback in the env fixture either", () => {
    const src = readFileSync(ENV_WORKER, "utf8");
    // Turning a failed child into `child = { error: … }` and carrying on reads downstream as "the
    // child ran and saw nothing".
    expect(src).not.toMatch(/child\s*=\s*\{\s*error:/);
    expect(src).toContain("process.exit(21)");
    expect(src).toContain("process.exit(22)");
    expect(src).toContain("process.exit(23)");
    expect(src).toContain("fileURLToPath(import.meta.url)");
  });
});
