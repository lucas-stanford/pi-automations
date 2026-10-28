import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import {
  ambiguousLine,
  consentPreview,
  applyArm,
  handleArm,
  handleCheck,
  handleDisarm,
  handleEnable,
  handleList,
  handleLog,
  handleRun,
  helpLines,
  localStamp,
  logLine,
  notFoundLine,
  parseArgs,
  refresh,
  resolveName,
  SUBS,
  type CommandDeps,
} from "../src/commands.js";
import { digestOf } from "../src/digest.js";
import { discover, located } from "../src/discover.js";
import { renderListing, statusLine } from "../src/listing.js";
import { acquireRunLock, runLockInfo } from "../src/locks.js";
import { appendRecord } from "../src/records.js";
import { State } from "../src/state.js";
import { computeStatuses } from "../src/status.js";
import { Trust } from "../src/trust.js";
import type { ModelResolver } from "../src/core/contracts.js";
import { resolveModel, type ModelRuntimeLike } from "../src/model.js";
import type { Located, Status } from "../src/types.js";
// @ts-expect-error - plain JS fixture builder, deliberately untyped
import { buildFixtures } from "./helpers/fixtures.mjs";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const NOW = new Date("2026-09-17T12:00:00.000Z");
const HOME = path.resolve("/home/alice");

const runtime: ModelRuntimeLike = {
  providers: () => ["anthropic"],
  getModel: (provider, id) => ({ id, provider }),
  checkAuth: async () => true,
  defaultModel: () => ({
    provider: "anthropic",
    id: "default",
    display: "anthropic/default",
    raw: {},
  }),
};

/** That catalog as a resolver — what a listing is given now. */
const resolver: ModelResolver = (spec) => resolveModel(spec, runtime);

let F: { userRoot: string; projectRoot: string; projectAutomations: string; invalidRoot: string };
let fixtureHome: string;

beforeEach(() => {
  if (!fixtureHome) fixtureHome = tempDir("pi-fixtures-cmd-");
  F = buildFixtures(fixtureHome);
});

/** Statuses for these roots. User automations are armed first unless `armUser` is false. */
async function statusesFor(
  roots: Array<{ path: string; scope: "user" | "repository" }>,
  stateDir: string,
  trust = new Trust(stateDir),
  armUser = true,
): Promise<Status[]> {
  const found = discover({
    roots: roots.map((r) => ({ path: r.path, scope: r.scope, kind: "agents" as const })),
  });
  if (armUser) {
    for (const l of located(found)) {
      if (l.root.scope === "user" && !trust.record(l)) trust.arm(l, digestOf(l), {}, NOW, 0);
    }
  }
  return computeStatuses(found, {
    trust,
    config: DEFAULTS,
    stateDir,
    now: NOW,
    resolveModel: resolver,
  });
}

function locate(root: string, scope: "user" | "repository", name: string): Located {
  const found = discover({ roots: [{ path: root, scope, kind: "agents" }] });
  const l = located(found).find((x) => x.automation.name === name);
  if (!l) throw new Error(`fixture ${name} not found`);
  return l;
}

// ---------------------------------------------------------------------------- listing

