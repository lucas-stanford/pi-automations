/** `on.watch`: a script decides when to run, and no model is spent finding out. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { applyArm, handleCheck, handleWatch, consentPreview, type CommandDeps, type Refreshed } from "../src/commands.js";
import { DEFAULTS } from "../src/config.js";
import type { RunScript, ScriptCommand, ScriptExecution } from "../src/core/contracts.js";
import { digestOf, fileHashesOf } from "../src/digest.js";
import { discover, located } from "../src/discover.js";
import { runWatchScript } from "../src/hooks.js";
import { listingModel } from "../src/listing.js";
import { acquireRunLock, runLockInfo } from "../src/locks.js";
import { parseAutomation } from "../src/parse.js";
import { readRecords } from "../src/records.js";
import { runLocalScript } from "../src/providers/scripts.js";
import { State, readWatchState } from "../src/state.js";
import { computeStatuses } from "../src/status.js";
import { composeAutomationText, fieldsFromAutomation } from "../src/authoring/compose.js";
import { tick, type TickDeps } from "../src/tick.js";
import { Trust } from "../src/trust.js";
import type { Located, Status, Watch, WatchState } from "../src/types.js";
import {
  WATCH_SLACK_MS,
  WATCH_TIMEOUT_MAX_MS,
  decideWatch,
  fingerprint,
  nextCheckAt,
  saidLine,
  watchDue,
  type WatchCheck,
} from "../src/watch.js";
import { armUserRoot } from "./helpers/arm.js";
import { automationIn, isolatedHome, proveIsolated } from "./helpers/isolated-env.js";
import { keepTempDir, tempDir } from "./helpers/temp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const FIVE: Watch = { script: "scripts/watch.js", every: "5m" };

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const checked = (over: Partial<WatchState> = {}): WatchState => ({ checkedAt: ago(5 * 60_000), exit: 3, durationMs: 10, ...over });
const ran = (over: Partial<WatchCheck> = {}): WatchCheck => ({ exit: 0, stdout: "", stderr: "", durationMs: 12, ...over });

// ----------------------------------------------------------------------------------- decisions

describe("watchDue", () => {
  it("is due when it has never been checked", () => {
    expect(watchDue(undefined, FIVE, NOW)).toBe(true);
  });

  it("waits out its interval, less the slack a minute tick needs", () => {
    expect(watchDue(checked({ checkedAt: ago(4 * 60_000) }), FIVE, NOW)).toBe(false);
    expect(watchDue(checked({ checkedAt: ago(5 * 60_000 - WATCH_SLACK_MS) }), FIVE, NOW)).toBe(true);
    // A tick one second short of five minutes still counts, or every interval grows by a minute.
    expect(watchDue(checked({ checkedAt: ago(5 * 60_000 - 1000) }), FIVE, NOW)).toBe(true);
  });

  it("does not park the watch when the clock went backwards", () => {
    expect(watchDue(checked({ checkedAt: new Date(NOW.getTime() + 3_600_000).toISOString() }), FIVE, NOW)).toBe(true);
  });

  it("says when the next check is due, even when that is already past", () => {
    expect(nextCheckAt(undefined, FIVE, NOW).toISOString()).toBe(NOW.toISOString());
    expect(nextCheckAt(checked({ checkedAt: ago(60_000) }), FIVE, NOW).toISOString()).toBe(ago(-4 * 60_000));
    // Overdue is shown as overdue, not as "now": a watch nothing is running looks stuck.
    expect(nextCheckAt(checked({ checkedAt: ago(20 * 60_000) }), FIVE, NOW).toISOString()).toBe(ago(15 * 60_000));
  });
});

describe("decideWatch", () => {
  it("starts a run when the script finds something for the first time", () => {
    const d = decideWatch(undefined, ran({ stdout: "PR 12: 2 new comments\n" }), NOW);
    expect(d.fire).toBe(true);
    expect(d.next).toMatchObject({ exit: 0, firedAt: NOW.toISOString(), said: "PR 12: 2 new comments" });
    expect(d.next.firedFor).toBe(fingerprint("PR 12: 2 new comments"));
  });

  it("does not start the same work twice", () => {
    const prev = checked({ exit: 0, firedAt: ago(5 * 60_000), firedFor: fingerprint("PR 12") });
    const d = decideWatch(prev, ran({ stdout: "  PR 12\n" }), NOW);
    expect(d.fire).toBe(false);
    expect(d.because).toBe("the same as what started the last run");
    // Still remembered, so the check after this one does not fire it either.
    expect(d.next.firedFor).toBe(fingerprint("PR 12"));
    expect(d.next.firedAt).toBe(ago(5 * 60_000));
  });

  it("starts a run when what it finds changes", () => {
    const prev = checked({ exit: 0, firedFor: fingerprint("PR 12") });
    expect(decideWatch(prev, ran({ stdout: "PR 12\nPR 14" }), NOW).fire).toBe(true);
  });

  it("forgets the last finding when a check finds nothing, so the next find starts a run", () => {
    const fired = checked({ exit: 0, firedAt: ago(10 * 60_000), firedFor: fingerprint("x") });
    const nothing = decideWatch(fired, ran({ exit: 3, stderr: "nothing is waiting on you\n" }), NOW);
    expect(nothing.fire).toBe(false);
    expect(nothing.because).toBe("nothing to do (exit 3)");
    expect(nothing.next.firedFor).toBeUndefined();
    // The last run's time survives: a listing still says when the watch last started something.
    expect(nothing.next.firedAt).toBe(ago(10 * 60_000));
    expect(nothing.next.said).toBe("nothing is waiting on you");

    expect(decideWatch(nothing.next, ran({ stdout: "x" }), NOW).fire).toBe(true);
  });

  it("never starts a run when the script could not say anything", () => {
    const d = decideWatch(undefined, ran({ exit: undefined, problem: "scripts/watch.js timed out after 1m" }), NOW);
    expect(d.fire).toBe(false);
    expect(d.next.problem).toBe("scripts/watch.js timed out after 1m");
    expect(d.next.exit).toBeUndefined();
    expect(d.because).toContain("could not check");
  });

  it("keeps the finding and the last answer through a check that could not answer", () => {
    const fired = checked({ exit: 0, answeredAt: ago(5 * 60_000), firedAt: ago(5 * 60_000), firedFor: fingerprint("PR 12") });
    const hiccup = decideWatch(fired, ran({ exit: undefined, problem: "scripts/watch.js timed out after 1m" }), NOW);
    expect(hiccup.fire).toBe(false);
    expect(hiccup.next.checkedAt).toBe(NOW.toISOString());
    expect(hiccup.next.firedFor).toBe(fingerprint("PR 12"));
    // It looked at nothing, so "what changed since" still starts where the last real answer did.
    expect(hiccup.next.answeredAt).toBe(ago(5 * 60_000));
    // The same finding after the hiccup is the run already started, not a second one.
    expect(decideWatch(hiccup.next, ran({ stdout: "PR 12" }), new Date(NOW.getTime() + 5 * 60_000)).fire).toBe(false);
  });

  it("moves the last answer on every check that ran to an exit code", () => {
    const old = checked({ answeredAt: ago(10 * 60_000) });
    expect(decideWatch(old, ran({ exit: 3 }), NOW).next.answeredAt).toBe(NOW.toISOString());
    expect(decideWatch(old, ran({ stdout: "x" }), NOW).next.answeredAt).toBe(NOW.toISOString());
  });

  it("keeps one bounded line of what was said", () => {
    expect(saidLine(ran({ stdout: "\n\nfirst\nsecond" }))).toBe("first");
    expect(saidLine(ran({ exit: 1, stdout: "out", stderr: "warn\nthe reason\n" }))).toBe("the reason");
    expect(saidLine(ran({ exit: 1, stdout: "only out" }))).toBe("only out");
    expect(saidLine(ran({ stdout: "x".repeat(500) }))?.length).toBe(200);
    expect(saidLine(ran())).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------ the file

function writeWatchAutomation(root: string, name: string, extra = "", scripts: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: ${name}\ndescription: Watches for work.\non:\n  watch:\n    script: scripts/watch.js\n    every: 5m\n${extra}---\n\nDo the work.\n`,
  );
  writeFileSync(path.join(dir, "scripts", "watch.js"), "console.log('found');\n");
  for (const [rel, body] of Object.entries(scripts)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function locate(root: string, name: string): Located {
  const l = located(discover({ roots: [{ path: root, scope: "user", kind: "agents" }] })).find(
    (x) => x.automation.name === name,
  );
  if (!l) throw new Error(`fixture ${name} did not parse`);
  return l;
}

describe("on.watch in AUTOMATION.md", () => {
  it("is a trigger of its own: no schedule and no manual needed", () => {
    const a = parseAutomation(
      "---\nname: w\ndescription: d\non:\n  watch:\n    script: scripts/w.js\n    every: 10m\n---\n\nBody.\n",
      "w",
    );
    expect(a.on).toEqual({ manual: false, watch: { script: "scripts/w.js", every: "10m" } });
  });

  it("sits beside a schedule and a manual trigger", () => {
    const a = parseAutomation(
      '---\nname: w\ndescription: d\non:\n  schedule: "0 7 * * *"\n  watch:\n    script: w.sh\n    every: 1h\n  manual: true\n---\n\nBody.\n',
      "w",
    );
    expect(a.on.manual).toBe(true);
    expect(a.on.schedule?.cron).toBe("0 7 * * *");
    expect(a.on.watch).toEqual({ script: "w.sh", every: "1h" });
  });

  it("accepts the two ends of its interval", () => {
    for (const every of ["1m", "24h", "60s", "1440m"]) {
      const a = parseAutomation(`---\nname: w\ndescription: d\non:\n  watch:\n    script: w.js\n    every: ${every}\n---\n\nB.\n`, "w");
      expect(a.on.watch?.every).toBe(every);
    }
  });
});

describe("the consent pin covers the watch script", () => {
  it("hashes it, so editing it after arming returns the automation to off", () => {
    const root = tempDir("pi-watch-digest-");
    const dir = writeWatchAutomation(root, "pinned");
    const l = locate(root, "pinned");
    const before = digestOf(l);
    expect(fileHashesOf(l)).toHaveProperty("scripts/watch.js");

    writeFileSync(path.join(dir, "scripts", "watch.js"), "console.log('something else');\n");
    expect(digestOf(l)).not.toBe(before);
  });

  it("names the watch script when it is missing", () => {
    const root = tempDir("pi-watch-missing-");
    const dir = writeWatchAutomation(root, "gone");
    const l = locate(root, "gone");
    rmSync(path.join(dir, "scripts", "watch.js"));
    expect(() => digestOf(l)).toThrow('on.watch.script: "scripts/watch.js" not found');
  });

  it("hashes an automation without a watch exactly as before", () => {
    const root = tempDir("pi-watch-nowatch-");
    const dir = path.join(root, "plain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "AUTOMATION.md"), "---\nname: plain\ndescription: d\non:\n  manual: true\n---\n\nB.\n");
    // The digest of a file with no scripts is the hash of the file and nothing else.
    const bytes = readFileSync(path.join(dir, "AUTOMATION.md"));
    expect(digestOf(locate(root, "plain"))).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  });
});

describe("the status of a watched automation", () => {
  async function statusOf(root: string, stateDir: string, name: string): Promise<Status> {
    armUserRoot(root, stateDir);
    const found = discover({ roots: [{ path: root, scope: "user", kind: "agents" }] });
    const statuses = await computeStatuses(found, { trust: new Trust(stateDir), config: DEFAULTS, stateDir, now: NOW });
    const s = statuses.find((x) => x.name === name);
    if (!s) throw new Error(`no status for ${name}`);
    return s;
  }

  it("is invalid when the watch script cannot run here, and says it is the watch", async () => {
    const root = tempDir("pi-watch-interp-");
    const dir = writeWatchAutomation(root, "strange");
    writeFileSync(
      path.join(dir, "AUTOMATION.md"),
      "---\nname: strange\ndescription: d\non:\n  watch:\n    script: scripts/watch.xyz\n    every: 5m\n---\n\nB.\n",
    );
    writeFileSync(path.join(dir, "scripts", "watch.xyz"), "?");
    const s = await statusOf(root, tempDir("pi-watch-interp-state-"), "strange");
    expect(s.state).toBe("invalid");
    expect(s.reason).toMatch(/^on\.watch: scripts\/watch\.xyz /);
  });

  it("carries the last check and when the next one is due", async () => {
    const root = tempDir("pi-watch-status-");
    writeWatchAutomation(root, "watched");
    const stateDir = tempDir("pi-watch-status-state-");
    const key = `user:${root}:watched`;

    const fresh = await statusOf(root, stateDir, "watched");
    expect(fresh.state).toBe("armed");
    expect(fresh.watch).toBeUndefined();
    expect(fresh.nextCheck).toBe(NOW.toISOString());

    const state = new State(stateDir);
    state.recordWatch(key, checked({ checkedAt: ago(60_000), said: "nothing new" }));
    state.save();

    const after = await statusOf(root, stateDir, "watched");
    expect(after.watch?.said).toBe("nothing new");
    expect(after.nextCheck).toBe(ago(-4 * 60_000));
  });
});

// ------------------------------------------------------------------------------ running it

/** A RunScript that records what it was asked to run and answers what it is told. */
function fakeScripts(answer: (cmd: ScriptCommand) => ScriptExecution) {
  const calls: ScriptCommand[] = [];
  const run: RunScript = async (cmd) => {
    calls.push(cmd);
    return answer(cmd);
  };
  return { run, calls };
}

