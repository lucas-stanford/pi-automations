/** Finding pi from a background run. */

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import {
  findPiModule,
  importPi,
  isPiPackage,
  minimumNode,
  olderThan,
  PI_MISSING_MESSAGE,
  PI_MODULE_ENV,
  PI_PACKAGE,
  resetPiCache,
} from "../src/pi-module.js";
import { tempDir } from "./helpers/temp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A directory that really is the pi package, as far as `package.json` is concerned. */
function makePiPackage(root: string): string {
  const dir = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: PI_PACKAGE, version: "0.0.0", exports: { ".": "./index.js" } }),
  );
  writeFileSync(path.join(dir, "index.js"), "export const marker = 'pi';\n");
  return dir;
}

/** A decoy: right folder name, wrong package. */
function makeImpostor(root: string): string {
  const dir = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "something-else" }));
  return dir;
}

describe("isPiPackage", () => {
  it("accepts only a directory whose package.json says it is pi", () => {
    const root = tempDir("pa-pi-ok-");
    expect(isPiPackage(makePiPackage(root))).toBe(true);
  });

  it("refuses a same-named directory that is a different package", () => {
    const root = tempDir("pa-pi-imp-");
    expect(isPiPackage(makeImpostor(root))).toBe(false);
  });

  it("refuses a directory that is not there at all", () => {
    expect(isPiPackage(path.join(tempDir("pa-pi-none-"), "nope"))).toBe(false);
  });
});

