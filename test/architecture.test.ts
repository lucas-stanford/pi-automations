/** What importing the portable core is allowed to do: nothing. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const PKG = path.resolve(import.meta.dirname, "..");
const PROBE = path.join(import.meta.dirname, "fixtures", "portable-import-probe.mjs");
const CONTROL = path.join(import.meta.dirname, "fixtures", "portable-inertness-control.mjs");
const CORE = path.join(PKG, "dist", "core", "index.js");

function probe(target: string, mode: "enforce" | "observe", controlDir?: string) {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (controlDir) env.PORTABLE_CONTROL_DIR = controlDir;
  else delete env.PORTABLE_CONTROL_DIR;

  const r = spawnSync(process.execPath, [PROBE, target, mode], {
    encoding: "utf8",
    cwd: PKG,
    env,
    timeout: 60_000,
  });
  const last = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (!last) throw new Error(`probe produced no report (status ${r.status}): ${r.stderr}`);
  return JSON.parse(last) as Record<string, unknown>;
}

/** An isolated directory for the control to act on. It never touches real user state. */
function controlDir() {
  const dir = tempDir("portable-control-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "discovered.txt"), "pretend user state\n", "utf8");
  writeFileSync(path.join(dir, "discovered.json"), '{"pretend":"user state"}', "utf8");

  // An owned fake dependency: a real manifest, which is loader traffic, beside ordinary data, which
  // is not. Nothing resolves through it — it exists so the classifier has to tell the two apart by
  // what the file is rather than by where it sits.
  const dep = path.join(dir, "node_modules", "owned-fake-dep");
  mkdirSync(dep, { recursive: true });
  writeFileSync(path.join(dep, "package.json"), '{"name":"owned-fake-dep","version":"0.0.0"}', "utf8");
  writeFileSync(path.join(dep, "settings.json"), '{"pretend":"user state in a dependency"}', "utf8");
  return dir;
}

describe("the inertness probe itself", () => {
  const dir = controlDir();
  const report = probe(CONTROL, "observe", dir);

  it("sees a NAMED fs write and an async fs/promises write", () => {
    expect(report.writes).toHaveLength(2);
    expect(String(report.writes)).toContain("named-write.txt");
    expect(String(report.writes)).toContain("async-write.txt");
  });

  it("sees a child process", () => {
    expect(report.spawns).toHaveLength(1);
  });

  it("sees a data read, and does not excuse it as module-graph traffic", () => {
    // Three: plain data, data wearing a module extension, and data inside a dependency.
    expect(report.dataReads).toHaveLength(3);
    expect(String(report.dataReads)).toContain("discovered.txt");
  });

  it("sees a JSON data read, which a by-extension classifier files as loader traffic", () => {
    // Excusing every `.json` by name would report an ordinary data read at import time as
    // `dataReads: []`, and the inertness claim could not be substantiated.
    expect(String(report.dataReads)).toContain("discovered.json");
  });

  it("sees ordinary data read from INSIDE a dependency, and excuses only its manifest", () => {
    // Where a file sits is not what makes it loader traffic. The manifest is excused; the data file
    // beside it is reported, or a package could hide user state under `node_modules`.
    expect(String(report.dataReads)).toContain("settings.json");
    expect(String(report.dataReads)).not.toContain("package.json");
  });

  it("REJECTS that dependency data read in enforce mode", () => {
    const fresh = controlDir();
    const enforced = probe(CONTROL, "enforce", fresh);
    expect((enforced.importError as { code: string }).code).toBe("ERR_PORTABLE_SIDE_EFFECT");
  });

  it("REJECTS that JSON read in enforce mode", () => {
    const fresh = controlDir();
    const enforced = probe(CONTROL, "enforce", fresh);
    expect((enforced.importError as { code: string }).code).toBe("ERR_PORTABLE_SIDE_EFFECT");
  });

  it("sees an environment key that was set and put straight back", () => {
    // A before/after snapshot cannot see this.
    expect(report.envMutations).toEqual([
      "set PORTABLE_CONTROL_TRANSIENT",
      "delete PORTABLE_CONTROL_TRANSIENT",
    ]);
  });

  it("PREVENTS the side effect in enforce mode, rather than reporting it afterwards", () => {
    const fresh = controlDir();
    const enforced = probe(CONTROL, "enforce", fresh);

    expect((enforced.importError as { code: string }).code).toBe("ERR_PORTABLE_SIDE_EFFECT");
    expect(existsSync(path.join(fresh, "named-write.txt")), "the write was not prevented").toBe(
      false,
    );
    expect(existsSync(path.join(fresh, "async-write.txt"))).toBe(false);
    expect(enforced.exports).toEqual([]);
  });
});

describe("importing the portable core", () => {
  const report = probe(CORE, "enforce");

  it("actually loaded the graph it claims to have watched", () => {
    expect(report.sawCore).toBe(true);
    expect(report.sawLifecycle).toBe(true);
    expect(report.moduleCount as number).toBeGreaterThan(10);
    expect(report.importError).toBeNull();
  });

  it("loads no SDK, no host, no fm client, no scheduler backend and no notifier", () => {
    expect(report.forbiddenModules).toEqual([]);
  });

  it("does load the legacy pi decoder, which is the point of the codec seam", () => {
    // Stated rather than left implicit: the decoder is reachable from here ON PURPOSE, because a
    // portable host still has to read transcripts pi wrote. It imports no SDK, which is what makes
    // that safe — and the assertion above is what keeps it true.
    expect(report.sawLegacyCodec).toBe(true);
  });

  it("creates nothing, reads no data, starts nothing and changes nothing", () => {
    expect(report.writes).toEqual([]);
    expect(report.spawns).toEqual([]);
    expect(report.dataReads).toEqual([]);
    expect(report.envMutations).toEqual([]);
    expect(report.chdirs).toEqual([]);
    expect(report.cwdChanged).toBe(false);
    // The loader has to read the modules it loads; that is not discovery, and it is counted
    // separately so "no data reads" cannot be satisfied by simply not looking.
    expect(report.moduleReadCount as number).toBeGreaterThan(0);
  });

  it("still gives a host what it came for", () => {
    expect(report.exports).toEqual(
      expect.arrayContaining([
        "fire",
        "runTick",
        "discover",
        "Trust",
        "State",
        "buildSessionLines",
        "parseSessionLines",
        "renderListing",
        "computeStatuses",
      ]),
    );
  });
});
