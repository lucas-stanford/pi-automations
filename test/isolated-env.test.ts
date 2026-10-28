/** The isolation the rest of the suite depends on, checked against the case that defeated it. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { automationIn, isolatedHome, proveIsolated, resolveIn, within } from "./helpers/isolated-env.js";
import { cleanupTempDirs, tempDir, trackTempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

/**
 * Resolve paths in a child given an arbitrary environment — the shape the helper guards against.
 */
function resolveWith(env: NodeJS.ProcessEnv, cwd: string): { stateDir: string; roots: string[] } {
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      "const p=require(process.argv[1]);const h=p.ambientHostRoots();" +
        "process.stdout.write(JSON.stringify({stateDir:p.stateDir(),roots:p.userRootsFor(h).map(r=>r.path)}))",
      path.join(REPO, "dist", "paths.js"),
    ],
    { encoding: "utf8", env, cwd, windowsHide: true, timeout: 60_000 },
  );
  return JSON.parse(out.trim()) as { stateDir: string; roots: string[] };
}

describe("an owned home", () => {
  it("puts state and discovery inside the fixture", () => {
    const iso = isolatedHome();
    automationIn(iso, "inside", "on:\n  manual: true\n");

    const resolved = proveIsolated(iso);

    expect(resolved.stateDir.toLowerCase()).toContain(iso.home.toLowerCase());
    expect(resolved.roots.length).toBeGreaterThan(0);
    for (const r of resolved.roots) expect(r.toLowerCase()).toContain(iso.home.toLowerCase());
  });

  it("carries no inherited path override", () => {
    const iso = isolatedHome();
    for (const k of ["HOME", "USERPROFILE", "PI_AGENT_DIR"]) {
      expect(iso.env[k]).toBeTruthy();
      expect(String(iso.env[k]).toLowerCase()).toContain(iso.home.toLowerCase());
    }
    // Built by removal, not by layering: nothing from the caller can still point outward.
    expect(iso.env.PI_HOME).toBeUndefined();
    expect(iso.env.XDG_CONFIG_HOME).toBeUndefined();
  });
});

describe("negative controls — each of these used to pass silently", () => {
  it("an inherited PI_AGENT_DIR escapes a redirected HOME", () => {
    const iso = isolatedHome();
    const other = isolatedHome("pi-other-");
    const elsewhere = other.agentDir;

    const leaky = { ...iso.env, PI_AGENT_DIR: elsewhere };
    const resolved = resolveWith(leaky, iso.cwd);

    expect(within(other.home, resolved.stateDir)).toBe(true);
    expect(within(iso.home, resolved.stateDir)).toBe(false);

    expect(() => proveIsolated({ ...iso, env: leaky })).toThrow(/OUTSIDE the fixture/);
  });

  it("a name no code reads isolates nothing", () => {
    const iso = isolatedHome();
    const other = isolatedHome("pi-other-");
    // The override points at a second owned home, so a name nothing honours leaves resolution there
    // rather than at the operator's.
    const madeUp = { ...other.env, PI_AUTOMATIONS_STATE_DIR: iso.stateDir, PI_AUTOMATIONS_ROOTS: iso.roots };

    expect(within(iso.home, resolveWith(madeUp, other.cwd).stateDir)).toBe(false);
    expect(() => proveIsolated({ ...iso, env: madeUp })).toThrow(/OUTSIDE the fixture/);
  });

  it("HOME alone, with PI_AGENT_DIR left pointing elsewhere, is refused", () => {
    const iso = isolatedHome();
    const other = isolatedHome("pi-other-");
    const homeOnly = { ...other.env, HOME: iso.home, USERPROFILE: iso.home, PI_AGENT_DIR: other.agentDir };

    expect(() => proveIsolated({ ...iso, env: homeOnly })).toThrow(/OUTSIDE the fixture/);
  });

  it("a SIBLING whose name merely extends the fixture name is refused", () => {
    // `<home>-outside` shares a string prefix with `<home>`, so a `startsWith` check accepts it
    // while state resolves to `..\\<home>-outside\\pi-automations`.
    const iso = isolatedHome();
    const sibling = trackTempDir(`${iso.home}-outside`);
    mkdirSync(sibling, { recursive: true });

    const resolved = resolveWith({ ...iso.env, PI_AGENT_DIR: sibling }, iso.cwd);
    expect(resolved.stateDir.toLowerCase().startsWith(iso.home.toLowerCase())).toBe(true);
    expect(within(iso.home, resolved.stateDir)).toBe(false);

    expect(() => proveIsolated({ ...iso, env: { ...iso.env, PI_AGENT_DIR: sibling } })).toThrow(
      /OUTSIDE the fixture/,
    );
  });

  it("containment is by segment, across roots", () => {
    const iso = isolatedHome();
    expect(within(iso.home, iso.home)).toBe(true);
    expect(within(iso.home, path.join(iso.home, "a", "b"))).toBe(true);
    expect(within(iso.home, `${iso.home}-outside`)).toBe(false);
    expect(within(iso.home, path.dirname(iso.home))).toBe(false);
    // A different root cannot be inside, whatever the names look like.
    const otherRoot = path.parse(iso.home).root === "C:\\\\" ? "D:\\\\x" : "/x";
    expect(within(iso.home, otherRoot)).toBe(false);
  });
});

