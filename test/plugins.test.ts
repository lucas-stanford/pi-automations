// Plugins: loaded from the person's config only, each one bounded and on its own, told about runs
// in the process that runs them, and never able to change one.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULTS, loadConfig } from "../src/config.js";
import { discover } from "../src/discover.js";
import { packageDir } from "../src/paths.js";
import { runAction } from "../src/plugins/actions.js";
import { chooseEditor, openInEditor, unsafeForShell } from "../src/plugins/editor.js";
import { loadPlugins, NO_PLUGINS, pluginChartRenderer, resolvePluginEntry, type LoadedPlugins } from "../src/plugins/loader.js";
import type { HostServices } from "../src/plugins/types.js";
import { progressNext, progressNote, progressTracking } from "../src/progress.js";
import { runLocalScript } from "../src/providers/scripts.js";
import { readRecords } from "../src/records.js";
import { fire, type SessionHandle } from "../src/run.js";
import { State } from "../src/state.js";
import { Trust } from "../src/trust.js";
import { armForTest } from "./helpers/arm.js";
import type { RuntimeSessionStart } from "../src/core/contracts.js";
import { cleanupTempDirs, tempDir, trackTempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const ROOT = path.resolve(import.meta.dirname, "..");
const NO_HOST = (): HostServices => {
  throw new Error("the host was asked for, and this plugin should not have needed it");
};

// A directory for plugin modules, inside this checkout (and ignored by git): vitest's module loader
// cannot import a file under the OS temp directory, and a plugin is imported, not read.
function pluginDir(): string {
  const base = path.join(ROOT, "test", "fixtures");
  mkdirSync(base, { recursive: true });
  return trackTempDir(mkdtempSync(path.join(base, "plugins-")));
}

/** A plugin module on disk. `body` is the inside of `setup(api)`. */
function pluginFile(body: string, opts: { name?: string; top?: string } = {}): string {
  const file = path.join(pluginDir(), "plugin.mjs");
  writeFileSync(
    file,
    `${opts.top ?? ""}\nexport default { name: ${JSON.stringify(opts.name ?? "probe")}, async setup(api) {\n${body}\n} };\n`,
  );
  return file;
}

function load(entries: string[], over: Partial<Parameters<typeof loadPlugins>[0]> = {}): Promise<LoadedPlugins> {
  return loadPlugins({ entries, where: "host", host: NO_HOST, timeoutMs: 300, ...over });
}

// ------------------------------------------------------------------------------------ config

describe("plugins in config.json", () => {
  function configWith(value: unknown) {
    const dir = tempDir("plugin-config-");
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ plugins: value }));
    return loadConfig(dir);
  }

  it("is absent by default: bare pi-automations", () => {
    expect(DEFAULTS.plugins).toBeUndefined();
    expect(loadConfig(tempDir("plugin-config-")).config.plugins).toBeUndefined();
  });

  it("takes the bundled name and absolute or ~ paths, once each", () => {
    const abs = path.resolve(tempDir("plugin-abs-"), "p.mjs");
    const { config, warnings } = configWith(["manager", abs, "~/plugins/x.mjs", "manager"]);
    expect(config.plugins).toEqual(["manager", abs, "~/plugins/x.mjs"]);
    expect(warnings).toEqual([]);
  });

  it("refuses a relative path, a non-string and a non-list with a warning, keeping the rest", () => {
    const { config, warnings } = configWith(["./mine.mjs", 3, "manager"]);
    expect(config.plugins).toEqual(["manager"]);
    expect(warnings.join("\n")).toMatch(/plugins\[0\]: "\.\/mine\.mjs" is neither "manager" nor an absolute path — ignored/);
    expect(warnings.join("\n")).toMatch(/plugins\[1\]: must be a plugin name or a path — ignored/);
    expect(configWith("manager").warnings.join("\n")).toMatch(/plugins: must be a list/);
  });

  it("no longer knows managerPath", () => {
    const dir = tempDir("plugin-config-");
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ managerPath: "C:/x" }));
    expect(loadConfig(dir).warnings).toEqual(["config.json: managerPath: unknown key — ignored"]);
  });
});

