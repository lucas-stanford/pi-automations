// The one approved behaviour change: a requested git worktree that cannot be created REFUSES the
// run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { digestOf } from "../src/digest.js";
import { discover } from "../src/discover.js";
import { readRunLock } from "../src/locks.js";
import { readRecords } from "../src/records.js";
import { runLocalScript } from "../src/providers/scripts.js";
import { State } from "../src/state.js";
import { interpreterMap } from "../src/status.js";
import { Trust } from "../src/trust.js";
import { fire, workspaceRefusalMessage } from "../src/run.js";
import { clipLine } from "../src/summary.js";
import { summaryLine } from "../src/summary.js";
import type { Located, RunRecord } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";
import { fakeSession, fireRuntimeFrom, HOST_NOW } from "./helpers/isolated-host.js";

/** What the sink was asked to deliver, and what the world looked like at that moment. */
const NOTIFY = {
  calls: [] as Array<{ record: RunRecord; recordsOnDisk: number; eventsSoFar: number }>,
  stateDir: "",
  eventCount: () => 0,
};

const recordingNotify = async (rec: RunRecord): Promise<void> => {
  const onDisk = NOTIFY.stateDir ? readRecords(NOTIFY.stateDir, rec.key, 100).length : -1;
  NOTIFY.calls.push({ record: rec, recordsOnDisk: onDisk, eventsSoFar: NOTIFY.eventCount() });
};

afterAll(cleanupTempDirs);

beforeEach(() => {
  NOTIFY.calls.length = 0;
  NOTIFY.stateDir = "";
  NOTIFY.eventCount = () => 0;
});

/** `git` is real here, and deliberately so: the refusal is about what git actually does. */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  located: Located;
  stateDir: string;
  repo: string;
}