const exited = (exit: number, stdout = "", stderr = ""): ScriptExecution => ({
  end: "exit",
  exit,
  stdout,
  stderr,
  outputBytes: Buffer.byteLength(stdout),
  truncated: false,
});

describe("runWatchScript", () => {
  it("runs the script in its folder with the watch's own environment and no credentials", async () => {
    const root = tempDir("pi-watch-env-");
    const dir = writeWatchAutomation(root, "env");
    const l = locate(root, "env");
    const scripts = fakeScripts(() => exited(0, "found 2"));
    process.env.WATCH_TEST_API_KEY = "secret";
    process.env.WATCH_TEST_PASSWORD = "secret";
    process.env.WATCH_TEST_CREDENTIALS = "secret";
    try {
      const check = await runWatchScript(l, { config: DEFAULTS, runScript: scripts.run, lastChecked: ago(300_000) });
      expect(check).toMatchObject({ exit: 0, stdout: "found 2" });
    } finally {
      delete process.env.WATCH_TEST_API_KEY;
      delete process.env.WATCH_TEST_PASSWORD;
      delete process.env.WATCH_TEST_CREDENTIALS;
    }
    const cmd = scripts.calls[0] as ScriptCommand;
    expect(cmd.cwd).toBe(dir);
    expect(cmd.env).toMatchObject({
      AUTOMATION_NAME: "env",
      AUTOMATION_KEY: l.key,
      AUTOMATION_TRIGGER: "watch",
      AUTOMATION_PHASE: "watch",
      AUTOMATION_LAST_CHECKED: ago(300_000),
    });
    // No run exists yet, so nothing about one is invented.
    expect(cmd.env).not.toHaveProperty("AUTOMATION_RUN_ID");
    expect(cmd.env).not.toHaveProperty("WATCH_TEST_API_KEY");
    expect(cmd.env).not.toHaveProperty("WATCH_TEST_PASSWORD");
    expect(cmd.env).not.toHaveProperty("WATCH_TEST_CREDENTIALS");
    expect(cmd.timeoutMs).toBe(60_000);
  });

  it("never lets a watch script run past two minutes, whatever hookTimeout says", async () => {
    const root = tempDir("pi-watch-cap-");
    writeWatchAutomation(root, "cap");
    const l = locate(root, "cap");
    const scripts = fakeScripts(() => exited(3));
    await runWatchScript(l, { config: { ...DEFAULTS, hookTimeout: "10m" }, runScript: scripts.run });
    await runWatchScript(l, { config: { ...DEFAULTS, hookTimeout: "30s" }, runScript: scripts.run });
    expect(scripts.calls.map((c) => c.timeoutMs)).toEqual([WATCH_TIMEOUT_MAX_MS, 30_000]);
  });

  it("reads a script killed by a signal as no answer, never as found work", async () => {
    const root = tempDir("pi-watch-signal-");
    writeWatchAutomation(root, "signal");
    const killed = fakeScripts(() => ({ ...exited(0), signal: "SIGKILL" }));
    const check = await runWatchScript(locate(root, "signal"), { config: DEFAULTS, runScript: killed.run });
    expect(check.exit).toBeUndefined();
    expect(check.problem).toBe("scripts/watch.js was killed by SIGKILL");
    expect(decideWatch(undefined, check, NOW).fire).toBe(false);
  });

  it.skipIf(process.platform === "win32")("hears the signal from a real child that was killed", async () => {
    const root = tempDir("pi-watch-signal-real-");
    writeWatchAutomation(root, "killed", "", { "scripts/watch.js": "console.log('half');\nprocess.kill(process.pid, 'SIGKILL');\n" });
    const check = await runWatchScript(locate(root, "killed"), { config: DEFAULTS, runScript: runLocalScript });
    expect(check.problem).toBe("scripts/watch.js was killed by SIGKILL");
  });

  it("reports a host with no executor as a problem, never as nothing to do", async () => {
    const root = tempDir("pi-watch-noexec-");
    writeWatchAutomation(root, "noexec");
    const check = await runWatchScript(locate(root, "noexec"), { config: DEFAULTS });
    expect(check.exit).toBeUndefined();
    expect(check.problem).toContain("this host composed no script executor");
  });

  it("turns a timeout and a failed start into problems", async () => {
    const root = tempDir("pi-watch-ends-");
    writeWatchAutomation(root, "ends");
    const l = locate(root, "ends");
    const timeout = fakeScripts(() => ({ end: "timeout", stdout: "half", stderr: "", outputBytes: 4, truncated: false }));
    expect((await runWatchScript(l, { config: DEFAULTS, runScript: timeout.run })).problem).toBe(
      "scripts/watch.js timed out after 1m",
    );
    const nostart = fakeScripts(() => ({ end: "start-failed", message: "ENOENT", stdout: "", stderr: "", outputBytes: 0, truncated: false }));
    expect((await runWatchScript(l, { config: DEFAULTS, runScript: nostart.run })).problem).toBe(
      "scripts/watch.js could not start — ENOENT",
    );
  });

  it("runs a real script", async () => {
    const root = tempDir("pi-watch-real-");
    writeWatchAutomation(root, "real", "", {
      "scripts/watch.js": "console.log(process.env.AUTOMATION_PHASE + ' ' + process.env.AUTOMATION_NAME); process.exit(3);\n",
    });
    const check = await runWatchScript(locate(root, "real"), { config: DEFAULTS, runScript: runLocalScript });
    expect(check.exit).toBe(3);
    expect(check.stdout.trim()).toBe("watch real");
  });
});

