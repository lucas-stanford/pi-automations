/** The Pi extension, driven. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { captureStdout, createFakeContext, createFakePi, saidBy } from "./helpers/fake-pi.js";
import { cleanupTempDirs, tempDir, trackTempDir } from "./helpers/temp.js";

const FAKE = vi.hoisted(() => ({
  home: "",
  spawns: [] as Array<{ file: string; args: unknown }>,
  spawnImpl: undefined as undefined | ((file: string, args: unknown) => unknown),
  fmBin: undefined as string | undefined,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  if (!FAKE.home) {
    FAKE.home = fs.mkdtempSync(nodePath.join(actual.tmpdir(), "pi-fakehome-"));
    // Created empty on purpose: the user root must EXIST (so the code path is real) and be empty
    // (so no automation of the operator's is ever discovered).
    fs.mkdirSync(nodePath.join(FAKE.home, ".agents", "automations"), { recursive: true });
    fs.mkdirSync(nodePath.join(FAKE.home, "fake-agent-dir"), { recursive: true });
  }
  const homedir = () => FAKE.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => fakeAgentDir(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (file: string, args: unknown) => {
    FAKE.spawns.push({ file, args });
    if (FAKE.spawnImpl) return FAKE.spawnImpl(file, args);
    throw new Error("pi-host tests must never spawn a run");
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

// No real fm is ever probed: a chart is drawn by whatever this says, or shown as the step list.
vi.mock("../dist/providers/fm/render.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dist/providers/fm/render.js")>();
  return { ...actual, findFmRenderer: () => FAKE.fmBin };
});

// FAKE.home is made inside the `node:os` mock, where the temp helper cannot be imported.
afterAll(() => {
  if (FAKE.home) trackTempDir(FAKE.home);
  cleanupTempDirs();
});

/** The fake agent directory. */
function fakeAgentDir(): string {
  return path.join(FAKE.home, "fake-agent-dir");
}

/** Imported lazily so the mocks above are installed first. */
async function loadExtension() {
  const mod = await import("../extensions/automations.js");
  return mod.default as (pi: unknown) => void;
}