describe("renderListing", () => {
  it("groups by scope with USER first and a rule before REPOSITORY", async () => {
    const dir = tempDir("pi-listing-");
    const statuses = await statusesFor(
      [
        { path: F.userRoot, scope: "user" },
        { path: F.projectAutomations, scope: "repository" },
      ],
      dir,
    );

    const lines = renderListing(statuses, {
      home: HOME,
      projectRoots: [F.projectRoot],
      now: NOW,
      width: 100,
    });

    const text = lines.join("\n");
    const userAt = lines.findIndex((l) => l.includes("USER ·"));
    const ruleAt = lines.findIndex((l) => l.includes("────"));
    const projectAt = lines.findIndex((l) => l.includes("REPOSITORY ·"));

    expect(userAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeGreaterThan(userAt);
    expect(projectAt).toBeGreaterThan(ruleAt);

    // A scope COLUMN would defeat the point; the grouping is the signal.
    expect(lines[0]).toContain("NAME");
    expect(lines[0]).not.toContain("SCOPE");
    expect(text).toContain("daily-briefing");
    expect(text).toContain("stale-pr-nudge");
  });

  it("sorts armed, then off, then disabled, then invalid", async () => {
    const dir = tempDir("pi-listing-sort-");
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir);
    const lines = renderListing(statuses, {
      home: HOME,
      projectRoots: [],
      now: NOW,
      width: 100,
    });

    const names = lines
      .filter((l) => /^ {2}\S/.test(l) && !l.includes("USER ·") && !l.startsWith("  NAME"))
      .map((l) => l.trim().split(/\s+/)[0]);

    // daily-briefing, manual-only and weekly-report are armed; standup-notes is disabled.
    expect(names[names.length - 1]).toBe("standup-notes");
  });

  it("puts a reason line under invalid and off rows only", async () => {
    const dir = tempDir("pi-listing-reason-");
    const statuses = await statusesFor(
      [
        { path: F.invalidRoot, scope: "user" },
        { path: F.projectAutomations, scope: "repository" },
      ],
      dir,
    );
    const lines = renderListing(statuses, {
      home: HOME,
      projectRoots: [F.projectRoot],
      now: NOW,
      width: 120,
    });

    const reasons = lines.filter((l) => l.includes("└"));
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((l) => l.includes("not armed — /automations arm stale-pr-nudge"))).toBe(
      true,
    );
    // An armed automation never explains itself.
    expect(lines.filter((l) => l.includes("└ armed"))).toHaveLength(0);
  });

  it("omits the REPOSITORY section entirely outside a repository", async () => {
    const dir = tempDir("pi-listing-noproject-");
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir);
    const lines = renderListing(statuses, { home: HOME, projectRoots: [], now: NOW, width: 100 });
    expect(lines.some((l) => l.includes("REPOSITORY"))).toBe(false);
    expect(lines.some((l) => l.includes("────"))).toBe(false);
  });

  it("shows an empty repository root with an invitation", async () => {
    const dir = tempDir("pi-listing-emptyproject-");
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir);
    const lines = renderListing(statuses, {
      home: HOME,
      projectRoots: ["/srv/empty"],
      now: NOW,
      width: 100,
    });
    expect(lines.join("\n")).toContain("none — add .agents/automations/<name>/AUTOMATION.md");
  });

  it("says none when there are no user automations at all", () => {
    const lines = renderListing([], { home: HOME, projectRoots: [], now: NOW, width: 100 });
    expect(lines[1]).toContain("USER ·");
    expect(lines[2]?.trim()).toBe("none");
  });

  it("never truncates a name, and drops columns instead when narrow", async () => {
    const dir = tempDir("pi-listing-narrow-");
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir);

    const wide = renderListing(statuses, { home: HOME, projectRoots: [], now: NOW, width: 100 });
    const narrow = renderListing(statuses, { home: HOME, projectRoots: [], now: NOW, width: 70 });

    expect(wide[0]).toContain("HOOKS");
    // HOOKS is a detail and goes first when there is no room.
    expect(narrow[0]).not.toContain("HOOKS");
    // The name a person has to type is never shortened.
    expect(narrow.join("\n")).toContain("daily-briefing");

    // The width budget applies to TABLE ROWS. A group header carries a filesystem path and a reason
    // line carries an error; truncating either would destroy the only useful thing on the line, so
    // both are allowed to overflow and the terminal wraps them.
    const tableRows = narrow.filter((l) => !l.includes("·") && !l.includes("└"));
    expect(tableRows.length).toBeGreaterThan(1);
    for (const line of tableRows) expect(line.length).toBeLessThanOrEqual(70);
  });

  it("shows a running automation in the NEXT column", async () => {
    const dir = tempDir("pi-listing-running-");
    const l = locate(F.userRoot, "user", "daily-briefing");
    acquireRunLock(
      dir,
      runLockInfo({
        key: l.key,
        runId: "r",
        timeoutMs: 600_000,
        postHooks: 0,
        trigger: "manual",
        now: new Date(NOW.getTime() - 42_000),
      }),
    );
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir);
    const lines = renderListing(statuses, { home: HOME, projectRoots: [], now: NOW, width: 110 });
    expect(lines.join("\n")).toContain("◐ running 42s");
  });
});