describe("the guard is not vacuous", () => {
  it("accepts a correctly isolated environment", () => {
    const iso = isolatedHome();
    automationIn(iso, "ok", "on:\n  manual: true\n");
    expect(() => proveIsolated(iso)).not.toThrow();
  });

  it("removes an override the CALLER actually had", () => {
    // Set on this process, so `isolatedHome` has something real to remove — a control built from an
    // absent variable proves only that nothing was there.
    const saved = { agent: process.env.PI_AGENT_DIR, home: process.env.PI_HOME };
    const outside = tempDir("pi-caller-agent-");
    try {
      process.env.PI_AGENT_DIR = outside;
      process.env.PI_HOME = outside;

      const iso = isolatedHome();
      expect(iso.env.PI_AGENT_DIR).not.toBe(outside);
      expect(String(iso.env.PI_AGENT_DIR).toLowerCase()).toContain(iso.home.toLowerCase());
      expect(iso.env.PI_HOME).toBeUndefined();

      // And it actually holds in a child, which is where it matters.
      automationIn(iso, "ok", "on:\n  manual: true\n");
      expect(resolveIn(iso).stateDir.toLowerCase()).toContain(iso.home.toLowerCase());
    } finally {
      if (saved.agent === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = saved.agent;
      if (saved.home === undefined) delete process.env.PI_HOME;
      else process.env.PI_HOME = saved.home;
    }
  });

  it("catches a bad STATE directory even when discovery is fine", () => {
    // Isolates the state check: roots stay inside the fixture, so only the state assertion can
    // fail. A control where both are outside is satisfied by either one.
    const iso = isolatedHome();
    automationIn(iso, "ok", "on:\n  manual: true\n");
    const elsewhere = tempDir("pi-state-only-");

    const stateOut = { ...iso.env, PI_AGENT_DIR: elsewhere };
    const resolved = resolveIn({ ...iso, env: stateOut });

    expect(resolved.stateDir.toLowerCase()).toContain(elsewhere.toLowerCase());
    for (const r of resolved.roots) expect(r.toLowerCase()).toContain(iso.home.toLowerCase());
    expect(() => proveIsolated({ ...iso, env: stateOut })).toThrow(/state would resolve OUTSIDE/);
  });

  it("catches bad DISCOVERY even when state is fine", () => {
    // The mirror, and the more damaging half: records land in the fixture while the child walks
    // automations that belong to somebody else.
    const iso = isolatedHome("pi-iso-inside-");
    const foreign = isolatedHome("pi-iso-foreign-");
    automationIn(foreign, "not-ours", "on:\n  manual: true\n");

    // Home moves to the foreign fixture; `PI_AGENT_DIR` stays in ours, so state is still inside and
    // only the roots assertion can fail.
    const rootsOut = { ...iso.env, HOME: foreign.home, USERPROFILE: foreign.home };
    const resolved = resolveIn({ ...iso, env: rootsOut });

    expect(within(iso.home, resolved.stateDir)).toBe(true);
    // Discovery really did leave, and it really did find something to walk.
    expect(resolved.roots.length).toBeGreaterThan(0);
    expect(resolved.roots.some((r) => !within(iso.home, r))).toBe(true);
    expect(resolved.roots.some((r) => within(foreign.home, r))).toBe(true);
    expect(() => proveIsolated({ ...iso, env: rootsOut })).toThrow(/discovery would reach OUTSIDE/);
  });

  it("leaves the fixture on disk for inspection", () => {
    const iso = isolatedHome();
    expect(existsSync(iso.agentDir)).toBe(true);
    expect(existsSync(iso.roots)).toBe(true);
    expect(existsSync(iso.cwd)).toBe(true);
  });
});
