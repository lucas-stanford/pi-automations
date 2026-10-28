import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensurePaLauncher, paLauncherDir, paPathOverlay } from "../src/pa-launcher.js";
import { progressEnvironment } from "../src/progress.js";
import { tempDir } from "./helpers/temp.js";

const tempState = () => tempDir("pa-launcher-");

describe("the pa launcher a run gets", () => {
  it("puts the launchers first on PATH, under the name the environment already uses", () => {
    const state = tempState();
    const overlay = paPathOverlay(state, { Path: `a${path.delimiter}b` });
    expect(Object.keys(overlay)).toEqual(["Path"]);
    expect(overlay.Path).toBe([paLauncherDir(state), "a", "b"].join(path.delimiter));
    expect(existsSync(path.join(paLauncherDir(state), "pa"))).toBe(true);
  });

  it("does not stack the launcher directory when applied twice", () => {
    const state = tempState();
    const once = paPathOverlay(state, { PATH: "x" });
    const twice = paPathOverlay(state, once);
    expect(twice.PATH).toBe(once.PATH);
  });

  it("is part of every run's progress environment", () => {
    const state = tempState();
    const env = progressEnvironment({ runId: "r1", stateDir: state });
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
    expect(key).toBeDefined();
    expect(env[key!]!.split(path.delimiter)[0]).toBe(paLauncherDir(state));
    expect(env.AUTOMATION_RUN).toBe("r1");
  });

  it("runs this package's CLI with this process's node", () => {
    const state = tempState();
    const dir = ensurePaLauncher(state)!;
    const sh = readFileSync(path.join(dir, "pa"), "utf8");
    expect(sh.startsWith("#!/bin/sh\nexec ")).toBe(true);
    expect(sh).toContain("bin/pi-automations.js");
    const result =
      process.platform === "win32"
        ? spawnSync("cmd.exe", ["/d", "/c", path.join(dir, "pa.cmd"), "help"], { encoding: "utf8" })
        : spawnSync(path.join(dir, "pa"), ["help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pa note <text>");
  });
});