describe("statusLine", () => {
  it("counts armed and names the next fire", async () => {
    const dir = tempDir("pi-statusline-");
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir);
    const line = statusLine(statuses, NOW);
    expect(line).toContain("automations · 3 armed");
    expect(line).toContain("next");
  });

  it("mentions off and invalid counts with a pointer", async () => {
    const dir = tempDir("pi-statusline-off-");
    const statuses = await statusesFor(
      [
        { path: F.userRoot, scope: "user" },
        { path: F.projectAutomations, scope: "repository" },
      ],
      dir,
    );
    expect(statusLine(statuses, NOW)).toMatch(/off.*\/automations$/);
  });

  it("prefers a live run over the schedule", async () => {
    const dir = tempDir("pi-statusline-running-");
    const l = locate(F.userRoot, "user", "daily-briefing");
    acquireRunLock(
      dir,
      runLockInfo({
        key: l.key,
        runId: "r",
        timeoutMs: 600_000,
        postHooks: 0,
        trigger: "manual",
        now: new Date(NOW.getTime() - 42_000),
      }),
    );
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir);
    expect(statusLine(statuses, NOW)).toBe("◐ daily-briefing running 42s");
  });
});

describe("parseArgs", () => {
  it("defaults to list", () => {
    expect(parseArgs("")).toMatchObject({ sub: "list" });
    expect(parseArgs("   ")).toMatchObject({ sub: "list" });
  });

  it("parses a subcommand and a name", () => {
    expect(parseArgs("run daily-briefing")).toMatchObject({ sub: "run", name: "daily-briefing" });
  });

  it("parses a count and flags in any order", () => {
    const p = parseArgs("log daily-briefing 25 --json");
    expect(p).toMatchObject({ sub: "log", name: "daily-briefing", n: 25 });
    expect(p.flags.has("json")).toBe(true);
  });

  it("treats a bare name as check, because that is the only sensible reading", () => {
    expect(parseArgs("daily-briefing")).toMatchObject({ sub: "check", name: "daily-briefing" });
  });

  it("parses the watcher verb", () => {
    expect(parseArgs("watcher start")).toMatchObject({ sub: "watcher", verb: "start" });
  });

  it("still reads detached as the watcher", () => {
    expect(SUBS.has("detached")).toBe(true);
    expect(parseArgs("detached install")).toMatchObject({ sub: "watcher", verb: "install" });
    expect(parseArgs("detached")).toMatchObject({ sub: "watcher" });
  });
});

describe("resolveName", () => {
  const mk = (name: string, scope: "user" | "repository", dir: string): Status => ({
    key: `${scope}:${dir}:${name}`,
    name,
    scope,
    root: { path: dir, scope, kind: "agents" },
    dir: `${dir}/${name}`,
    state: "armed",
    effectiveTimeoutMs: 1,
    staggerSec: 0,
  });

  const statuses = [mk("x", "user", "/u"), mk("x", "repository", "/p"), mk("solo", "user", "/u")];

  it("finds a unique name", () => {
    const m = resolveName(statuses, "solo");
    expect(m.kind).toBe("one");
  });

  it("reports ambiguity rather than picking one", () => {
    // The same name in two scopes is exactly the case where guessing runs the wrong thing with the
    // wrong credentials.
    const m = resolveName(statuses, "x");
    expect(m.kind).toBe("ambiguous");
    expect(m.kind === "ambiguous" && m.matches).toHaveLength(2);
  });

  it("disambiguates with a scope prefix", () => {
    expect(resolveName(statuses, "user/x").kind).toBe("one");
    const repo = resolveName(statuses, "repository/x");
    expect(repo.kind === "one" && repo.status.scope).toBe("repository");
  });

  it("still accepts the old project/ prefix", () => {
    const m = resolveName(statuses, "project/x");
    expect(m.kind === "one" && m.status.scope).toBe("repository");
  });

  it("accepts a full key", () => {
    expect(resolveName(statuses, "user:/u:x").kind).toBe("one");
  });

  it("reports nothing found", () => {
    expect(resolveName(statuses, "nope").kind).toBe("none");
  });

  it("renders both refusal lines", () => {
    const m = resolveName(statuses, "x");
    const line = ambiguousLine("x", m.kind === "ambiguous" ? m.matches : [], HOME);
    expect(line).toContain("user/x");
    expect(line).toContain("repository/x");
    expect(line).not.toContain("project/");
    expect(line).toContain("use one of these");
    expect(notFoundLine("zz")).toBe('no automation named "zz" — /automations to list');
  });
});