describe("resolving an entry", () => {
  it("resolves manager to the plugin built into this package", () => {
    const file = resolvePluginEntry("manager");
    expect(file).toBe(path.join(packageDir(), "packages", "manager", "plugin", "index.js"));
    // Committed, because pi installs this package from git and cannot build it.
    expect(existsSync(file)).toBe(true);
  });

  it("expands ~ and takes a directory's index.js", () => {
    const home = tempDir("plugin-home-");
    expect(resolvePluginEntry("~/p/x.mjs", { home })).toBe(path.join(home, "p", "x.mjs"));
    const dir = tempDir("plugin-dir-");
    expect(resolvePluginEntry(dir)).toBe(path.join(dir, "index.js"));
  });
});

describe("loading", () => {
  it("tells setup where it runs and builds the host only when it is asked for", async () => {
    const seen = path.join(tempDir("plugin-seen-"), "seen.json");
    const file = pluginFile(`
      const fs = await import("node:fs");
      fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ where: api.where, apiVersion: api.apiVersion, entry: api.entry }));
    `);
    let built = 0;
    const p = await load([file], { where: "worker", host: () => (built++, NO_HOST()) });
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({ where: "worker", apiVersion: 1, entry: file });
    expect(built).toBe(0);
    expect(p.loaded).toEqual([{ entry: file, name: "probe" }]);
    expect(p.warnings).toEqual([]);
  });

  it("isolates a broken plugin: the others load, and the broken one is a warning", async () => {
    const good = pluginFile(`api.addAction({ id: "wave", label: "Wave", run: () => ({ message: "hi" }) });`, { name: "good" });
    const throwsOnImport = pluginFile("", { top: "throw new Error('cannot import me');" });
    const throwsInSetup = pluginFile(`api.addAction({ id: "half", label: "Half", run: () => {} }); throw new Error("setup broke");`, { name: "broken" });
    const notAPlugin = path.join(pluginDir(), "nothing.mjs");
    writeFileSync(notAPlugin, "export const x = 1;\n");
    const missing = path.join(tempDir("plugin-"), "missing.mjs");

    const p = await load([throwsOnImport, good, throwsInSetup, notAPlugin, missing]);

    expect(p.loaded.map((l) => l.name)).toEqual(["good"]);
    expect(p.actions.map((a) => a.action.id)).toEqual(["wave"]);
    const said = p.warnings.join("\n");
    expect(said).toContain("cannot import me — not loaded");
    expect(said).toContain("plugin broken: setup broke — not loaded");
    expect(said).toContain("exports no plugin");
    expect(said).toContain("does not exist — not loaded");
    // What the broken one registered before it threw is not kept.
    expect(p.action("half")).toBeUndefined();
  });

  it("gives up on a setup that does not answer in time", async () => {
    const hangs = pluginFile(`await new Promise(() => {});`, { name: "slow" });
    const started = Date.now();
    const p = await load([hangs], { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(p.loaded).toEqual([]);
    expect(p.warnings.join("\n")).toMatch(/plugin slow: its setup did not answer within/);
  });

  it("refuses actions that would take a pa verb, have no id, or are added twice", async () => {
    const a = pluginFile(
      `api.addAction({ id: "run", label: "Run", run: () => {} });
       api.addAction({ id: "Bad Id", label: "x", run: () => {} });
       api.addAction({ id: "edit", label: "Edit in A", run: () => ({ message: "a" }) });`,
      { name: "a" },
    );
    const b = pluginFile(`api.addAction({ id: "edit", label: "Edit in B", run: () => {} });`, { name: "b" });
    const p = await load([a, b]);
    expect(p.actions.map((x) => `${x.plugin}:${x.action.id}`)).toEqual(["a:edit"]);
    const said = p.warnings.join("\n");
    expect(said).toContain('action "run" is a pa command already');
    expect(said).toContain('action "Bad Id" needs an id');
    expect(said).toContain('action "edit" is already added by a');
  });

  it("takes the first renderer and says the second is ignored", async () => {
    const a = pluginFile(`api.setRenderer(() => ({ text: "A" }));`, { name: "a" });
    const b = pluginFile(`api.setRenderer(() => ({ text: "B" }));`, { name: "b" });
    const p = await load([a, b]);
    expect(p.renderer?.plugin).toBe("a");
    expect(p.warnings.join("\n")).toContain("a already draws charts");
  });
});

describe("every call into a plugin is bounded and caught", () => {
  it("collects a failing or hanging observer as a problem and still tells the others", async () => {
    const got = path.join(tempDir("plugin-events-"), "events.jsonl");
    const ok = pluginFile(
      `const fs = await import("node:fs");
       api.on("note", (e) => fs.appendFileSync(${JSON.stringify(got)}, JSON.stringify(e.note) + "\\n"));`,
      { name: "ok" },
    );
    const throws = pluginFile(`api.on("note", () => { throw new Error("observer broke"); });`, { name: "throws" });
    const hangs = pluginFile(`api.on("note", () => new Promise(() => {}));`, { name: "hangs" });
    const p = await load([ok, throws, hangs], { timeoutMs: 200 });

    const note = { ts: "2026-10-21T00:00:00.000Z", text: "published", links: [{ url: "https://example.com/x" }] };
    const problems = await p.emit("note", { run: { runId: "r1", key: "k", name: "n", scope: "user", trigger: "manual" }, note });

    expect(problems).toEqual([
      "plugin throws: observer broke",
      expect.stringMatching(/^plugin hangs: its note observer did not answer within/),
    ]);
    expect(JSON.parse(readFileSync(got, "utf8").trim())).toEqual(note);
  });

  it("turns an action that throws or hangs into a problem to show", async () => {
    const p = await load(
      [
        pluginFile(
          `api.addAction({ id: "boom", label: "Boom", run: () => { throw new Error("no"); } });
           api.addAction({ id: "stuck", label: "Stuck", run: () => new Promise(() => {}) });`,
          { name: "acts" },
        ),
      ],
      { timeoutMs: 200 },
    );
    expect(await p.runAction("boom", { where: "cli", open: false })).toEqual({ problem: "acts: no" });
    expect((await p.runAction("stuck", { where: "cli", open: false })).problem).toMatch(/its stuck action did not answer/);
  });

  it("falls back from a renderer that fails, and drops one that is too slow", async () => {
    const problems: string[] = [];
    let calls = 0;
    const current = { plugin: "r", render: (): { text: string } => { calls++; throw new Error("nope"); } };
    const draw = pluginChartRenderer(() => current, (m) => problems.push(m), 1000);
    const args = { plan: "flowchart TD\n a --> b", state: { nodes: {}, taken: [] }, format: "text" as const };
    expect(draw(args)).toBeUndefined();
    expect(draw(args)).toBeUndefined();
    expect(calls).toBe(2);
    expect(problems).toEqual(["plugin r: its renderer failed: nope — that chart is drawn without it"]);

    const slow = { plugin: "s", render: () => { const until = Date.now() + 30; while (Date.now() < until); return { text: "late" }; } };
    const drawSlow = pluginChartRenderer(() => slow, (m) => problems.push(m), 5);
    expect(drawSlow(args)).toBeUndefined();
    expect(drawSlow(args)).toBeUndefined();
    expect(problems.at(-1)).toMatch(/plugin s: its renderer took \d+ms — charts are drawn without it now/);

    const fine = pluginChartRenderer(() => ({ plugin: "f", render: () => ({ text: "drawn" }) }), () => {});
    expect(fine(args)).toEqual({ text: "drawn" });
  });
});

describe("edit and plugin actions", () => {
  const status = { key: "user:/r:daily", name: "daily", scope: "user" as const, dir: path.resolve("/r/daily") };

  it("uses the plugin's edit when one is loaded", async () => {
    const p = await load([pluginFile(`api.addAction({ id: "edit", label: "Edit", run: (ctx) => ({ message: "edit " + ctx.automation.file + " " + ctx.open, keepAlive: true }) });`)]);
    const out = await runAction({ id: "edit", plugins: p, status, where: "cli", open: false });
    expect(out).toEqual({ lines: [`edit ${path.join(status.dir, "AUTOMATION.md")} false`], keepAlive: true });
  });

  it("without one, opens AUTOMATION.md in the editor it chose", async () => {
    const opened: string[] = [];
    const out = await runAction({
      id: "edit",
      plugins: NO_PLUGINS,
      status,
      where: "cli",
      editor: () => ({ kind: "command", command: "my-editor" }),
      openEditor: async (_c, file) => void opened.push(file),
    });
    expect(opened).toEqual([path.join(status.dir, "AUTOMATION.md")]);
    expect(out.lines).toEqual(["edited daily's AUTOMATION.md in my-editor"]);
    expect((await runAction({ id: "wave", plugins: NO_PLUGINS, status, where: "cli" })).exitCode).toBe(1);
  });

  it("chooses $VISUAL, then $EDITOR, then VS Code, then the OS opener — and never a terminal editor inside pi", () => {
    const file = path.resolve("/r/daily/AUTOMATION.md");
    const code = (bin: string) => (bin === "code" ? "/bin/code" : undefined);
    const none = () => undefined;
    expect(chooseEditor({ file, where: "cli", env: { VISUAL: "vim", EDITOR: "nano" }, which: code })).toEqual({ kind: "command", command: "vim" });
    expect(chooseEditor({ file, where: "cli", env: { EDITOR: "nano" }, which: code })).toEqual({ kind: "command", command: "nano" });
    expect(chooseEditor({ file, where: "cli", env: {}, which: code })).toEqual({ kind: "code", bin: "/bin/code" });
    expect(chooseEditor({ file, where: "cli", env: {}, which: none, platform: "linux" })).toEqual({ kind: "opener", file: "xdg-open", args: [file] });
    expect(chooseEditor({ file, where: "host", env: { VISUAL: "vim" }, which: code })).toEqual({ kind: "code", bin: "/bin/code" });
    expect(chooseEditor({ file, where: "host", env: { VISUAL: "vim" }, which: none, platform: "darwin" })).toEqual({ kind: "opener", file: "open", args: [file] });
  });

  it("never hands a repository's folder name to cmd as syntax", async () => {
    const hostile = "C:\\r\\.agents\\automations\\x&calc&\\AUTOMATION.md";
    const opener = chooseEditor({ file: hostile, where: "host", env: {}, which: () => undefined, platform: "win32" });
    expect(opener).toEqual({ kind: "opener", file: "explorer.exe", args: [hostile] });

    const percent = "C:\\r\\.agents\\automations\\%COMSPEC%\\AUTOMATION.md";
    expect(unsafeForShell(percent, "win32")).toMatch(/refusing/);
    expect(unsafeForShell(hostile, "win32")).toBeUndefined();
    expect(unsafeForShell(percent, "linux")).toBeUndefined();
    expect(await openInEditor({ kind: "command", command: "echo" }, percent, "win32")).toMatch(/refusing/);
    expect(await openInEditor({ kind: "code", bin: "C:\\code\\code.cmd" }, percent, "win32")).toMatch(/refusing/);
  });
});

// ------------------------------------------------------------------------------------ lifecycle

/** An automation with a chart, on disk. */
function chartedAutomation(name: string, extra = "") {
  const root = path.join(tempDir("plugin-run-"), "automations");
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: ${name}\ndescription: d\n${extra}on:\n  manual: true\n---\n\n# ${name}\n\n\`\`\`mermaid\nflowchart TD\n  body["Do it"] --> publish["Publish"]\n\`\`\`\n\nDo the thing.\n`,
  );
  return { root, dir };
}

function eventsPlugin(out: string): string {
  return pluginFile(`
    const fs = await import("node:fs");
    const log = (type) => (e) => fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ type, where: api.where, ...e }) + "\\n");
    api.on("run-start", log("run-start"));
    api.on("step", log("step"));
    api.on("note", log("note"));
    api.on("run-end", log("run-end"));
  `);
}

interface LoggedEvent {
  type: string;
  where: string;
  run: { runId: string; name: string };
  step: { id: string; status: string };
  note?: unknown;
  record?: unknown;
}

function readEvents(file: string): LoggedEvent[] {
  return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("run lifecycle, in the process that runs it", () => {
  it("tells observers the start, each step and note, and the record — and a broken one is a problem on it", async () => {
    const { root } = chartedAutomation("observed");
    const found = discover({ roots: [{ path: root, scope: "user", kind: "agents" }] });
    const l = found[0]?.ok ? found[0].located : undefined;
    if (!l) throw new Error("fixture did not parse");
    const stateDir = tempDir("plugin-state-");
    armForTest(l, stateDir);
    const out = path.join(tempDir("plugin-events-"), "events.jsonl");
    const broken = pluginFile(`api.on("step", () => { throw new Error("step observer broke"); });`, { name: "broken" });
    const observers = await load([eventsPlugin(out), broken]);

    const startSession = async (start: RuntimeSessionStart): Promise<SessionHandle> => {
      const runId = start.env?.AUTOMATION_RUN;
      return {
        file: "",
        id: "",
        async prompt() {
          // What an agent does with `pa next` and `pa note`, through the same store.
          progressNext(stateDir, runId, { from: "body", to: "publish", text: "publishing" });
          progressNote(stateDir, runId, { text: "Published the digest", links: ["digest=https://example.com/d"] });
          await new Promise((r) => setTimeout(r, 700));
          return "done";
        },
        dispose() {},
      };
    };

    const record = await fire(l, { trigger: "manual" }, {
      config: { ...DEFAULTS, notifyOnFailed: false },
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      runtime: { resolveModel: async () => ({ provider: "p", id: "m", display: "p/m" }) as never, startSession },
      runScript: runLocalScript,
      startTracking: progressTracking,
      observe: observers,
    });

    expect(record.outcome).toBe("ok");
    const events = readEvents(out);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run-start");
    expect(types.at(-1)).toBe("run-end");
    expect(events.every((e) => e.where === "host" && e.run.runId === record.id && e.run.name === "observed")).toBe(true);
    const steps = events.filter((e) => e.type === "step").map((e) => `${e.step.id}:${e.step.status}`);
    expect(steps).toContain("publish:active");
    expect(steps.at(-1)).toMatch(/^publish:(interrupted|done)$/);
    const notes = events.filter((e) => e.type === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toMatchObject({ text: "Published the digest", links: [{ label: "digest", url: "https://example.com/d" }] });
    expect(events.at(-1)?.record).toMatchObject({ id: record.id, outcome: "ok", notes: [{ text: "Published the digest" }] });
    // The broken observer did not change the run; it is written on its record.
    expect(record.pluginProblems?.[0]).toBe("plugin broken: step observer broke");
    expect(readRecords(stateDir, l.key, 1)[0]?.pluginProblems).toEqual(record.pluginProblems);
  });

  it("loads the configured plugins in a detached worker, which tells them as a worker", () => {
    const home = tempDir("plugin-worker-home-");
    const agentDir = path.join(home, "agent");
    const name = "worker-observed";
    const dir = path.join(agentDir, "automations", name);
    mkdirSync(dir, { recursive: true });
    // A model that cannot resolve, so the run ends before any session: nothing is ever paid for.
    writeFileSync(path.join(dir, "AUTOMATION.md"), `---\nname: ${name}\ndescription: d\nmodel: nope/nothing\non:\n  manual: true\n---\n\nDo it.\n`);
    const out = path.join(tempDir("plugin-events-"), "events.jsonl");
    const missing = path.join(home, "no-such-plugin.mjs");
    mkdirSync(path.join(agentDir, "pi-automations"), { recursive: true });
    writeFileSync(path.join(agentDir, "pi-automations", "config.json"), JSON.stringify({ plugins: [eventsPlugin(out), missing], notifyOnFailed: false }));
    const key = `user:${path.resolve(agentDir, "automations")}:${name}`;

    const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "fire.js"), key, "--manual"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PI_AGENT_DIR: agentDir },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(10);

    const events = readEvents(out);
    expect(events.map((e) => `${e.type}@${e.where}`)).toEqual(["run-end@worker"]);
    expect(events[0]?.record).toMatchObject({ outcome: "skipped", name });
    const record = readRecords(path.join(agentDir, "pi-automations"), key, 1)[0];
    expect(record?.pluginProblems?.join("\n")).toContain("no-such-plugin.mjs does not exist — not loaded");
  });
});

describe("pa edit and pa <action>", () => {
  function cliHome(plugins?: string[]) {
    const home = tempDir("plugin-cli-home-");
    const agentDir = path.join(home, "agent");
    const dir = path.join(agentDir, "automations", "daily");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "AUTOMATION.md"), "---\nname: daily\ndescription: d\non:\n  manual: true\n---\n\nDo it.\n");
    mkdirSync(path.join(agentDir, "pi-automations"), { recursive: true });
    if (plugins) writeFileSync(path.join(agentDir, "pi-automations", "config.json"), JSON.stringify({ plugins }));
    return { home, agentDir, dir };
  }

  function pa(args: string[], h: { home: string; agentDir: string }, env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [path.join(ROOT, "bin", "pi-automations.js"), ...args], {
      cwd: h.home,
      env: { ...process.env, HOME: h.home, USERPROFILE: h.home, PI_AGENT_DIR: h.agentDir, VISUAL: "", EDITOR: "", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("opens AUTOMATION.md in $VISUAL without plugins, and waits for it", () => {
    const h = cliHome();
    const marker = path.join(h.home, "edited.txt");
    const editor = path.join(h.home, "editor.mjs");
    writeFileSync(editor, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, process.argv[2]);\n`);
    const r = pa(["edit", "daily"], h, { VISUAL: `"${process.execPath}" "${editor}"` });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(path.join(h.dir, "AUTOMATION.md"));
    expect(r.stdout).toContain("edited daily's AUTOMATION.md in");
  });

  it("runs a plugin's edit and its other actions, and lists them in help", () => {
    const plugin = pluginFile(`
      api.addAction({ id: "edit", label: "Edit in Probe", run: (ctx) => ({ message: "probe edits " + ctx.automation.name + " open=" + ctx.open + " from " + ctx.where }) });
      api.addAction({ id: "wave", label: "Wave at it", run: (ctx) => ({ message: "waved at " + ctx.automation.name }) });
    `);
    const h = cliHome([plugin]);
    const edit = pa(["edit", "daily", "--no-open"], h);
    expect(edit.status, edit.stderr).toBe(0);
    expect(edit.stdout).toContain("probe edits daily open=false from cli");
    expect(pa(["wave", "daily"], h).stdout).toContain("waved at daily");
    const help = pa(["help"], h).stdout;
    expect(help).toMatch(/pa edit <name>\s+Edit in Probe \(probe plugin\)/);
    expect(help).toMatch(/pa wave <name>\s+Wave at it \(probe plugin\)/);
  });
});