describe("findPiModule", () => {
  beforeEach(() => resetPiCache());

  const noLookups = { which: () => undefined, npmRoot: () => undefined };

  it("takes the env var first, so a child uses the same pi as its parent", () => {
    const root = tempDir("pa-pi-env-");
    const dir = makePiPackage(root);
    const found = findPiModule({ env: { [PI_MODULE_ENV]: dir }, ...noLookups });
    expect(found).toEqual({ dir, via: "env" });
  });

  it("ignores an env var pointing at something that is not pi", () => {
    const root = tempDir("pa-pi-envbad-");
    const impostor = makeImpostor(root);
    // Nothing else to find, so the answer is an honest "no".
    expect(findPiModule({ env: { [PI_MODULE_ENV]: impostor }, ...noLookups })).toBeUndefined();
  });

  it("takes the configured path when the env var is absent", () => {
    const root = tempDir("pa-pi-cfg-");
    const dir = makePiPackage(root);
    expect(findPiModule({ env: {}, configured: dir, ...noLookups })).toEqual({
      dir,
      via: "config",
    });
  });

  it("prefers the env var over config, because the parent knows best", () => {
    const a = makePiPackage(tempDir("pa-pi-pref-a-"));
    const b = makePiPackage(tempDir("pa-pi-pref-b-"));
    expect(findPiModule({ env: { [PI_MODULE_ENV]: a }, configured: b, ...noLookups })?.dir).toBe(a);
  });

  it("follows the pi on PATH to the package beside it — the npm global layout", () => {
    // C:\prefix\pi.CMD  with  C:\prefix\node_modules\@earendil-works\pi-coding-agent
    const prefix = tempDir("pa-pi-global-");
    const dir = makePiPackage(prefix);
    const launcher = path.join(prefix, "pi.CMD");
    writeFileSync(launcher, '@ECHO off\r\n"%~dp0node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js"\r\n');
    const found = findPiModule({ env: {}, which: () => launcher, npmRoot: () => undefined });
    expect(found).toEqual({ dir, via: "path" });
  });

  it("follows a .bin launcher, where the packages are one level up", () => {
    const root = tempDir("pa-pi-bin-");
    const dir = makePiPackage(root);
    const binDir = path.join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const launcher = path.join(binDir, "pi.CMD");
    writeFileSync(launcher, "@ECHO off\r\n");
    const found = findPiModule({ env: {}, which: () => launcher, npmRoot: () => undefined });
    expect(found).toEqual({ dir, via: "path" });
  });

  it("reads a shim that names its target relative to itself", () => {
    // The launcher is NOT in the npm layout, so only the shim text can lead anywhere.
    const root = tempDir("pa-pi-shim-");
    const dir = makePiPackage(path.join(root, "elsewhere"));
    mkdirSync(path.join(root, "bin"), { recursive: true });
    const launcher = path.join(root, "bin", "pi.CMD");
    const rel = path.relative(path.join(root, "bin"), dir).replace(/\//g, "\\");
    writeFileSync(launcher, `@ECHO off\r\n"%~dp0${rel}\\dist\\bundle\\cli.js" %*\r\n`);
    const found = findPiModule({ env: {}, which: () => launcher, npmRoot: () => undefined });
    expect(found?.dir).toBe(dir);
    expect(found?.via).toBe("path");
  });

  it("falls back to the npm global root", () => {
    const root = tempDir("pa-pi-npmroot-");
    const dir = makePiPackage(root);
    const found = findPiModule({
      env: {},
      which: () => undefined,
      npmRoot: () => path.join(root, "node_modules"),
    });
    expect(found).toEqual({ dir, via: "npm-root" });
  });

  /**
   * Homebrew's layout: `bin/pi` links to a bash wrapper that execs `libexec/bin/pi`, which links to
   * the package's `dist/bundle/cli.js`. Nothing in the wrapper names `node_modules`.
   */
  function brewInstall(root: string, wrapper: (libexecPi: string) => string): string {
    const cellar = path.join(root, "Cellar", "pi-coding-agent", "1.4.0");
    const dir = makePiPackage(path.join(cellar, "libexec", "lib"));
    mkdirSync(path.join(dir, "dist", "bundle"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
    mkdirSync(path.join(cellar, "libexec", "bin"), { recursive: true });
    const libexecPi = path.join(cellar, "libexec", "bin", "pi");
    symlinkSync("../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", libexecPi);
    mkdirSync(path.join(cellar, "bin"), { recursive: true });
    writeFileSync(path.join(cellar, "bin", "pi"), wrapper(libexecPi));
    mkdirSync(path.join(root, "bin"), { recursive: true });
    symlinkSync("../Cellar/pi-coding-agent/1.4.0/bin/pi", path.join(root, "bin", "pi"));
    return dir;
  }

  it.skipIf(process.platform === "win32")("follows a wrapper script to the launcher it execs — the Homebrew layout", () => {
    const root = tempDir("pa-pi-brew-");
    const dir = brewInstall(root, (target) => `#!/bin/bash\nPI_SKIP_VERSION_CHECK="1" exec "${target}"  "$@"\n`);
    const found = findPiModule({ env: {}, which: () => path.join(root, "bin", "pi"), npmRoot: () => undefined });
    expect(found?.via).toBe("path");
    expect(realpathSync(found?.dir ?? "")).toBe(realpathSync(dir));
  });

  it.skipIf(process.platform === "win32")("follows an unquoted exec too", () => {
    const root = tempDir("pa-pi-brew-bare-");
    const dir = brewInstall(root, (target) => `#!/bin/sh\nexec ${target} "$@"\n`);
    const found = findPiModule({ env: {}, which: () => path.join(root, "bin", "pi"), npmRoot: () => undefined });
    expect(realpathSync(found?.dir ?? "")).toBe(realpathSync(dir));
  });

  it("refuses a wrapper whose exec leads to something that is not pi", () => {
    const root = tempDir("pa-pi-wrapbad-");
    const impostor = makeImpostor(root);
    const target = path.join(impostor, "cli.js");
    writeFileSync(target, "");
    mkdirSync(path.join(root, "bin"), { recursive: true });
    const launcher = path.join(root, "bin", "pi");
    writeFileSync(launcher, `#!/bin/sh\nexec "${target}" "$@"\n`);
    expect(findPiModule({ env: {}, which: () => launcher, npmRoot: () => undefined })).toBeUndefined();
  });

  it("refuses an npm root whose pi-coding-agent is an impostor", () => {
    const root = tempDir("pa-pi-npmbad-");
    makeImpostor(root);
    expect(
      findPiModule({ env: {}, which: () => undefined, npmRoot: () => path.join(root, "node_modules") }),
    ).toBeUndefined();
  });

  it("says nothing rather than guessing when there is no pi anywhere", () => {
    expect(findPiModule({ env: {}, ...noLookups })).toBeUndefined();
  });

  it("never throws when PATH and npm are hostile — a broken PATH must not kill a run", () => {
    const hostile = () => {
      throw new Error("no");
    };
    let found: unknown = "unset";
    expect(() => {
      found = findPiModule({ env: {}, which: hostile, npmRoot: hostile });
    }).not.toThrow();
    expect(found).toBeUndefined();
  });
});

describe("piModule in config", () => {
  it("is the pi a background process loads, through createPiServices", () => {
    // A pi that only config can lead to, answering with a model nothing else could name. Without
    // the config, the child would resolve the dev-dependency pi instead and list its models.
    const dir = makePiPackage(tempDir("pa-pi-cfgsvc-pkg-"));
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: PI_PACKAGE, version: "0.0.0", type: "module", exports: { ".": "./index.js" } }),
    );
    writeFileSync(
      path.join(dir, "index.js"),
      [
        "export const ModelRuntime = { create: async () => ({ getAvailable: async () => [{ provider: 'fake', id: 'from-config' }] }) };",
        "export const SettingsManager = { create: () => ({ getEnabledModels: () => [] }) };",
      ].join("\n"),
    );
    const home = tempDir("pa-pi-cfgsvc-home-");
    const agentDir = path.join(home, "agent");
    mkdirSync(path.join(agentDir, "pi-automations"), { recursive: true });
    writeFileSync(path.join(agentDir, "pi-automations", "config.json"), JSON.stringify({ piModule: dir }));

    // In a child against dist/: vitest cannot import from the OS temp directory on every platform.
    const compose = pathToFileURL(path.join(repoRoot, "dist", "hosts", "pi", "compose.js")).href;
    const script = [
      `const { createPiServices } = await import(${JSON.stringify(compose)});`,
      `const services = createPiServices({ home: ${JSON.stringify(home)}, agentDir: ${JSON.stringify(agentDir)} });`,
      `process.stdout.write(JSON.stringify(await services.modelChoices(${JSON.stringify(home)})));`,
    ].join("\n");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_AGENT_DIR: agentDir };
    delete env[PI_MODULE_ENV];
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      cwd: home,
      env,
      timeout: 60_000,
      windowsHide: true,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout).available).toEqual([{ value: "fake/from-config" }]);
  });
});