// ---------------------------------------------------------------------------- handlers

describe("handlers", () => {
  function makeDeps(stateDir: string, cwd: string, over: Partial<CommandDeps> = {}): CommandDeps {
    const spawned: string[][] = [];
    const deps: CommandDeps = {
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      runtime,
      now: () => NOW,
      home: HOME,
      cwd,
      spawnFire: (args) => {
        spawned.push(args);
        return 0;
      },
      ...over,
    };
    (deps as CommandDeps & { spawned: string[][] }).spawned = spawned;
    return deps;
  }

  function spawnedOf(deps: CommandDeps): string[][] {
    return (deps as CommandDeps & { spawned: string[][] }).spawned;
  }

  it("lists via handleList", async () => {
    const dir = tempDir("pi-h-list-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    const out = await handleList(deps, r);
    expect(out.lines.join("\n")).toContain("stale-pr-nudge");
  });

  it("refuses to run an automation with no manual trigger", async () => {
    const dir = tempDir("pi-h-nomanual-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    const out = await handleRun(deps, r, "docs-drift");
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toContain("has no manual trigger");
    expect(spawnedOf(deps)).toHaveLength(0);
  });

  it("refuses to run a disabled automation", async () => {
    const dir = tempDir("pi-h-disabled-");
    const deps = makeDeps(dir, fixtureHome);
    const r = await refresh({ ...deps, cwd: fixtureHome });
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir, deps.trust);
    const out = await handleRun(deps, { ...r, statuses }, "standup-notes");
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toContain("enabled: false");
  });

  it("asks for consent before running an unconsented repository automation", async () => {
    const dir = tempDir("pi-h-consent-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    const out = await handleRun(deps, r, "stale-pr-nudge");

    expect(out.consent?.andRun).toBe(true);
    expect(spawnedOf(deps)).toHaveLength(0);
    const preview = out.consent?.preview.join("\n") ?? "";
    expect(preview).toContain("Arm and run stale-pr-nudge");
    expect(preview).toContain("scripts/list_stale.js");
    expect(preview).toContain("Scripts run with your permissions.");
  });

  it("spawns a run for an armed automation", async () => {
    const dir = tempDir("pi-h-run-");
    const deps = makeDeps(dir, F.projectRoot);
    const l = locate(F.projectAutomations, "repository", "stale-pr-nudge");
    deps.trust.arm(l, digestOf(l), {}, NOW, 0);

    const r = await refresh(deps);
    const out = await handleRun(deps, r, "stale-pr-nudge");
    expect(out.exitCode).toBe(0);
    expect(spawnedOf(deps)[0]).toEqual([l.key, "--manual"]);
  });

  it("refuses a manual run while one is already going", async () => {
    const dir = tempDir("pi-h-running-");
    const deps = makeDeps(dir, F.projectRoot);
    const l = locate(F.projectAutomations, "repository", "stale-pr-nudge");
    deps.trust.arm(l, digestOf(l), {}, NOW, 0);
    acquireRunLock(
      dir,
      runLockInfo({
        key: l.key,
        runId: "r",
        timeoutMs: 600_000,
        postHooks: 0,
        trigger: "schedule",
        now: NOW,
      }),
    );

    const r = await refresh(deps);
    const out = await handleRun(deps, r, "stale-pr-nudge");
    expect(out.exitCode).toBe(10);
    expect(out.lines[0]).toMatch(/^still running since /);
    expect(spawnedOf(deps)).toHaveLength(0);
  });

  it("arms a repository automation and registers its root", async () => {
    const dir = tempDir("pi-h-arm-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    const out = await handleArm(deps, r, "stale-pr-nudge");
    expect(out.consent).toBeTruthy();

    const lines = applyArm(deps, out.consent?.located as Located);
    expect(lines[0]).toContain("stale-pr-nudge armed");
    expect(deps.state.roots).toContain(path.resolve(F.projectRoot));

    const again = await refresh(deps);
    expect(again.statuses.find((s) => s.name === "stale-pr-nudge")?.state).toBe("armed");
  });

  /** A host whose user root is the fixture's, so refresh finds the user automations there. */
  function userHost(): { home: string; agentDir: string } {
    return { home: path.join(fixtureHome, "user"), agentDir: tempDir("pi-h-agent-") };
  }

  it("holds a newly found user automation off, arms it after the preview, and disarms it on change", async () => {
    const dir = tempDir("pi-h-armuser-");
    const deps = makeDeps(dir, fixtureHome, { host: userHost() });
    const r = await refresh(deps);
    const found = r.statuses.find((s) => s.name === "daily-briefing");
    expect(found?.state).toBe("off");
    expect(found?.reason).toBe("not armed — /automations arm daily-briefing");

    const out = await handleArm(deps, r, "daily-briefing");
    const preview = out.consent?.preview.join("\n") ?? "";
    expect(preview).toContain("Arm daily-briefing");
    expect(preview).toContain("scripts/overnight_counts.js");
    expect(applyArm(deps, out.consent?.located as Located)[0]).toContain("daily-briefing armed");
    // Consent for your own automation lasts until its bytes change; only repository consent expires.
    expect(deps.trust.record(out.consent?.located as Located)?.expiresAt).toBeUndefined();
    expect((await refresh(deps)).statuses.find((s) => s.name === "daily-briefing")?.state).toBe("armed");

    writeFileSync(path.join(F.userRoot, "daily-briefing", "scripts", "overnight_counts.js"), "console.log('x');\n");
    const changed = (await refresh(deps)).statuses.find((s) => s.name === "daily-briefing");
    expect(changed?.state).toBe("off");
    expect(changed?.reason).toBe(
      "changed since armed: scripts/overnight_counts.js — /automations arm daily-briefing",
    );
  });

  it("asks for consent before running an unarmed user automation, as for a repository one", async () => {
    const dir = tempDir("pi-h-runuser-");
    const deps = makeDeps(dir, fixtureHome, { host: userHost() });
    const r = await refresh(deps);
    const out = await handleRun(deps, r, "daily-briefing");

    expect(out.consent?.andRun).toBe(true);
    expect(out.consent?.preview[0]).toContain("Arm and run daily-briefing");
    expect(spawnedOf(deps)).toHaveLength(0);
  });

  it("disarms a repository automation and a user one alike", async () => {
    const dir = tempDir("pi-h-disarm-");
    const deps = makeDeps(dir, F.projectRoot, { host: userHost() });
    const project = locate(F.projectAutomations, "repository", "stale-pr-nudge");
    const user = locate(F.userRoot, "user", "daily-briefing");
    deps.trust.arm(project, digestOf(project), {}, NOW, 0);
    deps.trust.arm(user, digestOf(user), {}, NOW, 0);

    const r = await refresh(deps);
    for (const [name, l] of [["stale-pr-nudge", project], ["daily-briefing", user]] as const) {
      const out = await handleDisarm(deps, r, name);
      expect(out.lines[0]).toBe(`${name} disarmed — it stays listed, and will not run`);
      expect(deps.trust.isArmed(l, NOW)).toBe(false);
    }
  });

  it("keeps a user automation armed across disable and enable", async () => {
    const dir = tempDir("pi-h-toggle-");
    const deps = makeDeps(dir, fixtureHome, { host: userHost() });
    const l = locate(F.userRoot, "user", "daily-briefing");
    deps.trust.arm(l, digestOf(l), {}, NOW, 0);

    expect((await handleEnable(deps, await refresh(deps), "daily-briefing", false)).lines[0]).toBe("daily-briefing disabled");
    expect((await refresh(deps)).statuses.find((s) => s.name === "daily-briefing")?.state).toBe("disabled");
    expect((await handleEnable(deps, await refresh(deps), "daily-briefing", true)).lines[0]).toBe("daily-briefing enabled");
    expect((await refresh(deps)).statuses.find((s) => s.name === "daily-briefing")?.state).toBe("armed");
  });

  it("says a user automation it enables is still not armed", async () => {
    const dir = tempDir("pi-h-enable-unarmed-");
    const deps = makeDeps(dir, fixtureHome, { host: userHost() });
    const out = await handleEnable(deps, await refresh(deps), "standup-notes", true);
    expect(out.lines[0]).toBe("standup-notes enabled — not armed yet: /automations arm standup-notes");
    expect((await refresh(deps)).statuses.find((s) => s.name === "standup-notes")?.state).toBe("off");
  });

  it("disables a user automation by editing the one line", async () => {
    const dir = tempDir("pi-h-disable-");
    const deps = makeDeps(dir, fixtureHome);
    const statuses = await statusesFor([{ path: F.userRoot, scope: "user" }], dir, deps.trust);
    const r = { ...(await refresh(deps)), statuses };

    const before = readFileSync(path.join(F.userRoot, "daily-briefing", "AUTOMATION.md"), "utf8");
    const out = await handleEnable(deps, r, "daily-briefing", false);
    expect(out.lines[0]).toBe("daily-briefing disabled");

    const after = readFileSync(path.join(F.userRoot, "daily-briefing", "AUTOMATION.md"), "utf8");
    expect(after).toContain("enabled: false");
    // Only one line moved; the rest of the file is byte-identical.
    expect(after.split("\n").filter((l) => !l.startsWith("enabled:"))).toEqual(
      before.split("\n").filter((l) => !l.startsWith("enabled:")),
    );
  });

  it("refuses to write enabled into a repository automation", async () => {
    const dir = tempDir("pi-h-disableproject-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    const out = await handleEnable(deps, r, "stale-pr-nudge", false);
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toBe(
      "enabled is set in the file — edit and commit; /automations disarm keeps it off on this machine",
    );
  });

  it("shows the run log, newest last, and as JSON on request", async () => {
    const dir = tempDir("pi-h-log-");
    const deps = makeDeps(dir, F.projectRoot);
    const l = locate(F.projectAutomations, "repository", "stale-pr-nudge");
    appendRecord(dir, {
      id: "r1",
      key: l.key,
      name: l.automation.name,
      scope: "repository",
      root: l.root.path,
      trigger: "schedule",
      late: false,
      recordedAt: NOW.toISOString(),
      startedAt: new Date(NOW.getTime() - 552_000).toISOString(),
      endedAt: NOW.toISOString(),
      outcome: "ok",
      model: "anthropic/claude-sonnet-4-5:low",
      output: { text: "Nudged 3 stale pull requests." },
    });

    const r = await refresh(deps);
    const out = await handleLog(deps, r, "stale-pr-nudge", 10, false);
    expect(out.lines[0]).toContain("ok");
    expect(out.lines[0]).toContain("9m12s");
    // The line tells you what the automation did. The model and the session path are still on the
    // record — `--json` carries the whole thing — they are just not what a person came to read.
    expect(out.lines[0]).toContain("Nudged 3 stale pull requests.");

    const json = await handleLog(deps, r, "stale-pr-nudge", 10, true);
    const parsed = JSON.parse(json.lines[0] as string);
    expect(parsed.id).toBe("r1");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5:low");
  });

  it("says so when an automation has never run", async () => {
    const dir = tempDir("pi-h-lognone-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    const out = await handleLog(deps, r, "release-notes");
    expect(out.lines[0]).toBe("release-notes has not run yet");
  });

  it("checks one automation in detail", async () => {
    const dir = tempDir("pi-h-check-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    const out = await handleCheck(deps, r, "stale-pr-nudge");
    const text = out.lines.join("\n");
    expect(text).toContain("stale-pr-nudge  off");
    expect(text).toContain("scope         repository");
    expect(text).toContain("digest        sha256:");
    expect(text).toContain("interpreter   scripts/list_stale.js");
    expect(text).toContain("schedule      0 */4 * * MON-FRI");
    expect(out.lines.filter((l) => l.includes("next          "))).toHaveLength(3);
  });

  it("checks everything when given no name", async () => {
    const dir = tempDir("pi-h-checkall-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    const out = await handleCheck(deps, r, undefined);
    expect(out.lines.length).toBeGreaterThan(1);
    expect(out.lines.join("\n")).toContain("stale-pr-nudge  off");
  });

  it("reports a missing name once, not as a crash", async () => {
    const dir = tempDir("pi-h-missing-");
    const deps = makeDeps(dir, F.projectRoot);
    const r = await refresh(deps);
    for (const out of [
      await handleRun(deps, r, "nope"),
      await handleArm(deps, r, "nope"),
      await handleDisarm(deps, r, "nope"),
      await handleLog(deps, r, "nope"),
      await handleCheck(deps, r, "nope"),
    ]) {
      expect(out.exitCode).toBe(2);
      expect(out.lines[0]).toBe('no automation named "nope" — /automations to list');
    }
  });

  it("names every subcommand in help", () => {
    const text = helpLines().join("\n");
    for (const verb of [
      "run",
      "arm",
      "disarm",
      "enable",
      "disable",
      "log",
      "check",
      "report",
      "watcher",
      "help",
    ]) {
      expect(text).toContain(`/automations ${verb}`);
    }
  });
});

describe("consentPreview", () => {
  it("shows the schedule, model, timeout, scripts and the warning", async () => {
    const dir = tempDir("pi-preview-");
    const trust = new Trust(dir);
    const statuses = await statusesFor(
      [{ path: F.projectAutomations, scope: "repository" }],
      dir,
      trust,
    );
    const s = statuses.find((x) => x.name === "stale-pr-nudge") as Status;
    const l = locate(F.projectAutomations, "repository", "stale-pr-nudge");

    const deps = {
      config: DEFAULTS,
      stateDir: dir,
      trust,
      state: new State(dir),
      now: () => NOW,
      home: HOME,
      cwd: F.projectRoot,
      spawnFire: () => 0,
    } as CommandDeps;

    const text = consentPreview(s, l, deps).join("\n");
    expect(text).toContain("Arm stale-pr-nudge");
    expect(text).toContain("0 */4 * * MON-FRI · America/Los_Angeles · catch-up skip");
    expect(text).toContain("timeout       20m (host default)");
    // Scripts are shown with the exact command that will run them.
    expect(text).toMatch(/pre {2}\[0\] script {2}scripts\/list_stale\.js/);
    expect(text).toContain("prompt");
    expect(text).toContain("This arms a schedule on this machine with your credentials.");
  });
});

describe("logLine", () => {
  it("renders one line per record", () => {
    const line = logLine({
      id: "r",
      key: "k",
      name: "n",
      scope: "user",
      root: "/r",
      trigger: "schedule",
      late: false,
      recordedAt: "2026-09-17T07:09:59.000Z",
      startedAt: "2026-09-17T07:00:47.000Z",
      endedAt: "2026-09-17T07:09:59.000Z",
      outcome: "ok",
      model: "anthropic/claude-sonnet-4-5:low",
      output: { text: "12 new, 3 urgent. Nothing blocking." },
      session: { file: "/s/f.jsonl", id: "i" },
    });
    // Local time, the same clock as every other screen — never the record's UTC.
    const end = new Date("2026-09-17T07:09:59.000Z");
    const two = (n: number) => String(n).padStart(2, "0");
    expect(line).toContain(`${end.getFullYear()}-${two(end.getMonth() + 1)}-${two(end.getDate())} ${two(end.getHours())}:${two(end.getMinutes())}`);
    expect(localStamp("2026-09-17T07:09:59.000Z")).toBe(line.slice(0, 16));
    expect(line).toContain("ok");
    expect(line).toContain("9m12s");
    // It ends with what the run SAID.
    expect(line).toContain("12 new, 3 urgent. Nothing blocking.");
    expect(line).not.toContain("/s/f.jsonl");
    expect(line).not.toContain("anthropic/claude-sonnet-4-5:low");
  });

  it("includes the reason for a skipped run", () => {
    const line = logLine({
      id: "r",
      key: "k",
      name: "n",
      scope: "user",
      root: "/r",
      trigger: "schedule",
      late: false,
      recordedAt: "2026-09-17T07:00:00.000Z",
      outcome: "skipped",
      reason: "still running since 06:00",
    });
    expect(line).toContain("skipped");
    expect(line).toContain("still running since 06:00");
  });
});