describe("the tick runs due watches", () => {
  function watched(root: string, name = "w", over: Partial<Status> = {}): Status {
    return {
      key: `user:${root}:${name}`,
      name,
      scope: "user",
      root: { path: root, scope: "user", kind: "agents" },
      dir: path.join(root, name),
      state: "armed",
      effectiveTimeoutMs: 600_000,
      staggerSec: 0,
      automation: {
        name,
        description: "d",
        enabled: true,
        on: { manual: false, watch: FIVE },
        hooks: { pre: [], post: [] },
        body: "b",
      },
      ...over,
    };
  }

  function deps(stateDir: string, statuses: Status[], answer: () => ScriptExecution, now = NOW) {
    const spawned: string[][] = [];
    const scripts = fakeScripts(answer);
    const d: TickDeps = {
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      now,
      spawnFire: async (args) => {
        spawned.push([...args]);
        return { ok: true, pid: 4242 };
      },
      statuses,
      runScript: scripts.run,
    };
    return { d, spawned, calls: scripts.calls };
  }

  it("starts a run with --watch when the script finds something, and records it first", async () => {
    const stateDir = tempDir("pi-watch-tick-");
    const s = watched(tempDir("pi-watch-tick-root-"));
    const { d, spawned } = deps(stateDir, [s], () => exited(0, "PR 12"));
    // What is on disk at the moment of the spawn, not after the tick's own save at the end.
    let atSpawn: WatchState | undefined;
    const spawn = d.spawnFire;
    d.spawnFire = async (args) => {
      atSpawn = readWatchState(stateDir, s.key);
      return spawn(args);
    };

    const summary = await tick(d);

    expect(summary.checked).toEqual([s.key]);
    expect(summary.fired).toEqual([s.key]);
    expect(spawned).toEqual([[s.key, "--watch"]]);
    expect(atSpawn).toMatchObject({ exit: 0, firedAt: NOW.toISOString(), firedFor: fingerprint("PR 12") });
    const saved = readWatchState(stateDir, s.key);
    expect(saved).toMatchObject({ exit: 0, firedAt: NOW.toISOString(), firedFor: fingerprint("PR 12") });
  });

  it("keeps what another process saved while the scripts ran", async () => {
    const stateDir = tempDir("pi-watch-merge-");
    const s = watched(tempDir("pi-watch-merge-root-"));
    const repo = tempDir("pi-watch-merge-repo-");
    const { d } = deps(stateDir, [s], () => exited(3, "", "nothing"));
    d.runScript = async () => {
      // `arm` in another process registers a root while the script is running.
      new State(stateDir).update((other) => other.registerRoot(repo));
      return exited(3, "", "nothing");
    };

    await tick(d);

    expect(new State(stateDir).roots).toEqual([path.resolve(repo)]);
    expect(readWatchState(stateDir, s.key)).toMatchObject({ exit: 3 });
  });

  it("tells the script when the last check that answered began, not the last one that ran", async () => {
    const stateDir = tempDir("pi-watch-since-");
    const s = watched(tempDir("pi-watch-since-root-"));
    const before = new State(stateDir);
    before.recordWatch(s.key, { checkedAt: ago(5 * 60_000), problem: "scripts/watch.js timed out after 1m", durationMs: 60_000, answeredAt: ago(10 * 60_000) });
    before.save();
    const { d, calls } = deps(stateDir, [s], () => exited(3));
    await tick(d);
    expect(calls[0]?.env.AUTOMATION_LAST_CHECKED).toBe(ago(10 * 60_000));
  });

  it("does not check again inside its interval, and does not re-fire the same finding after it", async () => {
    const stateDir = tempDir("pi-watch-again-");
    const s = watched(tempDir("pi-watch-again-root-"));
    await tick(deps(stateDir, [s], () => exited(0, "PR 12")).d);

    const soon = deps(stateDir, [s], () => exited(0, "PR 12"), new Date(NOW.getTime() + 2 * 60_000));
    await tick(soon.d);
    expect(soon.calls).toHaveLength(0);

    const later = deps(stateDir, [s], () => exited(0, "PR 12"), new Date(NOW.getTime() + 5 * 60_000));
    const summary = await tick(later.d);
    expect(later.calls).toHaveLength(1);
    expect(summary.checked).toEqual([s.key]);
    expect(later.spawned).toHaveLength(0);
  });

  it("starts nothing when the script finds nothing", async () => {
    const stateDir = tempDir("pi-watch-none-");
    const s = watched(tempDir("pi-watch-none-root-"));
    const { d, spawned } = deps(stateDir, [s], () => exited(3, "", "nothing is waiting on you"));
    const summary = await tick(d);
    expect(summary.checked).toEqual([s.key]);
    expect(spawned).toHaveLength(0);
    expect(readWatchState(stateDir, s.key)).toMatchObject({ exit: 3, said: "nothing is waiting on you" });
  });

  it("does not look while the automation is running", async () => {
    const stateDir = tempDir("pi-watch-busy-");
    const s = watched(tempDir("pi-watch-busy-root-"));
    const lock = acquireRunLock(
      stateDir,
      runLockInfo({ key: s.key, runId: "r1", timeoutMs: 600_000, postHooks: 0, trigger: "watch", now: NOW }),
    );
    expect(lock.ok).toBe(true);
    const { d, calls } = deps(stateDir, [s], () => exited(0, "x"));
    const summary = await tick(d);
    expect(calls).toHaveLength(0);
    expect(summary.checked).toEqual([]);
  });

  it("checks only armed automations", async () => {
    const stateDir = tempDir("pi-watch-armed-");
    const root = tempDir("pi-watch-armed-root-");
    const statuses = [
      watched(root, "off", { state: "off", reason: "not armed" }),
      watched(root, "disabled", { state: "disabled" }),
      watched(root, "invalid", { state: "invalid" }),
    ];
    const { d, calls } = deps(stateDir, statuses, () => exited(0, "x"));
    await tick(d);
    expect(calls).toHaveLength(0);
  });

  it("records a missing executor instead of reading it as nothing to do", async () => {
    const stateDir = tempDir("pi-watch-noexec-tick-");
    const s = watched(tempDir("pi-watch-noexec-tick-root-"));
    mkdirSync(path.join(s.dir, "scripts"), { recursive: true });
    writeFileSync(path.join(s.dir, "scripts", "watch.js"), "");
    const { d, spawned } = deps(stateDir, [s], () => exited(0, "x"));
    delete d.runScript;
    await tick(d);
    expect(spawned).toHaveLength(0);
    expect(readWatchState(stateDir, s.key)?.problem).toContain("this host composed no script executor");
  });

  it("writes one failed record, triggered by the watch, when the worker cannot start", async () => {
    const stateDir = tempDir("pi-watch-nostart-");
    const s = watched(tempDir("pi-watch-nostart-root-"));
    const { d } = deps(stateDir, [s], () => exited(0, "x"));
    d.spawnFire = async () => ({ ok: false, reason: "no worker" });
    const summary = await tick(d);
    expect(summary.failed).toEqual([s.key]);
    const recs = readRecords(stateDir, s.key, 5);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ trigger: "watch", outcome: "failed", error: { kind: "host" } });
  });

  it("leaves an automation alone when its schedule fired in the same tick", async () => {
    const stateDir = tempDir("pi-watch-both-");
    const root = tempDir("pi-watch-both-root-");
    const s = watched(root);
    (s.automation as NonNullable<Status["automation"]>).on.schedule = { cron: "0 * * * *", catchUp: "skip", timezone: "UTC" };
    const { d, spawned, calls } = deps(stateDir, [s], () => exited(0, "x"), new Date("2026-10-07T12:00:30.000Z"));
    d.state.lastTickAt = "2026-10-07T11:59:00.000Z";
    await tick(d);
    expect(spawned).toEqual([[s.key, "--scheduled-for", "2026-10-07T12:00:00.000Z"]]);
    expect(calls).toHaveLength(0);
  });
});