describe("the message a person sees", () => {
  it("names the package and both ways out", () => {
    expect(PI_MISSING_MESSAGE).toContain(PI_PACKAGE);
    expect(PI_MISSING_MESSAGE).toContain("piModule");
    // One line, like every other error this package produces.
    expect(PI_MISSING_MESSAGE.includes("\n")).toBe(false);
  });
});

describe("a node too old for pi", () => {
  it("reads the minimum from a plain >= range, and nothing from any other form", () => {
    expect(minimumNode(">=22.19.0")).toBe("22.19.0");
    expect(minimumNode(">= 22")).toBe("22.0.0");
    expect(minimumNode(">=v20.6")).toBe("20.6.0");
    expect(minimumNode("^22.19.0")).toBeUndefined();
    expect(minimumNode(">=18 <23")).toBeUndefined();
    expect(minimumNode(undefined)).toBeUndefined();
  });

  it("compares versions field by field", () => {
    expect(olderThan("20.12.1", "22.19.0")).toBe(true);
    expect(olderThan("22.19.0", "22.19.0")).toBe(false);
    expect(olderThan("22.20.0", "22.19.9")).toBe(false);
    expect(olderThan("24.0.0", "22.19.0")).toBe(false);
    // Text comparison gets these wrong: "22.9.0" > "22.19.0" and "9.0.0" > "22.19.0" as strings.
    expect(olderThan("22.9.0", "22.19.0")).toBe(true);
    expect(olderThan("9.0.0", "22.19.0")).toBe(true);
  });

  it("says which node pi needs instead of failing inside pi", async () => {
    resetPiCache();
    const root = tempDir("pi-engine-");
    try {
      const dir = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: PI_PACKAGE, version: "9.9.9", engines: { node: ">=999.0.0" }, exports: { ".": "./index.js" } }),
      );
      writeFileSync(path.join(dir, "index.js"), "throw new Error('pi itself must not load');\n");
      await expect(importPi({ env: { [PI_MODULE_ENV]: dir } })).rejects.toThrow(
        `pi needs Node 999.0.0 or newer, and this is Node ${process.versions.node}`,
      );
    } finally {
      resetPiCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
