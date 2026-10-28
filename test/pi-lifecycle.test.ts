/** The extension's lifecycle, driven. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { captureStdout, createFakeContext, createFakePi, saidBy } from "./helpers/fake-pi.js";
import { cleanupTempDirs, tempDir, trackTempDir } from "./helpers/temp.js";

const FAKE = vi.hoisted(() => ({ home: "", spawns: [] as Array<{ file: string; args: unknown }> }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  if (!FAKE.home) {
    FAKE.home = fs.mkdtempSync(nodePath.join(actual.tmpdir(), "pi-lifehome-"));
    fs.mkdirSync(nodePath.join(FAKE.home, ".agents", "automations"), { recursive: true });
    fs.mkdirSync(nodePath.join(FAKE.home, "fake-agent-dir"), { recursive: true });
  }
  const homedir = () => FAKE.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => path.join(FAKE.home, "fake-agent-dir"),
}));

/** The lazy Pi loader, refused. */
vi.mock("../src/pi-module.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pi-module.js")>();
  return {
    ...actual,
    importPi: async () => {
      throw new Error("pi-lifecycle tests must never load the pi SDK");
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (file: string, args: unknown) => {
    FAKE.spawns.push({ file, args });
    throw new Error("pi-lifecycle tests must never spawn a run");
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

// FAKE.home is made inside the `node:os` mock, where the temp helper cannot be imported.
afterAll(() => {
  if (FAKE.home) trackTempDir(FAKE.home);
  cleanupTempDirs();
});

// These tests boot the real extension, sometimes twice, and each boot discovers, parses and
// computes statuses for a fixture repository.
vi.setConfig({ testTimeout: 30_000 });

async function boot() {
  const mod = await import("../extensions/automations.js");
  const pi = createFakePi();
  (mod.default as (pi: unknown) => void)(pi.api);
  return pi;
}

function repoAutomation(name: string): { repo: string } {
  const repo = tempDir("pi-life-repo-");
  const dir = path.join(repo, ".agents", "automations", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(repo, ".git"), "gitdir: nowhere\n");
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: ${name}\ndescription: A test automation.\non:\n  manual: true\n---\n\nDo the thing.\n`,
  );
  return { repo };
}

/** How many interval timers node is currently holding. */
function liveIntervals(): number {
  // `process.getActiveResourcesInfo` reports one entry per live handle; intervals appear as
  // "Timeout". It is the only way to see a timer the extension never handed back.
  return (process as unknown as { getActiveResourcesInfo(): string[] })
    .getActiveResourcesInfo()
    .filter((r) => r === "Timeout").length;
}

describe("reload", () => {
  it("a second instance registers its own surfaces without disturbing the first", async () => {
    const a = repoAutomation("reload-one");
    const first = await boot();
    const c1 = createFakeContext({ mode: "tui", cwd: a.repo });
    await captureStdout(() => first.emit("session_start", {}, c1.ctx));

    const second = await boot();
    const c2 = createFakeContext({ mode: "tui", cwd: a.repo });
    await captureStdout(() => second.emit("session_start", {}, c2.ctx));

    expect([...first.commands.keys()]).toEqual(["automations"]);
    expect([...second.commands.keys()]).toEqual(["automations"]);
    // Each instance holds its own registry and renderer; neither reaches into the other.
    expect(first.renderers).not.toBe(second.renderers);
  });

  it("an old instance holding a dead context does not throw when its session ends", async () => {
    const a = repoAutomation("reload-dead");
    const pi = await boot();
    const live = createFakeContext({ mode: "tui", cwd: a.repo });
    await captureStdout(() => pi.emit("session_start", {}, live.ctx));

    // After a reload the OLD closure still holds a ctx whose session is gone: touching its UI
    // throws. Shutdown must absorb that rather than propagating it.
    const dead = createFakeContext({ mode: "tui", cwd: a.repo, uiDead: true });
    await pi.emit("session_start", {}, dead.ctx);
    await expect(pi.emit("session_shutdown", {}, dead.ctx)).resolves.toBeUndefined();
  });

  it("stops touching the UI after the first failure rather than throwing once per event", async () => {
    const a = repoAutomation("reload-quiet");
    const pi = await boot();
    const dead = createFakeContext({ mode: "tui", cwd: a.repo, uiDead: true });

    await expect(captureStdout(() => pi.emit("session_start", {}, dead.ctx))).resolves.toBeTypeOf(
      "string",
    );
    await expect(pi.press("ctrl+alt+a", dead.ctx)).resolves.toBeUndefined();
    await expect(pi.emit("session_shutdown", {}, dead.ctx)).resolves.toBeUndefined();
  });
});

describe("disposal", () => {
  it("leaves no interval behind after shutdown", async () => {
    const a = repoAutomation("dispose-timers");
    const before = liveIntervals();

    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo });
    await captureStdout(() => pi.emit("session_start", {}, c.ctx));
    await pi.emit("session_shutdown", {}, c.ctx);

    expect(liveIntervals()).toBeLessThanOrEqual(before);
  });

  it("clears the footer and the widget it painted", async () => {
    const a = repoAutomation("dispose-footer");
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo });

    await captureStdout(() => pi.emit("session_start", {}, c.ctx));
    await pi.emit("session_shutdown", {}, c.ctx);

    // The last thing said about the status line is that there is nothing to say.
    expect(c.statuses.at(-1)).toEqual({ key: "automations", value: undefined });
    // Every widget update is keyed the same way, so nothing else's surface is cleared.
    expect(c.widgets.every((w) => w.key === "automations")).toBe(true);
  });

  it("never touches a run on the way out", async () => {
    const a = repoAutomation("dispose-runs");
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo });

    await captureStdout(() => pi.emit("session_start", {}, c.ctx));
    FAKE.spawns.length = 0;
    await pi.emit("session_shutdown", {}, c.ctx);

    // Shutdown stops watching. An attached child keeps its own lock, record and log.
    expect(FAKE.spawns).toEqual([]);
  });

  it("is idempotent — a second shutdown is harmless", async () => {
    const a = repoAutomation("dispose-twice");
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo });

    await captureStdout(() => pi.emit("session_start", {}, c.ctx));
    await pi.emit("session_shutdown", {}, c.ctx);
    await expect(pi.emit("session_shutdown", {}, c.ctx)).resolves.toBeUndefined();
  });
});

describe("a dist older than the extension", () => {
  it("depends on exactly one dist export, and it exists", async () => {
    /** The load-time freshness check. */
    const dist = await import("../src/index.js");
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(path.join(import.meta.dirname, "..", "extensions", "automations.ts"), "utf8"),
    );
    const named = [...src.matchAll(/^import \{ (\w+) \} from "\.\.\/dist\/index\.js";$/gm)].map(
      (m) => m[1] as string,
    );

    expect(named, "the entry should import exactly one symbol from dist/index.js").toHaveLength(1);
    expect(Object.keys(dist)).toContain(named[0]);
  });

  it("warns once per session, not once per event", async () => {
    const a = repoAutomation("stale-warn");
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo });

    await captureStdout(() => pi.emit("session_start", {}, c.ctx));
    await captureStdout(() => pi.emit("session_start", {}, c.ctx));

    const warnings = c.notifications.filter((n) => n.text.includes("restart pi to pick it up"));
    expect(warnings.length).toBeLessThanOrEqual(1);
  });

  it("degrades with one actionable line when the library is too old to use", async () => {
    // The real degraded path, driven directly. It cannot be reached through the default export
    // here, because the dist this test imports is current — which is the point: the branch exists
    // for a session whose dist is not.
    const { registerUnavailable } = await import("../extensions/automations.js");
    const pi = createFakePi();
    registerUnavailable(pi.api as never);

    const c = createFakeContext({ mode: "tui", cwd: tempDir("pi-stale-ui-") });
    const out = await captureStdout(() => pi.emit("session_start", {}, c.ctx));

    // One line, naming both the missing symbol and the fix.
    expect(c.notifications).toHaveLength(1);
    expect(c.notifications[0]?.text).toContain("createAutomationsExtension");
    expect(c.notifications[0]?.text).toContain("restart pi to pick it up");
    // It degrades: nothing is thrown and nothing else is registered.
    expect(out).toBe("");
  });

  it("says it once, not once per session start", async () => {
    const { registerUnavailable } = await import("../extensions/automations.js");
    const pi = createFakePi();
    registerUnavailable(pi.api as never);

    const c = createFakeContext({ mode: "tui", cwd: tempDir("pi-stale-twice-") });
    await captureStdout(() => pi.emit("session_start", {}, c.ctx));
    await captureStdout(() => pi.emit("session_start", {}, c.ctx));

    expect(c.notifications).toHaveLength(1);
  });

  it("still says it with no UI, on stderr, leaving stdout clean for --json", async () => {
    const { registerUnavailable } = await import("../extensions/automations.js");
    const pi = createFakePi();
    registerUnavailable(pi.api as never);

    const c = createFakeContext({ mode: "json", cwd: tempDir("pi-stale-headless-") });
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      errors.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    let out: string;
    try {
      out = await captureStdout(() => pi.emit("session_start", {}, c.ctx));
    } finally {
      process.stderr.write = write;
    }

    expect(errors.join("")).toContain("restart pi to pick it up");
    // And the document a caller parses is untouched.
    expect(out).toBe("");
    expect(c.notifications).toEqual([]);
  });
});

describe("overlays", () => {
  it("refuses to stack a second window or list", async () => {
    const a = repoAutomation("overlay-stack");
    const pi = await boot();
    // Two shortcut presses in a row. The first opens; the second must find one already open and do
    // nothing rather than stacking.
    const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: ["q"] });
    await captureStdout(() => pi.press("ctrl+alt+a", c.ctx));
    const afterFirst = c.customCalls.length;
    await captureStdout(() => pi.press("ctrl+alt+a", c.ctx));

    expect(c.customCalls.length - afterFirst).toBeLessThanOrEqual(1);
  });

  it("a background refresh never opens one", async () => {
    const a = repoAutomation("overlay-background");
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo });

    await captureStdout(() => pi.emit("session_start", {}, c.ctx));

    // session_start paints the footer. It must never take the screen.
    expect(c.customCalls).toHaveLength(0);
  });
});

describe("what a session is told at start", () => {
  it("names an invalid automation", async () => {
    const repo = tempDir("pi-life-repo-");
    const dir = path.join(repo, ".agents", "automations", "broken-one");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(repo, ".git"), "gitdir: nowhere\n");
    writeFileSync(
      path.join(dir, "AUTOMATION.md"),
      "---\nname: broken-one\ndescription: d\non:\n  manual: true\nretry: 3\n---\n\nBody.\n",
    );

    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: repo });
    await captureStdout(() => pi.emit("session_start", {}, c.ctx));

    expect(saidBy(c)).toContain("broken-one");
  });

  it("says nothing at all when there is no UI", async () => {
    const a = repoAutomation("quiet-start");
    const pi = await boot();
    const c = createFakeContext({ mode: "print", cwd: a.repo });

    await captureStdout(() => pi.emit("session_start", {}, c.ctx));

    expect(c.notifications).toHaveLength(0);
    expect(c.statuses).toHaveLength(0);
  });

  it("never lets discovery stop a session from starting", async () => {
    // A cwd that does not exist is the cheapest way to make discovery unhappy.
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: path.join(FAKE.home, "no-such-directory") });

    await expect(captureStdout(() => pi.emit("session_start", {}, c.ctx))).resolves.toBeTypeOf(
      "string",
    );
  });
});