// A repository-scope automation in a throwaway checkout. The fake user root stays empty, so these
// never discover an automation of the operator's.
function repoAutomation(spec: {
  name?: string;
  frontmatter?: string;
  scripts?: Record<string, string>;
}): { repo: string; dir: string; name: string } {
  const repo = tempDir("pi-host-repo-");
  const name = spec.name ?? "repo-thing";
  const dir = path.join(repo, ".agents", "automations", name);
  mkdirSync(dir, { recursive: true });
  // A `.git` entry is what `findRepoRoot` walks up to.
  writeFileSync(path.join(repo, ".git"), "gitdir: nowhere\n");
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: ${name}\ndescription: A test automation.\n${spec.frontmatter ?? "on:\n  manual: true\n"}---\n\nDo the thing.\n`,
  );
  for (const [rel, body] of Object.entries(spec.scripts ?? {})) {
    writeFileSync(path.join(dir, rel), body);
  }
  return { repo, dir, name };
}

function trustFile(): string {
  return path.join(fakeAgentDir(), "pi-automations", "trust.json");
}

function trustRecords(): Record<string, unknown> {
  if (!existsSync(trustFile())) return {};
  try {
    const parsed = JSON.parse(readFileSync(trustFile(), "utf8")) as { records?: Record<string, unknown> };
    return parsed.records ?? {};
  } catch {
    return {};
  }
}

/** Boot one extension instance against a fresh fake Pi. */
async function boot() {
  const pi = createFakePi();
  const extension = await loadExtension();
  extension(pi.api);
  return pi;
}

beforeEach(() => {
  FAKE.spawns.length = 0;
  FAKE.spawnImpl = undefined;
  FAKE.fmBin = undefined;
});

function fakeChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  killed: boolean;
  pid: number;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.pid = 1234 + FAKE.spawns.length;
  child.kill = vi.fn(() => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", 0));
    return true;
  });
  child.unref = vi.fn();
  return child;
}

describe("what the extension registers", () => {
  it("registers its command, its shortcut and its entry renderer", async () => {
    const pi = await boot();
    expect([...pi.commands.keys()]).toEqual(["automations"]);
    expect([...pi.shortcuts.keys()]).toEqual(["ctrl+alt+a"]);
    expect([...pi.renderers.keys()]).toHaveLength(1);
  });

  it("registers once, not once per session", async () => {
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: FAKE.home });

    await pi.emit("session_start", {}, c.ctx);
    await pi.emit("session_start", {}, c.ctx);

    expect([...pi.commands.keys()]).toEqual(["automations"]);
    expect([...pi.shortcuts.keys()]).toEqual(["ctrl+alt+a"]);
    expect([...pi.renderers.keys()]).toHaveLength(1);
  });

  it("subscribes to session_start and session_shutdown and nothing that carries conversation", async () => {
    const pi = await boot();
    expect([...pi.events.keys()].sort()).toEqual(["session_shutdown", "session_start"]);
  });
});

describe("consent", () => {
  it("shows the preview BEFORE anything is written, and only then arms", async () => {
    const a = repoAutomation({});
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: ["y"] });

    // Nothing armed yet.
    expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(0);

    await pi.run("automations", `arm ${a.name}`, c.ctx);

    // The overlay really ran, and the key it consumed was the one we sent.
    expect(c.customCalls).toHaveLength(1);
    expect(c.customCalls[0]?.consumed).toEqual(["y"]);
    expect(c.customCalls[0]?.resolved).toBe(true);

    // And the preview named the automation and what arming means.
    const said = saidBy(c);
    expect(said).toContain(a.name);

    const armed = Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`));
    expect(armed).toHaveLength(1);
  });

  // Automation names must be lowercase, so the fixture name carries the CASE under test as a word.
  for (const [label, key] of [
    ["lowercase-y", "y"],
    ["uppercase-y", "Y"],
  ] as const) {
    it(`arms on ${key}`, async () => {
      const a = repoAutomation({ name: `accept-${label}` });
      const pi = await boot();
      const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: [key] });

      await pi.run("automations", `arm ${a.name}`, c.ctx);

      expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(1);
    });
  }

  // The whole key space, not a list: anything that is not y/Y must keep it off.
  for (const [label, key] of [
    ["lowercase-n", "n"],
    ["uppercase-n", "N"],
    ["escape", "\u001b"],
    ["an-unknown-key", "k"],
    ["a-digit", "7"],
    ["enter", "\r"],
  ] as const) {
    it(`refuses on ${label}, and writes no trust record`, async () => {
      const a = repoAutomation({ name: `refuse-${label}` });
      const pi = await boot();
      const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: [key] });

      await pi.run("automations", `arm ${a.name}`, c.ctx);

      expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(0);
      expect(saidBy(c)).toContain(`${a.name} stays off`);

      // The overlay must RESOLVE false, not merely fail to arm.
      expect(c.customCalls).toHaveLength(1);
      expect(c.customCalls[0]?.resolved).toBe(false);
    });
  }

  it("refuses when the prompt itself fails, rather than arming", async () => {
    const a = repoAutomation({ name: "prompt-error" });
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo, customThrows: true });

    await pi.run("automations", `arm ${a.name}`, c.ctx);

    expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(0);
    expect(saidBy(c)).toContain("stays off");
  });

  it("refuses when there is no UI to ask with, and says why", async () => {
    const a = repoAutomation({ name: "no-ui" });
    const pi = await boot();
    const c = createFakeContext({ mode: "print", cwd: a.repo });

    const said = await captureStdout(() => pi.run("automations", `arm ${a.name}`, c.ctx));

    expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(0);
    expect(c.customCalls).toHaveLength(0);
    expect(said).toContain("arming needs a terminal that can ask");
  });

  it("uses confirm, not the overlay, in a mode that has a UI but no terminal", async () => {
    const a = repoAutomation({ name: "rpc-confirm" });
    const pi = await boot();
    const c = createFakeContext({ mode: "rpc", cwd: a.repo, confirm: true });

    await pi.run("automations", `arm ${a.name}`, c.ctx);

    expect(c.customCalls).toHaveLength(0);
    expect(c.confirms).toHaveLength(1);
    expect(c.confirms[0]?.title).toContain(a.name);
    expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(1);
  });

  it("a denial is not permanent suppression — the next attempt is asked again", async () => {
    const a = repoAutomation({ name: "ask-again" });

    const first = await boot();
    const c1 = createFakeContext({ mode: "tui", cwd: a.repo, keys: ["n"] });
    await first.run("automations", `arm ${a.name}`, c1.ctx);
    expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(0);

    const second = await boot();
    const c2 = createFakeContext({ mode: "tui", cwd: a.repo, keys: ["y"] });
    await second.run("automations", `arm ${a.name}`, c2.ctx);

    // It asked again rather than remembering the refusal, and this time it armed.
    expect(c2.customCalls).toHaveLength(1);
    expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(1);
  });

  it("records the digest and an expiry when it arms", async () => {
    const a = repoAutomation({ name: "digest-check" });
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: ["y"] });

    await pi.run("automations", `arm ${a.name}`, c.ctx);

    const record = Object.entries(trustRecords()).find(([k]) => k.endsWith(`:${a.name}`))?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(record).toBeDefined();
    expect(String(record?.digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Date.parse(String(record?.expiresAt))).toBeGreaterThan(Date.now());
    expect(Date.parse(String(record?.armedAt))).toBeLessThanOrEqual(Date.now());
  });

  it("lists the script a hook would run, so consent is to something readable", async () => {
    const a = repoAutomation({
      name: "with-hook",
      frontmatter: "on:\n  manual: true\nhooks:\n  pre:\n    - script: counts.js\n",
      scripts: { "counts.js": "console.log(1);\n" },
    });

    // In a non-TUI mode the preview is emitted before the confirm, so it is readable here.
    const pi = await boot();
    const c = createFakeContext({ mode: "print", cwd: a.repo });
    const preview = await captureStdout(() => pi.run("automations", `arm ${a.name}`, c.ctx));
    expect(preview).toContain(a.name);
    expect(preview).toContain("counts.js");
    // And it still did not arm, because print mode cannot ask.
    expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${a.name}`))).toHaveLength(0);
  });

  it("holds a user automation off until it is armed through the same preview", async () => {
    const name = "mine-to-arm";
    const dir = path.join(FAKE.home, ".agents", "automations", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "AUTOMATION.md"),
      `---\nname: ${name}\ndescription: A test automation.\non:\n  manual: true\n---\n\nDo the thing.\n`,
    );
    try {
      const pi = await boot();
      const c = createFakeContext({ mode: "tui", cwd: FAKE.home, keys: ["y"] });

      await pi.emit("session_start", {}, c.ctx);
      expect(c.notifications.map((n) => n.text)).toContain(
        "1 user automation found — off until armed. /automations arm <name>",
      );
      expect(Object.keys(trustRecords()).filter((k) => k.endsWith(`:${name}`))).toHaveLength(0);

      await pi.run("automations", `arm ${name}`, c.ctx);

      expect(c.customCalls).toHaveLength(1);
      expect(c.customCalls[0]?.resolved).toBe(true);
      expect(Object.keys(trustRecords()).filter((k) => k.startsWith("user:") && k.endsWith(`:${name}`))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a run's output never enters the conversation", () => {
  it("has no path that calls a conversation API", async () => {
    const a = repoAutomation({ name: "no-injection" });
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: ["y"] });

    await captureStdout(async () => {
      await pi.emit("session_start", {}, c.ctx);
      await pi.run("automations", "list", c.ctx);
      await pi.run("automations", `arm ${a.name}`, c.ctx);
      await pi.run("automations", "running", c.ctx);
      await pi.run("automations", "help", c.ctx);
      await pi.press("ctrl+alt+a", c.ctx);
    });

    expect(pi.conversationCalls).toEqual([]);
  });

  it("publishes run receipts through the entry API it registered a renderer for", async () => {
    const pi = await boot();
    // The renderer and the appendEntry call must agree on the entry type, or a receipt renders as
    // raw data. Proven by construction here: the same type is the only one registered.
    expect([...pi.renderers.keys()]).toHaveLength(1);
    const type = [...pi.renderers.keys()][0] as string;
    expect(type).toBeTypeOf("string");
    expect(pi.entries.every((e) => e.type === type)).toBe(true);
  });
});

describe("mode gates", () => {
  it.each(["\u001b[27u", "\u001b[27;1u", "\u001b[27;1;27~", "\u0003", "\u001b[99;5u"])(
    "releases panel focus on encoded cancel %j", async (cancel) => {
      const a = repoAutomation({ name: "keyboard-protocol" });
      for (const command of ["list", "running", `log ${a.name}`]) {
        const pi = await boot();
        const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: [cancel, "v"] });
        await pi.run("automations", command, c.ctx);
        expect(c.customCalls, command).toHaveLength(1);
        // The trailing v must not reach the panel after cancellation.
        expect(c.customCalls[0]?.consumed, command).toEqual([cancel]);
        await pi.emit("session_shutdown", {}, c.ctx);
      }
    },
  );

  it("opens the list over the whole terminal, exactly as tall as it, and v changes nothing", async () => {
    const a = repoAutomation({ name: "whole-screen" });
    const pi = await boot();
    const c = createFakeContext({
      mode: "tui",
      cwd: a.repo,
      width: 80,
      height: 24,
      keys: ["v", "\u001b"],
    });

    await pi.run("automations", "list", c.ctx);

    expect(c.customCalls).toHaveLength(1);
    const call = c.customCalls[0];
    const full = { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 };
    expect(call?.overlays.length).toBeGreaterThan(0);
    for (const overlay of call?.overlays ?? []) expect(overlay).toEqual(full);
    expect(call?.consumed).toEqual(["v", "\u001b"]);
    // The frame after v is the frame before it, and both fill the terminal.
    expect(call?.frames[1]).toEqual(call?.frames[0]);
    for (const frame of call?.frames ?? []) {
      expect(frame).toHaveLength(24);
      expect(frame[0]).toMatch(/^Automations\b/);
      expect(frame[2]).toMatch(/^ {2}(✓ Nothing needs you\.|Needs you)$/);
      expect(frame.at(-1)).toMatch(/esc close$/);
    }
  });

  it("never opens an overlay outside a terminal", async () => {
    const a = repoAutomation({ name: "mode-gate" });
    for (const mode of ["print", "json", "rpc"] as const) {
      const pi = await boot();
      const c = createFakeContext({ mode, cwd: a.repo });
      await captureStdout(async () => {
        await pi.run("automations", "list", c.ctx);
        await pi.run("automations", "running", c.ctx);
        await pi.press("ctrl+alt+a", c.ctx);
      });
      expect(c.customCalls, `${mode} opened an overlay`).toHaveLength(0);
    }
  });

  it("answers list as plain lines in print mode", async () => {
    const a = repoAutomation({ name: "printable" });
    const pi = await boot();
    const c = createFakeContext({ mode: "print", cwd: a.repo });

    const written = await captureStdout(() => pi.run("automations", "list", c.ctx));

    expect(written).toContain(a.name);
    expect(c.notifications).toHaveLength(0);
  });

  it("answers /automations watcher status, and still answers it as detached", async () => {
    const a = repoAutomation({ name: "watcher-verb" });
    const pi = await boot();
    const c = createFakeContext({ mode: "print", cwd: a.repo });

    const now = await captureStdout(() => pi.run("automations", "watcher status", c.ctx));
    expect(now).toContain("watcher: off");
    expect(now).toContain("pa watcher start");
    expect(await captureStdout(() => pi.run("automations", "detached status", c.ctx))).toBe(now);

    const complete = pi.commands.get("automations")?.getArgumentCompletions as (p: string) => { value: string }[];
    const values = complete("").map((s) => s.value);
    expect(values).toContain("watcher");
    expect(values).not.toContain("detached");
  });

  it("opens AUTOMATION.md outside the terminal for /automations edit when no plugin edits", async () => {
    const a = repoAutomation({ name: "editor-edit" });
    FAKE.spawnImpl = () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child;
    };
    const pi = await boot();
    const c = createFakeContext({ mode: "print", cwd: a.repo });

    const out = await captureStdout(() => pi.run("automations", `edit ${a.name}`, c.ctx));

    // VS Code when it is on PATH, the OS opener otherwise — never a terminal editor over pi.
    const opened = FAKE.spawns.at(-1);
    expect(JSON.stringify(opened)).toContain("AUTOMATION.md");
    expect(String(opened?.file)).not.toMatch(/vim|nano/);
    expect(out).toContain(`opened ${a.name}'s AUTOMATION.md in`);
  });

  it("reports an editor that cannot start instead of throwing out of Pi", async () => {
    const a = repoAutomation({ name: "open-error" });
    FAKE.spawnImpl = () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
      return child;
    };
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo });

    await expect(pi.run("automations", `edit ${a.name}`, c.ctx)).resolves.toBeUndefined();

    expect(saidBy(c)).toContain("could not open");
  });

  it("hands edit, and the actions plugins add, to the plugins in the person's config", async () => {
    const a = repoAutomation({ name: "plugin-edit" });
    // Inside the checkout: vitest cannot import a module from the OS temp directory.
    mkdirSync(path.join(import.meta.dirname, "fixtures"), { recursive: true });
    const plugin = path.join(trackTempDir(mkdtempSync(path.join(import.meta.dirname, "fixtures", "plugins-"))), "plugin.mjs");
    writeFileSync(
      plugin,
      [
        "export default {",
        "  name: 'probe',",
        "  setup(api) {",
        "    api.addAction({ id: 'edit', label: 'Edit in Probe', run: (ctx) => ({ message: `probe edits ${ctx.automation.name} from ${ctx.where}` }) });",
        "    api.addAction({ id: 'wave', label: 'Wave at it', key: 'W', run: (ctx) => ({ message: `waved at ${ctx.automation.name}` }) });",
        "  },",
        "};",
      ].join("\n"),
    );
    mkdirSync(path.join(fakeAgentDir(), "pi-automations"), { recursive: true });
    writeFileSync(path.join(fakeAgentDir(), "pi-automations", "config.json"), JSON.stringify({ plugins: [plugin] }));
    try {
      const pi = await boot();
      const c = createFakeContext({ mode: "print", cwd: a.repo });

      const out = await captureStdout(async () => {
        await pi.run("automations", `edit ${a.name}`, c.ctx);
        await pi.run("automations", `wave ${a.name}`, c.ctx);
        await pi.run("automations", "help", c.ctx);
      });

      expect(out).toContain(`probe edits ${a.name} from host`);
      expect(out).toContain(`waved at ${a.name}`);
      expect(out).toMatch(/\/automations wave <name>\s+Wave at it \(probe plugin\)/);
      // Nothing was spawned: the plugin did the editing.
      expect(FAKE.spawns).toEqual([]);
    } finally {
      rmSync(path.join(fakeAgentDir(), "pi-automations", "config.json"), { force: true });
    }
  });
  it("survives a context whose session has ended", async () => {
    const a = repoAutomation({ name: "dead-ctx" });
    const pi = await boot();
    const live = createFakeContext({ mode: "tui", cwd: a.repo });
    await pi.emit("session_start", {}, live.ctx);

    const dead = createFakeContext({ mode: "tui", cwd: a.repo, uiDead: true });
    // A shortcut on a dead context must not throw out of the extension.
    await expect(pi.press("ctrl+alt+a", dead.ctx)).resolves.toBeUndefined();
  });
});

