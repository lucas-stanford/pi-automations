/** `piEnv`, executed. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, "..", "src", "hosts", "pi", "extension.ts");

const KEY = "PI_AUTOMATIONS_PI_MODULE";

type Locator = (opts?: { configured?: string | undefined }) => { dir?: string } | undefined;

/** The real function, compiled out of the real file. */
function loadPiEnv(): (
  env: NodeJS.ProcessEnv,
  findPiModule: Locator,
  config?: { piModule?: string },
) => NodeJS.ProcessEnv {
  const src = readFileSync(EXTENSION, "utf8");
  const from = src.indexOf("function piEnv(");
  const to = src.indexOf("function spawnFire(");
  expect(from, "piEnv is no longer in the extension").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);

  const js = transformSync(src.slice(from, to), { loader: "ts" }).code;
  // `process`, the two imports and the config it closes over are supplied, so nothing here touches
  // the real environment, the real locator or the real config.
  const build = new Function(
    "process",
    "PI_MODULE_ENV",
    "findPiModule",
    "config",
    `${js}\nreturn piEnv;`,
  ) as (
    proc: { env: NodeJS.ProcessEnv },
    key: string,
    findPiModule: Locator,
    config: () => { piModule?: string },
  ) => () => NodeJS.ProcessEnv;

  return (env, findPiModule, config = {}) => build({ env }, KEY, findPiModule, () => config)();
}

describe("the launch environment a spawned run is given", () => {
  const piEnv = loadPiEnv();

  it("survives a locator that throws, and changes nothing", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/owned/path" };
    let calls = 0;

    const out = piEnv(env, () => {
      calls += 1;
      // What an older cached dist produces: the binding is there but is not callable.
      throw new TypeError("findPiModule is not a function");
    });

    // The same object, not a copy with the hint missing — nothing was rebuilt.
    expect(out).toBe(env);
    expect(out[KEY]).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("honours an inherited hint without consulting the locator", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/owned/path", [KEY]: "/owned/inherited-pi" };
    let calls = 0;

    const out = piEnv(env, () => {
      calls += 1;
      return { dir: "/owned/discovered-pi" };
    });

    // The session that spawned us already decided which pi to use.
    expect(out).toBe(env);
    expect(out[KEY]).toBe("/owned/inherited-pi");
    expect(calls).toBe(0);
  });

  it("adds the hint when there is none and the locator finds one", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/owned/path" };

    const out = piEnv(env, () => ({ dir: "/owned/discovered-pi" }));

    expect(out).not.toBe(env);
    expect(out[KEY]).toBe("/owned/discovered-pi");
    expect(out.PATH).toBe("/owned/path");
    // The caller's own environment is never mutated.
    expect(env[KEY]).toBeUndefined();
  });

  it("hands the locator piModule from config, so a background run finds that pi", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/owned/path" };
    let asked: string | undefined;

    const out = piEnv(
      env,
      (opts) => {
        asked = opts?.configured;
        return { dir: opts?.configured };
      },
      { piModule: "/owned/configured-pi" },
    );

    expect(asked).toBe("/owned/configured-pi");
    expect(out[KEY]).toBe("/owned/configured-pi");
  });

  it("changes nothing when the locator finds no pi", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/owned/path" };

    expect(piEnv(env, () => undefined)).toBe(env);
    expect(piEnv(env, () => ({}))).toBe(env);
  });
});
