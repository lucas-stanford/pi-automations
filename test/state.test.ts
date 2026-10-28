import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS, ms } from "../src/config.js";
import { digestOf, fileHashesOf } from "../src/digest.js";
import { discover, located } from "../src/discover.js";
import {
  acquireRunLock,
  acquireTickLock,
  isAlive,
  isRunLockStale,
  readRunLock,
  runLockInfo,
  sweepStaleRunLocks,
} from "../src/locks.js";
import {
  appendRecord,
  lastRecord,
  newRunId,
  readRecords,
  rotateIfNeeded,
} from "../src/records.js";
import { State } from "../src/state.js";
import { computeStatuses, decideState, interpreterMap } from "../src/status.js";
import { Trust } from "../src/trust.js";
import type { Discovered, Located, RunRecord } from "../src/types.js";
import { resolveModel, type ModelRuntimeLike } from "../src/model.js";
import type { ModelResolver } from "../src/core/contracts.js";
// @ts-expect-error - plain JS fixture builder, deliberately untyped
import { buildFixtures } from "./helpers/fixtures.mjs";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";
import { armUserRoot } from "./helpers/arm.js";

afterAll(cleanupTempDirs);

const NOW = new Date("2026-09-17T12:00:00.000Z");

let F: { userRoot: string; projectRoot: string; projectAutomations: string; invalidRoot: string };
let fixtureHome: string;

beforeEach(() => {
  if (!fixtureHome) fixtureHome = tempDir("pi-fixtures-state-");
  F = buildFixtures(fixtureHome);
});

function findAll(root: string, scope: "user" | "repository"): Discovered[] {
  return discover({ roots: [{ path: root, scope, kind: "agents" }] });
}

function locate(root: string, scope: "user" | "repository", name: string): Located {
  const l = located(findAll(root, scope)).find((x) => x.automation.name === name);
  if (!l) throw new Error(`fixture ${name} not found`);
  return l;
}

/** A runtime that resolves anything, so status tests are about state and not about models. */
const permissiveRuntime: ModelRuntimeLike = {
  providers: () => ["anthropic", "openai"],
  getModel: (provider, id) => ({ id, provider }),
  checkAuth: async () => true,
  defaultModel: () => ({
    provider: "anthropic",
    id: "default",
    display: "anthropic/default",
    raw: {},
  }),
};

// That catalog, as the resolver a status computation now takes.
//
// Status asks one question — "what model would this automation use?" — so it is handed the resolver
// rather than a catalog it could open a session with.
const permissiveResolver: ModelResolver = (spec) => resolveModel(spec, permissiveRuntime);