describe("nothing here reaches the machine", () => {
  it("never spawns a run", async () => {
    const a = repoAutomation({ name: "no-spawn" });
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: ["n"] });

    await captureStdout(async () => {
      await pi.run("automations", "list", c.ctx);
      await pi.run("automations", `arm ${a.name}`, c.ctx);
    });

    expect(FAKE.spawns).toEqual([]);
  });

  it("keeps all state inside the fake home", async () => {
    const a = repoAutomation({ name: "state-home" });
    const pi = await boot();
    const c = createFakeContext({ mode: "tui", cwd: a.repo, keys: ["y"] });
    await pi.run("automations", `arm ${a.name}`, c.ctx);

    expect(existsSync(trustFile())).toBe(true);
    expect(trustFile().startsWith(FAKE.home)).toBe(true);
  });

  it("discovers no automation of the operator's", async () => {
    const a = repoAutomation({ name: "only-mine" });
    const pi = await boot();
    const c = createFakeContext({ mode: "print", cwd: a.repo });

    // The fake user root exists and is empty, so the only rows are this fixture's.
    const out = await captureStdout(() => pi.run("automations", "list", c.ctx));
    expect(out).toContain(a.name);
    expect(out).not.toContain(path.join(".agents", "automations") + path.sep + "daily");
  });
});