/** A repository-scope automation in a real git repository, opted into worktree isolation. */
function fixture(opts: { name?: string; worktree?: boolean; scripts?: Record<string, string>; hooks?: string; cron?: string } = {}): Fixture {
  const name = opts.name ?? "isolated-one";
  const repo = tempDir("pi-wt-repo-");
  const dir = path.join(repo, ".agents", "automations", name);
  mkdirSync(dir, { recursive: true });
  const trigger = opts.cron
    ? `on:\n  schedule:\n    cron: "${opts.cron}"\n    timezone: UTC\n`
    : "on:\n  manual: true\n";
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: ${name}\ndescription: A test automation.\n${trigger}${opts.hooks ?? ""}---\n\nDo the thing.\n`,
  );
  for (const [rel, body] of Object.entries(opts.scripts ?? {})) {
    writeFileSync(path.join(dir, rel), body);
  }

  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, stdio: "ignore", windowsHide: true });

  const roots = [{ path: path.join(repo, ".agents", "automations"), scope: "repository" as const, kind: "agents" as const }];
  const found = discover({ roots, cwd: repo });
  const first = found[0];
  if (!first?.ok) throw new Error(`fixture did not parse: ${first && !first.ok ? first.error : "not found"}`);

  // Repository automations are off until consent is given, and an unarmed one is SKIPPED long
  // before a workspace is prepared. Arming here is what puts the run on the path under test.
  const stateDir = tempDir("pi-wt-state-");
  const trust = new Trust(stateDir);
  trust.arm(
    first.located,
    digestOf(first.located),
    interpreterMap(first.located),
    HOST_NOW,
    30 * 24 * 60 * 60 * 1000,
  );
  trust.save();

  return { located: first.located, stateDir, repo };
}

function deps(f: Fixture, over: Record<string, unknown> = {}) {
  const { runtime, rest } = fireRuntimeFrom(over);
  return {
    // notifyOnFailed stays TRUE.
    config: { ...DEFAULTS, notifyOnFailed: true, worktree: { [f.located.key]: true } },
    stateDir: f.stateDir,
    trust: new Trust(f.stateDir),
    state: new State(f.stateDir),
    runtime,
    runScript: runLocalScript,
    notify: recordingNotify,
    hookTimeoutMs: 4000,
    ...rest,
  } as Parameters<typeof fire>[2];
}

/** Break the repository so `git worktree add` cannot succeed. */
function breakRepository(repo: string): void {
  writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/nowhere-at-all\n");
}

const MANUAL = { trigger: "manual" as const, now: () => HOST_NOW };
const describeGit = gitAvailable() ? describe : describe.skip;

describeGit("a requested worktree that cannot be created refuses the run", () => {
  it("writes exactly one record, failed / host, and never falls back to the checkout", async () => {
    const f = fixture();
    breakRepository(f.repo);
    const session = fakeSession();

    const rec = await fire(f.located, MANUAL, deps(f, { startSession: session.starter }));

    expect(rec.outcome).toBe("failed");
    expect(rec.error?.kind).toBe("host");

    const written = readRecords(f.stateDir, f.located.key, 100);
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual(rec);

    // Nothing ran. Not the body, not a hook, not a flow.
    expect(session.opened).toBe(0);
    expect(rec.hooks).toBeUndefined();
    expect(rec.flow).toBeUndefined();
    expect(rec.output).toBeUndefined();
  });

  it("names workspace preparation, the repository, the intended workspace and a remediation", async () => {
    const f = fixture();
    breakRepository(f.repo);

    const rec = await fire(f.located, MANUAL, deps(f));
    const message = rec.error?.message ?? "";

    expect(message.startsWith("workspace:")).toBe(true);
    expect(message).toContain(f.repo);
    expect(message).toContain("pi-automations-wt-");
    expect(message).toContain("config.worktree");
    // The key is quoted, so a path with backslashes is unambiguous in the message.
    expect(message).toContain(JSON.stringify(f.located.key));
    // It reports git's own diagnosis, not its preamble — now after the cause and the remediation,
    // so a clipped surface loses the path rather than what went wrong.
    expect(message).toMatch(/: (fatal|error):/i);
    // The cause leads, so it is what a narrow surface keeps.
    expect(message.indexOf("config.worktree")).toBeLessThan(message.indexOf(f.repo));
    // One line, in the package's existing error shape.
    expect(message).not.toContain("\n");
  });

  it("keeps a path collision, a missing git and a repository failure distinguishable", () => {
    // The excerpt is the whole point of including git's own words. Asserted on the message builder,
    // so the three causes can be compared side by side without three broken repositories.
    const common = { key: "repository:/r/.agents/automations:x", repository: "/r" };
    const collision = workspaceRefusalMessage({
      ...common,
      intended: "/tmp/w",
      detail: "fatal: '/tmp/w' already exists",
    });
    const missing = workspaceRefusalMessage({ ...common, detail: "spawnSync git ENOENT" });
    const broken = workspaceRefusalMessage({
      ...common,
      intended: "/tmp/w",
      detail: "fatal: not a valid object name: 'HEAD'",
    });

    expect(collision).toContain("already exists");
    expect(missing).toContain("ENOENT");
    expect(broken).toContain("not a valid object name");
    expect(new Set([collision, missing, broken]).size).toBe(3);
  });

  it("keeps the cause readable at 80 and adds the remediation at 120", () => {
    // Long paths on purpose: with a short one every ordering fits at both widths and the
    // measurement says nothing.
    const intended =
      "/var/folders/_9/j7x2k1qd3p16y8cvn4bqzt0r0000gn/T/pi-automations-worktree-a1b2c3d4/nightly";
    const repo = "/Users/someone/dev/a-repository-with-a-genuinely-long-name-for-measuring";
    const message = workspaceRefusalMessage({
      key: `repository:${repo}/.agents/automations:nightly`,
      repository: repo,
      intended,
      detail: `fatal: destination path '${intended}' already exists and is not an empty directory`,
    });

    expect(clipLine(message, 80)).toContain("the worktree path already exists");
    const at120 = clipLine(message, 120);
    expect(at120).toContain("the worktree path already exists");
    expect(at120).toContain("remove it from config.worktree");
    // The full bounded detail is still on the record for anyone who opens it.
    expect(message).toContain(intended);
    expect(message).toContain("is not an empty directory");
  });

  it("keeps an unrecognised git line's words, not its path", () => {
    const repo = "/Users/someone/dev/a-repository-with-a-genuinely-long-name-for-measuring";
    const message = workspaceRefusalMessage({
      key: `repository:${repo}/.agents/automations:nightly`,
      repository: repo,
      intended: `${repo}/../wt/nightly`,
      // Nothing the classifier knows, and git puts the path before the words — which is the shape
      // that clips down to a quoted path every failure shares.
      detail: `fatal: '${repo}/.git/config' could not be read by the credential helper`,
    });

    const at80 = clipLine(message, 80);
    // The words survive because the path inside them does not.
    expect(at80).toContain("could not be read");
    expect(at80).not.toContain("a-repository-with-a-genuinely-long-name");
    // And the whole line is still there to read on the record.
    expect(message).toContain("by the credential helper");
    expect(message).toContain(repo);
  });

  it("bounds the excerpt rather than dumping the command or unbounded stderr", () => {
    const message = workspaceRefusalMessage({
      key: "repository:/r/.agents/automations:x",
      repository: "/r",
      intended: "/tmp/w",
      detail: "x".repeat(4000),
    });
    // `clipLine`'s own bound is 160 + the ellipsis; the message never carries 4,000 characters.
    expect(message.length).toBeLessThan(700);
  });

  it("persists the record BEFORE it emits completion or attempts the notification", async () => {
    const f = fixture();
    breakRepository(f.repo);
    const events: Array<{ event: string; recordsOnDisk: number }> = [];
    NOTIFY.stateDir = f.stateDir;
    NOTIFY.eventCount = () => events.length;

    const rec = await fire(
      f.located,
      {
        ...MANUAL,
        // Observed from INSIDE the callback: "persisted before emitted" is only visible at the
        // instant the event fires. Reading the state directory afterwards cannot tell the two
        // orderings apart, because by then both have happened.
        emit: (e) => events.push({ event: e.event, recordsOnDisk: readRecords(f.stateDir, f.located.key, 100).length }),
      },
      deps(f),
    );

    const completion = events.find((e) => e.event === "record");
    expect(completion).toBeDefined();
    expect(completion?.recordsOnDisk).toBe(1);

    // Exactly one notification, for this record, after the event.
    expect(NOTIFY.calls).toHaveLength(1);
    expect(NOTIFY.calls[0]?.record.id).toBe(rec.id);
    expect(NOTIFY.calls[0]?.recordsOnDisk).toBe(1);
    expect(NOTIFY.calls[0]?.eventsSoFar).toBeGreaterThan(0);

    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("record");
    // Nothing that means "a run is under way" was emitted.
    expect(kinds).not.toContain("body-start");
    expect(kinds).not.toContain("session");
    expect(kinds).not.toContain("flow");
    expect(kinds).not.toContain("hook-start");
  });

  it("releases the run lock exactly once, leaving nothing for a sweeper to invent", async () => {
    const f = fixture();
    breakRepository(f.repo);

    await fire(f.located, MANUAL, deps(f));

    expect(readRunLock(f.stateDir, f.located.key)).toBeUndefined();

    // A second run finds no held lock, so the release really happened — and refuses again.
    const again = await fire(f.located, MANUAL, deps(f));
    expect(again.outcome).toBe("failed");
    expect(again.reason).toBeUndefined();
    expect(readRecords(f.stateDir, f.located.key, 100)).toHaveLength(2);
  });

  it("leaves the dispatcher's claim state exactly as it found it", async () => {
    // A cron schedule on purpose: `claimCoveredInstant` returns early when an automation has none,
    // so a manual-only fixture could never detect a refusal that claimed.
    const f = fixture({ name: "scheduled-one", cron: "0 7 * * *" });
    breakRepository(f.repo);
    const state = new State(f.stateDir);

    // Something already claimed this instant, the way a dispatcher would.
    state.claimPersisted(f.located.key, "2026-09-16T07:00:00.000Z");
    const before = readStateFile(f.stateDir);

    await fire(
      f.located,
      { trigger: "schedule", scheduledFor: "2026-09-17T07:00:00.000Z", now: () => HOST_NOW },
      deps(f, { state }),
    );

    expect(readStateFile(f.stateDir)).toEqual(before);
  });

  it("does not start pre hooks", async () => {
    const marker = tempDir("pi-wt-marker-");
    const f = fixture({
      name: "hooked-one",
      hooks: "hooks:\n  pre:\n    - script: touch.js\n",
      scripts: {
        "touch.js": `require("node:fs").writeFileSync(${JSON.stringify(path.join(marker, "ran"))}, "1");\n`,
      },
    });
    breakRepository(f.repo);

    const rec = await fire(f.located, MANUAL, deps(f));

    expect(rec.outcome).toBe("failed");
    expect(existsSync(path.join(marker, "ran"))).toBe(false);
  });

  it("surfaces through the existing summary line", async () => {
    const f = fixture();
    breakRepository(f.repo);

    const rec = await fire(f.located, MANUAL, deps(f));

    const line = summaryLine(rec, 120);
    expect(line.startsWith("host: workspace:")).toBe(true);
    expect(line).not.toContain("\n");
  });

  it("still runs in the checkout when no worktree was requested", async () => {
    // The refusal must not have turned isolation on for everybody.
    const f = fixture({ name: "ordinary-one" });
    breakRepository(f.repo);
    const session = fakeSession();

    const rec = await fire(
      f.located,
      MANUAL,
      deps(f, { config: { ...DEFAULTS, notifyOnFailed: true, worktree: {} }, startSession: session.starter }),
    );

    expect(rec.outcome).toBe("ok");
    expect(session.opened).toBe(1);
    expect(NOTIFY.calls).toHaveLength(0);
  });

  it("still succeeds when the worktree CAN be created", async () => {
    const f = fixture({ name: "healthy-one" });
    const session = fakeSession();

    const rec = await fire(f.located, MANUAL, deps(f, { startSession: session.starter }));

    expect(rec.outcome).toBe("ok");
    expect(session.opened).toBe(1);
    expect(NOTIFY.calls).toHaveLength(0);
  });
});

/** The state file, read directly, for the claim-state comparison. */
function readStateFile(stateDir: string): unknown {
  const file = path.join(stateDir, "state.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}