describe("Trust", () => {
  it("arms a repository automation and reports it armed", () => {
    const dir = tempDir("pi-trust-");
    const trust = new Trust(dir);
    const l = locate(F.projectAutomations, "repository", "stale-pr-nudge");

    expect(trust.isArmed(l, NOW)).toBe(false);
    expect(trust.offReason(l, NOW)).toBe("not armed — /automations arm stale-pr-nudge");

    trust.arm(l, digestOf(l), { "scripts/list_stale.js": "node scripts/list_stale.js" }, NOW, 0);
    expect(trust.isArmed(l, NOW)).toBe(true);
    expect(trust.offReason(l, NOW)).toBeUndefined();
  });

  it("holds a user automation off until it is armed, exactly like a repository one", () => {
    const trust = new Trust(tempDir("pi-trust-user-"));
    const l = locate(F.userRoot, "user", "daily-briefing");
    expect(trust.isArmed(l, NOW)).toBe(false);
    expect(trust.offReason(l, NOW)).toBe("not armed — /automations arm daily-briefing");

    trust.arm(l, digestOf(l), {}, NOW, 0);
    expect(trust.isArmed(l, NOW)).toBe(true);
    expect(trust.offReason(l, NOW)).toBeUndefined();
  });

  it("drops a user automation to off when its file or a script changes, and names it", () => {
    const trust = new Trust(tempDir("pi-trust-user-changed-"));
    const l = locate(F.userRoot, "user", "daily-briefing");
    trust.arm(l, digestOf(l), {}, NOW, 0);

    writeFileSync(path.join(l.dir, "scripts", "overnight_counts.js"), "console.log('changed');\n");
    expect(trust.isArmed(l, NOW)).toBe(false);
    expect(trust.offReason(l, NOW)).toBe(
      "changed since armed: scripts/overnight_counts.js — /automations arm daily-briefing",
    );

    trust.arm(l, digestOf(l), {}, NOW, 0);
    writeFileSync(l.file, `${readText(l.file)}\nAn added instruction.\n`);
    expect(trust.offReason(l, NOW)).toBe("changed since armed: AUTOMATION.md — /automations arm daily-briefing");
  });

  it("loads a trust file written before user automations needed consent", () => {
    const dir = tempDir("pi-trust-old-");
    const project = locate(F.projectAutomations, "repository", "docs-drift");
    // Version 1, repository records only, and no per-file hashes: what an older release wrote.
    writeFileSync(
      path.join(dir, "trust.json"),
      JSON.stringify({
        version: 1,
        records: {
          [project.key]: {
            key: project.key,
            dir: project.dir,
            repoRoot: F.projectRoot,
            digest: digestOf(project),
            armedAt: NOW.toISOString(),
            lastSeenAt: NOW.toISOString(),
            interpreters: {},
          },
        },
      }),
    );
    const trust = new Trust(dir);
    expect(trust.isArmed(project, NOW)).toBe(true);
    expect(trust.offReason(locate(F.userRoot, "user", "daily-briefing"), NOW)).toBe(
      "not armed — /automations arm daily-briefing",
    );
  });

  it("drops to off when a hook script changes, and names the file", () => {
    const dir = tempDir("pi-trust-changed-");
    const trust = new Trust(dir);
    const l = locate(F.projectAutomations, "repository", "stale-pr-nudge");
    trust.arm(l, digestOf(l), {}, NOW, 0);

    writeFileSync(path.join(l.dir, "scripts", "post_summary.js"), "console.log('changed');\n");

    const { changed, files } = trust.changedSinceArmed(l);
    expect(changed).toBe(true);
    expect(files).toEqual(["scripts/post_summary.js"]);
    expect(trust.isArmed(l, NOW)).toBe(false);
    expect(trust.offReason(l, NOW)).toContain("changed since armed: scripts/post_summary.js");
  });

  it("drops to off when the automation file itself changes", () => {
    const trust = new Trust(tempDir("pi-trust-file-"));
    const l = locate(F.projectAutomations, "repository", "docs-drift");
    trust.arm(l, digestOf(l), {}, NOW, 0);

    writeFileSync(l.file, `${readText(l.file)}\nAn added instruction.\n`);
    expect(trust.changedSinceArmed(l).files).toEqual(["AUTOMATION.md"]);
  });

  it("expires consent", () => {
    const trust = new Trust(tempDir("pi-trust-expiry-"));
    const l = locate(F.projectAutomations, "repository", "docs-drift");
    trust.arm(l, digestOf(l), {}, NOW, 1000);

    expect(trust.isArmed(l, new Date(NOW.getTime() + 500))).toBe(true);
    expect(trust.isArmed(l, new Date(NOW.getTime() + 1500))).toBe(false);
    expect(trust.offReason(l, new Date(NOW.getTime() + 1500))).toContain("consent expired");
  });

  it("expires repository consent after the default 30 days, and never user consent", () => {
    const dir = tempDir("pi-trust-30d-");
    const trust = new Trust(dir);
    const project = locate(F.projectAutomations, "repository", "docs-drift");
    const user = locate(F.userRoot, "user", "daily-briefing");
    const thirtyDays = ms(DEFAULTS, "consentExpiry");
    trust.arm(project, digestOf(project), {}, NOW, thirtyDays);
    trust.arm(user, digestOf(user), {}, NOW, thirtyDays);
    expect(trust.record(user)?.expiresAt).toBeUndefined();

    const later = new Date(NOW.getTime() + thirtyDays + 86_400_000);
    expect(trust.isArmed(project, later)).toBe(false);
    expect(trust.offReason(project, later)).toBe("consent expired — /automations arm docs-drift");
    expect(trust.isArmed(user, later)).toBe(true);
    expect(trust.isArmed(user, new Date(NOW.getTime() + 10 * 365 * 86_400_000))).toBe(true);
  });

  it("ignores an expiry on a user record written by an earlier build", () => {
    const dir = tempDir("pi-trust-user-expiry-");
    const user = locate(F.userRoot, "user", "daily-briefing");
    writeFileSync(
      path.join(dir, "trust.json"),
      JSON.stringify({
        version: 1,
        records: {
          [user.key]: {
            key: user.key,
            dir: user.dir,
            repoRoot: "",
            digest: digestOf(user),
            armedAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-31T00:00:00.000Z",
            interpreters: {},
            files: fileHashesOf(user),
          },
        },
      }),
    );
    expect(new Trust(dir).isArmed(user, NOW)).toBe(true);
  });

  it("treats expiry of 0 as no expiry", () => {
    const trust = new Trust(tempDir("pi-trust-noexp-"));
    const l = locate(F.projectAutomations, "repository", "docs-drift");
    trust.arm(l, digestOf(l), {}, NOW, 0);
    expect(trust.record(l)?.expiresAt).toBeUndefined();
    expect(trust.isArmed(l, new Date(NOW.getTime() + 1e10))).toBe(true);
  });

  it("disarms on request", () => {
    const trust = new Trust(tempDir("pi-trust-disarm-"));
    const l = locate(F.projectAutomations, "repository", "docs-drift");
    trust.arm(l, digestOf(l), {}, NOW, 0);
    trust.disarm(l);
    expect(trust.isArmed(l, NOW)).toBe(false);
  });

  it("persists across instances", () => {
    const dir = tempDir("pi-trust-persist-");
    const l = locate(F.projectAutomations, "repository", "docs-drift");
    new Trust(dir).arm(l, digestOf(l), { a: "b" }, NOW, 0);

    const reloaded = new Trust(dir);
    expect(reloaded.isArmed(l, NOW)).toBe(true);
    expect(reloaded.record(l)?.interpreters).toEqual({ a: "b" });
  });

  it("survives a corrupt trust.json rather than crashing every tick", () => {
    const dir = tempDir("pi-trust-corrupt-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "trust.json"), "{ not json");
    const trust = new Trust(dir);
    expect(trust.all()).toEqual([]);
  });

  it("sweeps only records whose directory is gone AND which are stale", () => {
    const dir = tempDir("pi-trust-sweep-");
    const trust = new Trust(dir);
    const gone = locate(F.projectAutomations, "repository", "docs-drift");
    const stays = locate(F.projectAutomations, "repository", "release-notes");
    trust.arm(gone, digestOf(gone), {}, NOW, 0);
    trust.arm(stays, digestOf(stays), {}, NOW, 0);

    rmSync(gone.dir, { recursive: true, force: true });

    // Missing but recently seen: kept, because an unplugged drive is not a deletion.
    expect(trust.sweep(new Date(NOW.getTime() + 1000), 30 * 86_400_000)).toEqual([]);
    // Missing and long unseen: reclaimed.
    expect(trust.sweep(new Date(NOW.getTime() + 31 * 86_400_000), 30 * 86_400_000)).toEqual([
      gone.key,
    ]);
    expect(trust.record(stays)).toBeDefined();
  });

  // Every process keeps a copy of trust.json, and a copy can be seconds old when it writes.
  it("keeps an arm made elsewhere while an older copy notes sightings and saves", () => {
    const dir = tempDir("pi-trust-lost-arm-");
    const l = locate(F.userRoot, "user", "daily-briefing");
    new Trust(dir).arm(l, digestOf(l), {}, NOW, 0);
    // The person edits the automation, which turns it off, and arms it again…
    writeFileSync(l.file, `${readText(l.file)}\nAn added instruction.\n`);
    const tick = new Trust(dir); // …while a tick that loaded before the new arm is still going.
    expect(tick.isArmed(l, NOW)).toBe(false);
    new Trust(dir).arm(l, digestOf(l), {}, NOW, 0);
    tick.touch(l, new Date(NOW.getTime() + 60_000));
    tick.save();

    const after = new Trust(dir);
    expect(after.isArmed(l, NOW)).toBe(true);
    expect(after.record(l)?.lastSeenAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    // And the older copy reads the file it wrote, not its own stale view.
    expect(tick.isArmed(l, NOW)).toBe(true);
  });

  it("never brings back a record disarmed elsewhere, nor drops one armed elsewhere", () => {
    const dir = tempDir("pi-trust-lost-disarm-");
    const user = locate(F.userRoot, "user", "daily-briefing");
    const project = locate(F.projectAutomations, "repository", "docs-drift");
    new Trust(dir).arm(user, digestOf(user), {}, NOW, 0);

    const stale = new Trust(dir);
    new Trust(dir).disarm(user);
    new Trust(dir).arm(project, digestOf(project), {}, NOW, 0);
    stale.touch(user, NOW);
    stale.save();
    expect(new Trust(dir).isArmed(user, NOW)).toBe(false);
    expect(new Trust(dir).isArmed(project, NOW)).toBe(true);

    // A change of its own applies to the file as it is now, not to its copy.
    const older = new Trust(dir);
    new Trust(dir).arm(user, digestOf(user), {}, NOW, 0);
    older.disarm(project);
    expect(new Trust(dir).isArmed(user, NOW)).toBe(true);
    expect(new Trust(dir).isArmed(project, NOW)).toBe(false);
  });

  it("sweeps on what is on disk, so a record seen elsewhere since is kept", () => {
    const dir = tempDir("pi-trust-sweep-seen-");
    const gone = locate(F.projectAutomations, "repository", "docs-drift");
    new Trust(dir).arm(gone, digestOf(gone), {}, NOW, 0);
    const later = new Date(NOW.getTime() + 31 * 86_400_000);

    const sweeper = new Trust(dir);
    const seer = new Trust(dir);
    seer.touch(gone, later);
    seer.save();
    rmSync(gone.dir, { recursive: true, force: true });

    expect(sweeper.sweep(later, 30 * 86_400_000)).toEqual([]);
    expect(new Trust(dir).record(gone)).toBeDefined();
  });

  it("does not write when nothing changed", () => {
    const dir = tempDir("pi-trust-no-write-");
    const trust = new Trust(dir);
    trust.touch(locate(F.userRoot, "user", "daily-briefing"), NOW);
    trust.save();
    expect(existsSync(path.join(dir, "trust.json"))).toBe(false);
  });
});

describe("State", () => {
  it("claims a cron instant once", () => {
    const s = new State(tempDir("pi-state-"));
    expect(s.claim("k", "2026-09-17T07:00:00Z")).toBe(true);
    expect(s.claim("k", "2026-09-17T07:00:00Z")).toBe(false);
    expect(s.claim("k", "2026-09-18T07:00:00Z")).toBe(true);
  });

  it("persists claims and roots", () => {
    const dir = tempDir("pi-state-persist-");
    const a = new State(dir);
    a.claim("k", "t");
    a.registerRoot("/srv/repo");
    a.lastTickAt = NOW.toISOString();
    a.save();

    const b = new State(dir);
    expect(b.claimOf("k")).toBe("t");
    expect(b.roots).toEqual([path.resolve("/srv/repo")]);
    expect(b.lastTickAt).toBe(NOW.toISOString());
  });

  it("persists dismissed failed run ids without overwriting command-owned fields", () => {
    const dir = tempDir("pi-state-dismissed-");
    const a = new State(dir);
    a.dismissRun("user:/r:x", "run-1");
    a.save();

    const b = new State(dir);
    expect(b.dismissedRunOf("user:/r:x")).toBe("run-1");
    expect(b.dismissRun("user:/r:x", "run-1")).toBe(false);
    expect(b.dismissRun("user:/r:x", "run-2")).toBe(true);
    b.save();

    expect(new State(dir).dismissedRunOf("user:/r:x")).toBe("run-2");
  });

  it("registers a root once and can unregister it", () => {
    const s = new State(tempDir("pi-state-roots-"));
    s.registerRoot("/srv/repo");
    s.registerRoot("/srv/repo/");
    expect(s.roots).toHaveLength(1);
    s.unregisterRoot("/srv/repo");
    expect(s.roots).toEqual([]);
  });

  it("prunes claims for automations that no longer exist", () => {
    const s = new State(tempDir("pi-state-prune-"));
    s.claim("live", "t");
    s.claim("gone", "t");
    expect(s.pruneClaims(["live"])).toEqual(["gone"]);
    expect(s.claimOf("gone")).toBeUndefined();
  });

  it("starts clean when the file is corrupt", () => {
    const dir = tempDir("pi-state-corrupt-");
    writeFileSync(path.join(dir, "state.json"), "]]not json[[");
    const s = new State(dir);
    expect(s.claimed).toEqual({});
    expect(s.roots).toEqual([]);
  });
});

describe("records", () => {
  const rec = (over: Partial<RunRecord> = {}): RunRecord => ({
    id: newRunId(NOW),
    key: "user:/r:x",
    name: "x",
    scope: "user",
    root: "/r",
    trigger: "schedule",
    late: false,
    recordedAt: NOW.toISOString(),
    outcome: "ok",
    ...over,
  });

  it("appends and reads back, oldest first", () => {
    const dir = tempDir("pi-records-");
    appendRecord(dir, rec({ id: "a" }));
    appendRecord(dir, rec({ id: "b" }));
    expect(readRecords(dir, "user:/r:x").map((r) => r.id)).toEqual(["a", "b"]);
    expect(lastRecord(dir, "user:/r:x")?.id).toBe("b");
  });

  it("returns nothing for an automation that has never run", () => {
    const dir = tempDir("pi-records-empty-");
    expect(readRecords(dir, "user:/r:nothing")).toEqual([]);
    expect(lastRecord(dir, "user:/r:nothing")).toBeUndefined();
  });

  it("skips a torn line, and the next append does not glue itself onto it", () => {
    const dir = tempDir("pi-records-torn-");
    appendRecord(dir, rec({ id: "a" }));

    // Exactly what a process killed mid-write leaves behind: a fragment with no newline.
    const runsDir = path.join(dir, "runs");
    const name = readdirSync(runsDir)[0] as string;
    appendFileSync(path.join(runsDir, name), '{"id":"b","key":');

    appendRecord(dir, rec({ id: "c" }));

    // The torn record is lost — that is unavoidable. Record "c" must NOT be, which is what the
    // missing-newline repair in appendRecord buys: one killed process costs one record, not two.
    expect(readRecords(dir, "user:/r:x").map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("rotates a log that has grown past its limit", () => {
    const dir = tempDir("pi-records-rotate-");
    const retention = { maxLinesPerAutomation: 10, keepLines: 4 };
    for (let i = 0; i < 10; i++) appendRecord(dir, rec({ id: `r${i}` }), retention);
    expect(readRecords(dir, "user:/r:x").length).toBe(10);

    appendRecord(dir, rec({ id: "r10" }), retention);
    expect(readRecords(dir, "user:/r:x").length).toBe(4);
    expect(readRecords(dir, "user:/r:x").map((r) => r.id)).toEqual(["r7", "r8", "r9", "r10"]);
  });

  it("does not rotate below the limit", () => {
    const dir = tempDir("pi-records-norotate-");
    const retention = { maxLinesPerAutomation: 100, keepLines: 10 };
    for (let i = 0; i < 5; i++) appendRecord(dir, rec({ id: `r${i}` }), retention);
    rotateIfNeeded(dir, "user:/r:x", retention);
    expect(readRecords(dir, "user:/r:x").length).toBe(5);
  });

  it("keeps two automations' histories apart", () => {
    const dir = tempDir("pi-records-two-");
    appendRecord(dir, rec({ key: "user:/r:a", id: "a" }));
    appendRecord(dir, rec({ key: "user:/r:b", id: "b" }));
    expect(readRecords(dir, "user:/r:a").map((r) => r.id)).toEqual(["a"]);
    expect(readRecords(dir, "user:/r:b").map((r) => r.id)).toEqual(["b"]);
  });

  it("makes a run id that sorts and is unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId(NOW)));
    expect(ids.size).toBeGreaterThan(40);
    for (const id of ids) expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
  });
});

describe("locks", () => {
  it("knows this process is alive and a nonsense pid is not", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(2 ** 30)).toBe(false);
  });

  it("gives the tick lock to exactly one acquirer", () => {
    const dir = tempDir("pi-ticklock-");
    const first = acquireTickLock(dir, 300_000, NOW);
    expect(first).toBeTypeOf("function");
    expect(acquireTickLock(dir, 300_000, NOW)).toBeUndefined();

    first?.();
    expect(acquireTickLock(dir, 300_000, NOW)).toBeTypeOf("function");
  });

  it("reclaims a tick lock whose owner is dead", () => {
    const dir = tempDir("pi-ticklock-dead-");
    mkdirSync(path.join(dir, "locks"), { recursive: true });
    writeFileSync(
      path.join(dir, "locks", "tick.lock"),
      JSON.stringify({ pid: 2 ** 30, at: NOW.toISOString() }),
    );
    expect(acquireTickLock(dir, 300_000, NOW)).toBeTypeOf("function");
  });

  it("reclaims a tick lock that is simply too old", () => {
    const dir = tempDir("pi-ticklock-old-");
    mkdirSync(path.join(dir, "locks"), { recursive: true });
    writeFileSync(
      path.join(dir, "locks", "tick.lock"),
      JSON.stringify({ pid: process.pid, at: new Date(NOW.getTime() - 600_000).toISOString() }),
    );
    expect(acquireTickLock(dir, 300_000, NOW)).toBeTypeOf("function");
  });

  it("gives a run lock to one holder and reports who has it", () => {
    const dir = tempDir("pi-runlock-");
    const info = runLockInfo({
      key: "user:/r:x",
      runId: "run-1",
      timeoutMs: 600_000,
      postHooks: 1,
      trigger: "schedule",
      now: NOW,
    });

    const first = acquireRunLock(dir, info);
    expect(first.ok).toBe(true);

    const second = acquireRunLock(dir, { ...info, runId: "run-2" });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.held.runId).toBe("run-1");

    if (first.ok) first.release();
    expect(acquireRunLock(dir, info).ok).toBe(true);
  });

  it("reads back the lock payload", () => {
    const dir = tempDir("pi-runlock-read-");
    const info = runLockInfo({
      key: "user:/r:x",
      runId: "run-1",
      timeoutMs: 1,
      postHooks: 0,
      trigger: "manual",
      now: NOW,
    });
    acquireRunLock(dir, info);
    expect(readRunLock(dir, "user:/r:x")?.trigger).toBe("manual");
    expect(readRunLock(dir, "user:/r:nothing")).toBeUndefined();
  });

  it("calls a lock stale when its process is gone", () => {
    const info = runLockInfo({
      key: "k",
      runId: "r",
      timeoutMs: 600_000,
      postHooks: 0,
      trigger: "schedule",
      now: NOW,
      pid: 2 ** 30,
    });
    expect(isRunLockStale(info, 60_000, NOW)).toBe(true);
  });

  it("calls a live lock stale only once it outlives its whole budget", () => {
    const info = runLockInfo({
      key: "k",
      runId: "r",
      timeoutMs: 600_000,
      postHooks: 2,
      trigger: "schedule",
      now: NOW,
      pid: process.pid,
    });
    // budget = 600_000 + 60_000 * 3 + 300_000 = 1_080_000
    expect(isRunLockStale(info, 60_000, new Date(NOW.getTime() + 1_000_000))).toBe(false);
    expect(isRunLockStale(info, 60_000, new Date(NOW.getTime() + 1_100_000))).toBe(true);
  });

  it("sweeps an abandoned run lock and records aborted: host stopped", () => {
    const dir = tempDir("pi-sweep-");
    const info = runLockInfo({
      key: "repository:/srv/repo:stale-pr-nudge",
      runId: "run-9",
      timeoutMs: 1000,
      postHooks: 0,
      trigger: "schedule",
      scheduledFor: "2026-09-17T07:00:00Z",
      now: new Date(NOW.getTime() - 10_000_000),
      pid: 2 ** 30,
    });
    acquireRunLock(dir, info);

    const written: RunRecord[] = [];
    const swept = sweepStaleRunLocks(dir, DEFAULTS, NOW, (r) => written.push(r));

    expect(swept).toHaveLength(1);
    expect(written[0]).toMatchObject({
      id: "run-9",
      outcome: "aborted",
      reason: "host stopped",
      key: "repository:/srv/repo:stale-pr-nudge",
      name: "stale-pr-nudge",
      scope: "repository",
      root: "/srv/repo",
      scheduledFor: "2026-09-17T07:00:00Z",
    });
    expect(readRunLock(dir, info.key)).toBeUndefined();
  });

  it("leaves a healthy run lock alone", () => {
    const dir = tempDir("pi-sweep-live-");
    const info = runLockInfo({
      key: "user:/r:x",
      runId: "run-live",
      timeoutMs: 600_000,
      postHooks: 0,
      trigger: "schedule",
      now: NOW,
      pid: process.pid,
    });
    acquireRunLock(dir, info);
    expect(sweepStaleRunLocks(dir, DEFAULTS, NOW, () => {})).toEqual([]);
    expect(readRunLock(dir, "user:/r:x")).toBeDefined();
  });

  it("never sweeps the tick lock", () => {
    const dir = tempDir("pi-sweep-tick-");
    acquireTickLock(dir, 300_000, NOW);
    sweepStaleRunLocks(dir, DEFAULTS, new Date(NOW.getTime() + 1e9), () => {});
    expect(existsSync(path.join(dir, "locks", "tick.lock"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------- status

describe("decideState — precedence", () => {
  const bad: Discovered = {
    ok: false,
    dir: "/a/x",
    file: "/a/x/AUTOMATION.md",
    root: { path: "/a", scope: "user", kind: "agents" },
    key: "user:/a:x",
    error: "on.schedule.cron: bad",
  };

  it("invalid beats everything", () => {
    expect(decideState(bad, true)).toEqual({ state: "invalid", reason: "on.schedule.cron: bad" });
  });

  it("disabled beats off and armed", () => {
    const d = okDiscovered({ enabled: false });
    expect(decideState(d, false).state).toBe("disabled");
    expect(decideState(d, true).state).toBe("disabled");
  });

  it("off when consent is missing", () => {
    expect(decideState(okDiscovered({}), false, "not armed — x")).toEqual({
      state: "off",
      reason: "not armed — x",
    });
  });

  it("armed when enabled and consented", () => {
    expect(decideState(okDiscovered({}), true)).toEqual({ state: "armed" });
  });
});

function okDiscovered(over: { enabled?: boolean }): Discovered {
  return {
    ok: true,
    located: {
      automation: {
        name: "x",
        description: "d",
        enabled: over.enabled ?? true,
        on: { manual: true },
        hooks: { pre: [], post: [] },
        body: "b",
      },
      dir: "/a/x",
      file: "/a/x/AUTOMATION.md",
      root: { path: "/a", scope: "user", kind: "agents" },
      key: "user:/a:x",
    },
  };
}

describe("computeStatuses", () => {
  /** A user root with every automation in it armed, as a person would have done. */
  function armed(root: string, dir: string): Discovered[] {
    armUserRoot(root, dir);
    return findAll(root, "user");
  }

  function deps(dir: string, over: Partial<Parameters<typeof computeStatuses>[1]> = {}) {
    return {
      trust: new Trust(dir),
      config: DEFAULTS,
      stateDir: dir,
      now: NOW,
      resolveModel: permissiveResolver,
      ...over,
    };
  }

  it("arms an enabled user automation and fills its next fire", async () => {
    const dir = tempDir("pi-status-user-");
    const statuses = await computeStatuses(armed(F.userRoot, dir), deps(dir));
    const daily = statuses.find((s) => s.name === "daily-briefing");

    expect(daily?.state).toBe("armed");
    expect(daily?.nextFire).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(daily?.resolvedModel?.display).toBe("anthropic/claude-sonnet-4-5:low");
    expect(daily?.effectiveTimeoutMs).toBe(600_000);
    expect(daily?.staggerSec).toBeGreaterThanOrEqual(0);
    expect(daily?.staggerSec).toBeLessThan(120);
  });

  it("lists a disabled automation as disabled and never asks the runtime", async () => {
    const dir = tempDir("pi-status-disabled-");
    const asked: Array<string | undefined> = [];
    const recording: ModelResolver = (spec) => {
      asked.push(spec);
      return resolveModel(spec, permissiveRuntime);
    };
    const statuses = await computeStatuses(
      armed(F.userRoot, dir),
      deps(dir, { resolveModel: recording }),
    );
    const standup = statuses.find((s) => s.name === "standup-notes");

    expect(standup?.state).toBe("disabled");
    expect(standup?.nextFire).toBeUndefined();
    expect(asked).toContain("anthropic/claude-sonnet-4-5:low");
    expect(standup?.resolvedModel).toBeUndefined();
  });

  it("keeps an invalid file invalid even when it is also disabled", async () => {
    const dir = tempDir("pi-status-invalid-");
    const statuses = await computeStatuses(findAll(F.invalidRoot, "user"), deps(dir));
    expect(statuses.every((s) => s.state === "invalid")).toBe(true);
    const badCron = statuses.find((s) => s.name === "bad-cron");
    expect(badCron?.reason).toContain("not a 5-field cron expression");
    expect(badCron?.automation).toBeUndefined();
  });

  it("holds a repository automation off until it is armed, and arms it afterwards", async () => {
    const dir = tempDir("pi-status-project-");
    const d = deps(dir);
    const before = await computeStatuses(findAll(F.projectAutomations, "repository"), d);
    const nudgeBefore = before.find((s) => s.name === "stale-pr-nudge");
    expect(nudgeBefore?.state).toBe("off");
    expect(nudgeBefore?.reason).toContain("not armed");

    const l = locate(F.projectAutomations, "repository", "stale-pr-nudge");
    d.trust.arm(l, digestOf(l), interpreterMap(l), NOW, 0);

    const after = await computeStatuses(findAll(F.projectAutomations, "repository"), d);
    expect(after.find((s) => s.name === "stale-pr-nudge")?.state).toBe("armed");
  });

  it("refuses a timeout above the host maximum", async () => {
    const dir = tempDir("pi-status-timeout-");
    const root = path.join(tempDir("pi-timeout-root-"), "automations");
    mkdirSync(path.join(root, "slow"), { recursive: true });
    writeFileSync(
      path.join(root, "slow", "AUTOMATION.md"),
      `---\nname: slow\ndescription: Asks for longer than this host allows.\ntimeout: 6h\non:\n  manual: true\n---\n\nBody.\n`,
    );
    const statuses = await computeStatuses(armed(root, dir), deps(dir));
    expect(statuses[0]?.state).toBe("invalid");
    expect(statuses[0]?.reason).toBe("timeout: 6h exceeds this host's maximum of 4h");
  });

  it("marks an automation invalid when a hook script cannot run here", async () => {
    const dir = tempDir("pi-status-interp-");
    const root = path.join(tempDir("pi-interp-root-"), "automations");
    mkdirSync(path.join(root, "ruby"), { recursive: true });
    writeFileSync(path.join(root, "ruby", "go.rb"), "puts 1\n");
    writeFileSync(
      path.join(root, "ruby", "AUTOMATION.md"),
      `---\nname: ruby\ndescription: Uses a language this host cannot run.\non:\n  manual: true\nhooks:\n  pre:\n    - script: go.rb\n---\n\nBody.\n`,
    );
    const statuses = await computeStatuses(armed(root, dir), deps(dir));
    expect(statuses[0]?.state).toBe("invalid");
    expect(statuses[0]?.reason).toBe(
      'hooks.pre[0]: go.rb cannot run here — no interpreter for ".rb" on this OS',
    );
  });

  it("marks an automation invalid when its model does not resolve", async () => {
    const dir = tempDir("pi-status-model-");
    const empty: ModelResolver = (spec) =>
      resolveModel(spec, { ...permissiveRuntime, getModel: () => undefined });
    const statuses = await computeStatuses(
      armed(F.userRoot, dir),
      deps(dir, { resolveModel: empty }),
    );
    const daily = statuses.find((s) => s.name === "daily-briefing");
    expect(daily?.state).toBe("invalid");
    expect(daily?.reason).toContain("is not in provider anthropic");
  });

  it("skips model resolution entirely when no resolver is supplied", async () => {
    const dir = tempDir("pi-status-noruntime-");
    const statuses = await computeStatuses(
      armed(F.userRoot, dir),
      deps(dir, { resolveModel: undefined }),
    );
    const daily = statuses.find((s) => s.name === "daily-briefing");
    expect(daily?.state).toBe("armed");
    expect(daily?.resolvedModel).toBeUndefined();
  });

  it("reports a live run", async () => {
    const dir = tempDir("pi-status-running-");
    const l = locate(F.userRoot, "user", "daily-briefing");
    acquireRunLock(
      dir,
      runLockInfo({
        key: l.key,
        runId: "run-live",
        timeoutMs: 600_000,
        postHooks: 1,
        trigger: "manual",
        now: NOW,
      }),
    );
    const statuses = await computeStatuses(armed(F.userRoot, dir), deps(dir));
    expect(statuses.find((s) => s.name === "daily-briefing")?.running?.runId).toBe("run-live");
  });

  it.each(["daily-briefing", "standup-notes"])(
    "does not show a dead run as running, even for %s",
    async (name) => {
      const dir = tempDir("pi-status-dead-");
      const l = locate(F.userRoot, "user", name);
      acquireRunLock(dir, runLockInfo({
        key: l.key, runId: "dead-run", timeoutMs: 600_000, postHooks: 1,
        trigger: "manual", now: NOW, pid: 0,
      }));
      const statuses = await computeStatuses(armed(F.userRoot, dir), deps(dir));
      expect(statuses.find((s) => s.key === l.key)?.running).toBeUndefined();
      // A read must not release ownership or invent a successful stop record.
      expect(readRunLock(dir, l.key)?.runId).toBe("dead-run");
      expect(readRecords(dir, l.key)).toEqual([]);
    },
  );

  it("uses the same stale-lock budget as the running window", async () => {
    const dir = tempDir("pi-status-stale-");
    const l = locate(F.userRoot, "user", "daily-briefing");
    acquireRunLock(dir, runLockInfo({
      key: l.key, runId: "old-run", timeoutMs: 1000, postHooks: 0,
      trigger: "manual", now: new Date(NOW.getTime() - 86_400_000),
    }));
    const statuses = await computeStatuses(armed(F.userRoot, dir), deps(dir));
    expect(statuses.find((s) => s.key === l.key)?.running).toBeUndefined();
  });

  it("carries the last outcome into the listing", async () => {
    const dir = tempDir("pi-status-last-");
    const l = locate(F.userRoot, "user", "manual-only");
    appendRecord(dir, {
      id: "r1",
      key: l.key,
      name: l.automation.name,
      scope: "user",
      root: l.root.path,
      trigger: "manual",
      late: false,
      recordedAt: NOW.toISOString(),
      startedAt: new Date(NOW.getTime() - 5000).toISOString(),
      endedAt: NOW.toISOString(),
      outcome: "failed",
      error: { kind: "timeout", message: "ran long" },
    });
    const statuses = await computeStatuses(armed(F.userRoot, dir), deps(dir));
    const manual = statuses.find((s) => s.name === "manual-only");
    expect(manual?.last).toMatchObject({ outcome: "failed", reason: "timeout", durationMs: 5000 });
  });
});

function readText(p: string): string {
  return readFileSync(p, "utf8");
}
