/** The package a person actually installs. */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const ROOT = path.resolve(import.meta.dirname, "..");

/** npm, as a script rather than as `npm.cmd`. */
const NPM_CLI = (() => {
  const beside = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const unixish = path.join(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(beside)) return beside;
  if (existsSync(unixish)) return unixish;
  throw new Error("npm-cli.js not found beside this node");
})();

/** Everything the tarball may contain: what runs, and the files npm always adds. */
const SHIPPED = /^(dist\/|bin\/|extensions\/|packages\/manager\/(plugin|dist)\/|packages\/manager\/README\.md$|skills\/(agent-automations|pi-automations)\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/;

let installed = "";
let packedFiles: string[] = [];
let sandboxEnv: NodeJS.ProcessEnv = {};

function run(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const r = execFileSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    stdio: "pipe",
  });
  return r;
}

function npm(args: string[], cwd: string) {
  return run(process.execPath, [NPM_CLI, ...args], process.env, cwd);
}

/** Run a node script and return `{status, stdout, stderr}` without throwing on a non-zero exit. */
function tryRun(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  try {
    return { status: 0, stdout: run(process.execPath, args, env, cwd), stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

beforeAll(() => {
  const base = tempDir("pa-pack-");
  const home = path.join(base, "home");
  const agentDir = path.join(base, "agent");
  const workdir = path.join(base, "cwd");
  for (const d of [home, agentDir, workdir]) mkdirSync(d, { recursive: true });

  // What the tarball WILL contain, straight from npm rather than from a guess about `files`.
  const listed = JSON.parse(
    npm(["pack", "--dry-run", "--json"], ROOT),
  ) as Array<{ files: Array<{ path: string }> }>;
  packedFiles = (listed[0]?.files ?? []).map((f) => f.path.replace(/\\/g, "/"));

  const tgzName = npm(["pack", "--pack-destination", base, "--silent"], ROOT)
    .trim()
    .split("\n")
    .pop() as string;
  const tgz = path.join(base, tgzName.trim());

  const target = path.join(base, "install");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "package.json"), '{"name":"host","private":true}\n', "utf8");

  npm(
    [
      "install",
      tgz,
      "--omit=dev",
      "--legacy-peer-deps",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    target,
  );

  installed = path.join(target, "node_modules", "pi-automations");

  sandboxEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_AGENT_DIR: agentDir,
    // Nothing should reach back into the author's tree.
    NODE_PATH: "",
  };
  delete sandboxEnv.FM_BIN;

  // Handy for the executable cases below.
  (sandboxEnv as Record<string, string>).PA_WORKDIR = workdir;
}, 600_000);

describe("the packed candidate", () => {
  it("installs with no dev dependencies and no borrowed source", () => {
    expect(existsSync(installed), "the package did not install").toBe(true);

    const mods = path.join(installed, "..");
    const names = readdirSync(mods).filter((n) => !n.startsWith("."));
    expect(names).toContain("croner");
    expect(names).toContain("yaml");
    expect(names).not.toContain("typescript");
    expect(names).not.toContain("vitest");

    // No source, and no way to reach the author's tree.
    expect(existsSync(path.join(installed, "src"))).toBe(false);
    expect(existsSync(path.join(installed, "node_modules"))).toBe(false);
    expect(path.relative(ROOT, installed).startsWith("..")).toBe(true);
  });

  it("ships every dist file byte-identical to the one built here", () => {
    const shipped = packedFiles.filter((f) => f.startsWith("dist/"));
    expect(shipped.length).toBeGreaterThan(50);

    const differing = shipped.filter((f) => {
      const a = path.join(ROOT, f);
      const b = path.join(installed, f);
      return !existsSync(b) || readFileSync(a, "utf8") !== readFileSync(b, "utf8");
    });
    expect(differing).toEqual([]);
  });

  it("ships only what runs: no tests, sources, scripts or source maps", () => {
    expect(packedFiles.filter((f) => !SHIPPED.test(f))).toEqual([]);
    expect(packedFiles.filter((f) => f.endsWith(".map"))).toEqual([]);
    expect(packedFiles).toContain("packages/manager/plugin/index.js");
    expect(packedFiles).toContain("packages/manager/dist/index.html");
  });

  it("ships both agent skills, and nothing from the site", () => {
    expect(packedFiles).toContain("skills/agent-automations/SKILL.md");
    expect(packedFiles).toContain("skills/agent-automations/references/specification.md");
    expect(packedFiles).toContain("skills/agent-automations/assets/watch-inbox/scripts/watch.mjs");
    expect(packedFiles).toContain("skills/pi-automations/SKILL.md");
    expect(packedFiles).toContain("skills/pi-automations/references/reporting.md");
    expect(packedFiles.filter((f) => f.startsWith("site/"))).toEqual([]);

    const pkg = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
    expect(pkg.pi.skills).toEqual(["./skills"]);
    expect(existsSync(path.join(installed, "skills", "agent-automations", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(installed, "skills", "pi-automations", "SKILL.md"))).toBe(true);
  });

  it("keeps exactly one top-level extension and no exports map", () => {
    const tops = readdirSync(path.join(installed, "extensions")).filter((f) => f.endsWith(".ts"));
    expect(tops).toEqual(["automations.ts"]);

    const pkg = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
    // An exports map would close off the deep imports installed callers already use.
    expect(pkg.exports).toBeUndefined();
    expect(pkg.pi.extensions).toEqual(["./extensions"]);
  });

  it("cites only paths that exist, in the provider guide", () => {
    const guide = readFileSync(path.join(ROOT, "docs", "PROVIDERS.md"), "utf8");
    const cited = new Set<string>();
    for (const m of guide.matchAll(/`((?:test|src|dist|bin|docs|extensions)\/[\w./-]+)`/g)) {
      const p = m[1] as string;
      // dist/** paths in the guide name modules, some of which are directories-with-wildcards.
      if (!p.includes("*")) cited.add(p);
    }
    expect(cited.size).toBeGreaterThan(8);

    const missing = [...cited].filter((p) => !existsSync(path.join(ROOT, p)));
    expect(missing, "docs/PROVIDERS.md names files that do not exist").toEqual([]);
  });
});

describe("the packed candidate runs", () => {
  it("fires, and refuses an automation that does not exist", () => {
    const r = tryRun(
      [path.join(installed, "bin", "fire.js"), "user:/nowhere:absent"],
      sandboxEnv,
      sandboxEnv.PA_WORKDIR as string,
    );
    // EXIT.refused — it loaded dist, read config, built Trust and State, discovered nothing in the
    // sandboxed home, and said so.
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("no automation with key");
  });

  it("ticks, considering nothing, registering nothing", () => {
    const r = tryRun(
      [path.join(installed, "bin", "tick.js")],
      sandboxEnv,
      sandboxEnv.PA_WORKDIR as string,
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("considered 0");
    expect(r.stdout).toContain("fired 0");

    // A tick must not have registered an OS job or written outside its state directory.
    const agentDir = sandboxEnv.PI_AGENT_DIR as string;
    expect(existsSync(path.join(agentDir, "pi-automations"))).toBe(true);
    expect(existsSync(path.join(agentDir, "pi-automations", "detached.json"))).toBe(false);
  });

  it("gives a host the portable core, with no pi loaded", () => {
    const probe = path.join(ROOT, "test", "fixtures", "portable-import-probe.mjs");
    const r = tryRun(
      [probe, path.join(installed, "dist", "core", "index.js")],
      sandboxEnv,
      sandboxEnv.PA_WORKDIR as string,
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);

    const report = JSON.parse(r.stdout.trim().split("\n").pop() as string);
    expect(report.forbiddenModules).toEqual([]);
    expect(report.writes).toEqual([]);
    expect(report.spawns).toEqual([]);
    expect(report.dataReads).toEqual([]);
    expect(report.envMutations).toEqual([]);
    expect(report.importError).toBeNull();
    expect(report.exports).toEqual(
      expect.arrayContaining(["fire", "runTick", "discover", "parseSessionLines"]),
    );
  });

  it("runs the guide's own example end to end against the installed dist", () => {
    const out = path.join(sandboxEnv.PA_WORKDIR as string, "guide");
    mkdirSync(out, { recursive: true });
    // The example lives in the repository, not the tarball; place it where it resolves the install.
    const fixtures = path.join(installed, "test", "fixtures");
    mkdirSync(fixtures, { recursive: true });
    for (const f of ["portable-lifecycle.mjs", "portable-runtime.mjs"]) {
      copyFileSync(path.join(ROOT, "test", "fixtures", f), path.join(fixtures, f));
    }
    const r = tryRun(
      [path.join(fixtures, "portable-lifecycle.mjs"), "ok", out],
      sandboxEnv,
      installed,
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);

    const report = JSON.parse(r.stdout.trim().split("\n").pop() as string);
    expect(report.outcome).toBe("ok");
    expect(report.historyCount).toBe(1);
    expect(report.summary).toBe("the portable answer");
  });

  it("still answers the deep imports installed callers reach for", () => {
    const script = [
      'const { pathToFileURL } = await import("node:url");',
      'const at = (p) => pathToFileURL(process.argv[1] + p).href;',
      'const a = await import(at("/dist/providers/pi/transcript.js"));',
      'const b = await import(at("/dist/paths.js"));',
      'const parsed = a.parseSessionLines(JSON.stringify({type:"session",id:"s1",timestamp:1}) + "\\n");',
      'const log = b.fireLogPath(process.argv[2], "user:/x:y");',
      "console.log(JSON.stringify({ id: parsed.id, log: log.replace(/\\\\/g, '/') }));",
    ].join("\n");

    const r = tryRun(
      ["--input-type=module", "-e", script, installed, sandboxEnv.PA_WORKDIR as string],
      sandboxEnv,
      sandboxEnv.PA_WORKDIR as string,
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);

    const got = JSON.parse(r.stdout.trim());
    expect(got.id).toBe("s1");
    expect(got.log).toContain("/logs/fire-");
  });

  it("survives a new extension on an old cached dist", () => {
    // The mixed-cache shape, at package level: the adapter depends on ONE dist symbol, and a build
    // that lacks it must still let the adapter load and say so rather than throwing on evaluation.
    const adapter = readFileSync(path.join(installed, "extensions", "automations.ts"), "utf8");
    const imports = [...adapter.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/dist\/index\.js"/g)];
    expect(imports.length).toBe(1);

    const named = (imports[0]?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(named).toEqual(["createAutomationsExtension"]);

    const r = tryRun(
      [
        "--input-type=module",
        "-e",
        'const { pathToFileURL } = await import("node:url"); const m = await import(pathToFileURL(process.argv[1] + "/dist/index.js").href); console.log(typeof m.createAutomationsExtension);',
        installed,
      ],
      sandboxEnv,
      sandboxEnv.PA_WORKDIR as string,
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe("function");
  });
});
