// A new extension against an old cached dist. pi re-transpiles `extensions/automations.ts` when it
// reloads, while `dist/index.js` stays in node's module cache from when the session started.

import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createFakeContext, createFakePi, saidBy } from "./helpers/fake-pi.js";
import { cleanupTempDirs, tempDir, trackTempDir } from "./helpers/temp.js";

const FAKE = vi.hoisted(() => ({ home: "", spawns: 0 }));

/** The symbol a NEW extension calls that an OLD dist cannot have. */
const NEWEST = ["createAutomationsExtension"];

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  if (!FAKE.home) {
    FAKE.home = fs.mkdtempSync(nodePath.join(actual.tmpdir(), "pi-stale-"));
    fs.mkdirSync(nodePath.join(FAKE.home, ".agents", "automations"), { recursive: true });
    fs.mkdirSync(nodePath.join(FAKE.home, "fake-agent-dir"), { recursive: true });
  }
  const homedir = () => FAKE.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => path.join(FAKE.home, "fake-agent-dir"),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = () => {
    FAKE.spawns++;
    throw new Error("a stale-dist session must never spawn a run");
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

/** The real dist, with the newest symbols present but `undefined`. */
vi.mock("../dist/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stale: Record<string, unknown> = { ...actual };
  for (const name of NEWEST) stale[name] = undefined;
  return stale;
});

// FAKE.home is made inside the `node:os` mock, where the temp helper cannot be imported.
afterAll(() => {
  if (FAKE.home) trackTempDir(FAKE.home);
  cleanupTempDirs();
});

async function loadExtension() {
  const mod = await import("../extensions/automations.js");
  return mod.default as (pi: unknown) => void;
}

describe("a new extension on an old dist", () => {
  it("proves the namespace really is missing them, so this file is not vacuous", async () => {
    const dist = (await import("../dist/index.js")) as Record<string, unknown>;
    for (const name of NEWEST) expect(dist[name], name).toBeUndefined();
    // And something old is still there, so the mock did not simply empty the module.
    expect(typeof dist.stateDir).toBe("function");
  });

  it("registers without throwing", async () => {
    const register = await loadExtension();
    const pi = createFakePi();
    // Construction is where a missing symbol bites: it runs the moment pi loads the extension, long
    // before any handler could catch anything.
    expect(() => register(pi.api)).not.toThrow();
  });

  it("registers nothing it has no library for", async () => {
    const register = await loadExtension();
    const pi = createFakePi();
    register(pi.api);
    // With no library there is nothing to register anything against, and a half-live session that
    // silently does nothing is worse than one that says why. The session_start handler that carries
    // the message is the only thing installed.
    expect(pi.commands.size).toBe(0);
    expect(pi.shortcuts.size).toBe(0);
    expect(pi.events.has("session_start")).toBe(true);
  });

  it("reaches its session_start handler and says what to do", async () => {
    const register = await loadExtension();
    const pi = createFakePi();
    register(pi.api);

    const c = createFakeContext({ mode: "tui", hasUI: true, cwd: tempDir("pi-stale-cwd-") });
    await pi.emit("session_start", {}, c.ctx);

    const said = saidBy(c);
    // The whole point: the person is told, in plain words, that one restart fixes it.
    expect(said).toContain("restart pi to pick it up");
  });

  it("names the symbols that are actually missing", async () => {
    const register = await loadExtension();
    const pi = createFakePi();
    register(pi.api);

    const c = createFakeContext({ mode: "tui", hasUI: true, cwd: tempDir("pi-stale-cwd-") });
    await pi.emit("session_start", {}, c.ctx);

    const said = saidBy(c);
    for (const name of NEWEST) expect(said).toContain(name);
  });

  it("starts no run while degraded", async () => {
    const register = await loadExtension();
    register(createFakePi().api);
    // A degraded session watches nothing; it must not compensate by launching anything either.
    expect(FAKE.spawns).toBe(0);
  });
});