describe("watch, check and the consent preview", () => {
  async function refreshed(root: string, stateDir: string): Promise<Refreshed> {
    armUserRoot(root, stateDir);
    const found = discover({ roots: [{ path: root, scope: "user", kind: "agents" }] });
    const statuses = await computeStatuses(found, { trust: new Trust(stateDir), config: DEFAULTS, stateDir, now: NOW });
    return { statuses, byKey: new Map(located(found).map((l) => [l.key, l])), projectRoots: [] };
  }

  function commandDeps(stateDir: string, runScript?: RunScript): CommandDeps {
    return {
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      now: () => NOW,
      home: path.resolve("/home/nobody"),
      cwd: stateDir,
      spawnFire: () => {
        throw new Error("watch commands never start a run");
      },
      ...(runScript ? { runScript } : {}),
    };
  }

  it("lists every watch and says first that nothing runs them without the watcher", async () => {
    const root = tempDir("pi-watch-cmd-list-");
    writeWatchAutomation(root, "listed");
    const stateDir = tempDir("pi-watch-cmd-list-state-");
    const out = await handleWatch(commandDeps(stateDir), await refreshed(root, stateDir), undefined);
    expect(out.lines[0]).toContain("watcher off — nothing runs these checks until you start it");
    const text = out.lines.join("\n");
    expect(text).toContain("listed  armed");
    expect(text).toContain("watch         scripts/watch.js every 5m");
    expect(text).toContain("last check    never");
    expect(text).toContain("next check    at the next tick");
  });

  it("runs one check now without starting or recording anything", async () => {
    const root = tempDir("pi-watch-cmd-dry-");
    writeWatchAutomation(root, "dry");
    const stateDir = tempDir("pi-watch-cmd-dry-state-");
    const scripts = fakeScripts(() => exited(0, "PR 12: 2 new comments\nPR 14: 1 new comment"));
    const r = await refreshed(root, stateDir);
    const out = await handleWatch(commandDeps(stateDir, scripts.run), r, "dry");

    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toContain("nothing was started or recorded");
    expect(out.lines).toContain("  result        exit 0");
    expect(out.lines).toContain("  a tick would  start a run: it found something new");
    expect(out.lines).toContain("    PR 14: 1 new comment");
    expect(existsSync(path.join(stateDir, "state.json"))).toBe(false);
  });

  it("says when a dry check would start nothing, and why", async () => {
    const root = tempDir("pi-watch-cmd-nothing-");
    writeWatchAutomation(root, "quiet");
    const stateDir = tempDir("pi-watch-cmd-nothing-state-");
    const scripts = fakeScripts(() => exited(3, "", "nothing is waiting on you"));
    const r = await refreshed(root, stateDir);
    const out = await handleWatch(commandDeps(stateDir, scripts.run), r, "quiet");
    expect(out.exitCode).toBe(10);
    expect(out.lines).toContain("  a tick would  not start a run: nothing to do (exit 3)");
    expect(out.lines).toContain("    nothing is waiting on you");
  });

  it("refuses an automation without a watch, by name", async () => {
    const root = tempDir("pi-watch-cmd-none-");
    const dir = path.join(root, "plain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "AUTOMATION.md"), "---\nname: plain\ndescription: d\non:\n  manual: true\n---\n\nB.\n");
    const stateDir = tempDir("pi-watch-cmd-none-state-");
    const out = await handleWatch(commandDeps(stateDir), await refreshed(root, stateDir), "plain");
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toBe("plain: has no watch — add on.watch with script and every");
  });

  it("does not run a repository's watch script before it is armed, even while it is disabled", async () => {
    const root = tempDir("pi-watch-cmd-repo-");
    const marker = path.join(root, "ran.txt");
    writeWatchAutomation(root, "unarmed", "enabled: false\n", {
      "scripts/watch.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    });
    const stateDir = tempDir("pi-watch-cmd-repo-state-");
    const found = discover({ roots: [{ path: root, scope: "repository", kind: "agents" }] });
    const statuses = await computeStatuses(found, { trust: new Trust(stateDir), config: DEFAULTS, stateDir, now: NOW });
    // `disabled` is decided before consent, so the state alone says nothing about arming.
    expect(statuses[0]?.state).toBe("disabled");

    const r: Refreshed = { statuses, byKey: new Map(located(found).map((l) => [l.key, l])), projectRoots: [] };
    const out = await handleWatch(commandDeps(stateDir, runLocalScript), r, "unarmed");

    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toContain("its watch script runs only once it is armed");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not run a user automation's watch script before it is armed", async () => {
    const root = tempDir("pi-watch-cmd-user-");
    const marker = path.join(root, "ran.txt");
    writeWatchAutomation(root, "unarmed", "", {
      "scripts/watch.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    });
    const stateDir = tempDir("pi-watch-cmd-user-state-");
    const found = discover({ roots: [{ path: root, scope: "user", kind: "agents" }] });
    const statuses = await computeStatuses(found, { trust: new Trust(stateDir), config: DEFAULTS, stateDir, now: NOW });
    expect(statuses[0]?.state).toBe("off");

    const r: Refreshed = { statuses, byKey: new Map(located(found).map((l) => [l.key, l])), projectRoots: [] };
    const out = await handleWatch(commandDeps(stateDir, runLocalScript), r, "unarmed");

    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toBe("unarmed: not armed — /automations arm unarmed — its watch script runs only once it is armed");
    expect(existsSync(marker)).toBe(false);
  });

  it("arms through a fresh read, so checks made while its dialog was open survive", () => {
    const repo = tempDir("pi-watch-arm-repo-");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const root = path.join(repo, ".agents", "automations");
    writeWatchAutomation(root, "consented");
    const stateDir = tempDir("pi-watch-arm-state-");
    // pi loads state when the command starts, before the consent dialog opens.
    const d = commandDeps(stateDir);
    const l = located(discover({ roots: [{ path: root, scope: "repository", kind: "agents" }] }))[0];
    if (!l) throw new Error("fixture did not parse");
    const tickMeanwhile = new State(stateDir);
    tickMeanwhile.recordWatch(l.key, { checkedAt: NOW.toISOString(), exit: 0, durationMs: 1, firedFor: "sha256:x" });
    tickMeanwhile.save();

    expect(applyArm(d, l)).toEqual(["consented armed"]);

    expect(readWatchState(stateDir, l.key)?.firedFor).toBe("sha256:x");
    expect(new State(stateDir).roots).toEqual([path.resolve(repo)]);
  });

  it("shows the watch in check and in the consent preview, with the command it runs", async () => {
    const root = tempDir("pi-watch-cmd-check-");
    writeWatchAutomation(root, "shown");
    const stateDir = tempDir("pi-watch-cmd-check-state-");
    const r = await refreshed(root, stateDir);
    const check = (await handleCheck(commandDeps(stateDir), r, "shown")).lines.join("\n");
    expect(check).toContain("watch         scripts/watch.js every 5m");
    expect(check).toMatch(/interpreter {3}scripts\/watch\.js → .*node/);

    const s = r.statuses[0] as Status;
    const preview = consentPreview(s, r.byKey.get(s.key) as Located, commandDeps(stateDir)).join("\n");
    expect(preview).toMatch(/watch {9}scripts\/watch\.js every 5m {8}→ .*node/);
  });

  it("puts the interval in the listing and the next check where the next fire would be", async () => {
    const root = tempDir("pi-watch-cmd-listing-");
    writeWatchAutomation(root, "row");
    const stateDir = tempDir("pi-watch-cmd-listing-state-");
    const r = await refreshed(root, stateDir);
    const row = listingModel(r.statuses, { home: path.resolve("/home/nobody"), projectRoots: [], now: NOW }).groups
      .flatMap((g) => g.rows)
      .find((x) => x.name === "row");
    expect(row?.schedule).toBe("watch 5m");
    expect(row?.next).toBe("check now");

  });
});

describe("composing writes on.watch into the YAML", () => {
  const before = [
    "---",
    "name: edit-me",
    "description: d",
    "on:",
    "  manual: true # keep this comment",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");

  it("adds a watch, keeping everything else as it was written", () => {
    const fields = fieldsFromAutomation(parseAutomation(before, "edit-me"));
    fields.on.watch = { script: "scripts/watch.js", every: "5m" };
    const after = composeAutomationText(before, "edit-me", fields);
    expect(after).toContain("manual: true # keep this comment");
    expect(after).toContain("  watch:\n    script: scripts/watch.js\n    every: 5m");
    expect(parseAutomation(after, "edit-me").on.watch).toEqual({ script: "scripts/watch.js", every: "5m" });
  });

  it("changes the interval in place, and removes the watch", () => {
    const fields = fieldsFromAutomation(parseAutomation(before, "edit-me"));
    fields.on.watch = { script: "scripts/watch.js", every: "5m" };
    const watchedText = composeAutomationText(before, "edit-me", fields);

    const longer = fieldsFromAutomation(parseAutomation(watchedText, "edit-me"));
    (longer.on.watch as Watch).every = "15m";
    expect(composeAutomationText(watchedText, "edit-me", longer)).toContain("    every: 15m");

    const removed = fieldsFromAutomation(parseAutomation(watchedText, "edit-me"));
    delete removed.on.watch;
    const plain = composeAutomationText(watchedText, "edit-me", removed);
    expect(plain).not.toContain("watch");
    expect(parseAutomation(plain, "edit-me").on).toEqual({ manual: true });
  });
});

describe("a real tick runs a real watch and starts a real run", () => {
  it("records the run as started by the watch", () => {
    const iso = isolatedHome("pi-watch-e2e-");
    const dir = automationIn(
      iso,
      "watched",
      "on:\n  watch:\n    script: look.js\n    every: 5m\nhooks:\n  pre:\n    - script: stop.js\n",
      {
        // The watch says what it saw and where it was, then finds something.
        "look.js":
          'const fs=require("node:fs"),p=require("node:path");\n' +
          'fs.writeFileSync(p.join(process.env.AUTOMATION_DIR,"watch-marker.json"),JSON.stringify({phase:process.env.AUTOMATION_PHASE,trigger:process.env.AUTOMATION_TRIGGER,key:process.env.AUTOMATION_KEY}));\n' +
          'console.log("one new comment");\n',
        // The run stops at its pre hook, so no model is ever asked anything.
        "stop.js": "process.exit(3);\n",
      },
    );
    proveIsolated(iso);
    const key = `user:${iso.roots}:watched`;

    const deny = path.join(REPO, "test", "fixtures", "portable-deny-sdk.mjs");
    const host = path.join(REPO, "test", "fixtures", "default-host-loader.mjs");
    let out: string;
    try {
      out = execFileSync(
        process.execPath,
        [path.join(REPO, "test", "fixtures", "isolated-tick-host.mjs"), REPO, "root", key],
        {
          encoding: "utf8",
          cwd: iso.cwd,
          windowsHide: true,
          timeout: 120_000,
          env: {
            ...iso.env,
            NODE_OPTIONS: `--import ${pathToFileURL(deny).href} --import ${pathToFileURL(host).href}`,
            PORTABLE_DENIAL_RECEIPT: path.join(iso.home, "denial-receipt.txt"),
            DEFAULT_HOST_PKG: REPO,
            WORKER_EXIT_RECEIPT: path.join(iso.home, "worker-exit.txt"),
          },
        },
      );
    } catch (e) {
      throw new Error(`the tick host did not complete; its fixture is kept at ${keepTempDir(iso.home)} — ${(e as Error).message}`);
    }

    const report = JSON.parse(out.trim()) as {
      error: string | null;
      stateDir: string;
      summary: { fired: string[]; checked: string[] } | null;
      worker: { outcome: string; reason: string | null; trigger: string | null } | null;
      workerGone: boolean | null;
    };
    if (report.workerGone !== true) keepTempDir(iso.home);

    expect(report.error).toBeNull();
    expect(report.summary?.checked).toEqual([key]);
    expect(report.summary?.fired).toEqual([key]);

    const marker = JSON.parse(readFileSync(path.join(dir, "watch-marker.json"), "utf8")) as Record<string, string>;
    expect(marker).toEqual({ phase: "watch", trigger: "watch", key });

    expect(report.worker?.trigger).toBe("watch");
    expect(report.worker?.outcome).toBe("skipped");
    expect(readWatchState(report.stateDir, key)).toMatchObject({ exit: 0, said: "one new comment" });
  }, 180_000);
});
