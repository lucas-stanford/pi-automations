import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULTS, loadConfig, ms } from "../src/config.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

function withConfig(value: unknown): { config: ReturnType<typeof loadConfig>["config"]; warnings: string[] } {
  const dir = tempDir("pi-config-");
  writeFileSync(path.join(dir, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
  return loadConfig(dir);
}

describe("loadConfig", () => {
  it("returns the documented defaults when there is no file", () => {
    const { config, warnings } = loadConfig(tempDir("pi-noconfig-"));
    expect(config).toEqual(DEFAULTS);
    expect(warnings).toEqual([]);
  });

  it("does not warn about a missing file — no config is the normal case", () => {
    expect(loadConfig(tempDir("pi-noconfig2-")).warnings).toEqual([]);
  });

  it("accepts a partial file and fills the rest from defaults", () => {
    const { config, warnings } = withConfig({ grace: "5m", notifyOnFailed: false });
    expect(config.grace).toBe("5m");
    expect(config.notifyOnFailed).toBe(false);
    expect(config.defaultTimeout).toBe(DEFAULTS.defaultTimeout);
    expect(warnings).toEqual([]);
  });

  it("warns about an unknown key and ignores it", () => {
    const { config, warnings } = withConfig({ budget: 10 });
    expect(warnings).toContain("config.json: budget: unknown key — ignored");
    expect(config).toMatchObject({ grace: DEFAULTS.grace });
  });

  it("warns and falls back when a duration is not a duration", () => {
    const { config, warnings } = withConfig({ grace: "ten minutes" });
    expect(config.grace).toBe(DEFAULTS.grace);
    expect(warnings).toEqual([
      'config.json: grace: "ten minutes" is not a duration — using 10m',
    ]);
  });

  it("allows days in config durations, unlike the file format", () => {
    const { config, warnings } = withConfig({ catchUpWindow: "14d", consentExpiry: "60d" });
    expect(config.catchUpWindow).toBe("14d");
    expect(config.consentExpiry).toBe("60d");
    expect(warnings).toEqual([]);
  });

  it("warns and falls back on a wrongly typed number", () => {
    const { config, warnings } = withConfig({ staggerMaxSeconds: "lots" });
    expect(config.staggerMaxSeconds).toBe(DEFAULTS.staggerMaxSeconds);
    expect(warnings[0]).toMatch(/staggerMaxSeconds/);
  });

  it("accepts a zero stagger, which switches staggering off", () => {
    const { config, warnings } = withConfig({ staggerMaxSeconds: 0 });
    expect(config.staggerMaxSeconds).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("rejects a negative number rather than storing it", () => {
    const { config } = withConfig({ hookMaxOutputBytes: -1 });
    expect(config.hookMaxOutputBytes).toBe(DEFAULTS.hookMaxOutputBytes);
  });

  it("validates the retention object key by key", () => {
    const { config, warnings } = withConfig({
      retention: { maxLinesPerAutomation: 50, keepLines: 0, nonsense: 1 },
    });
    expect(config.retention.maxLinesPerAutomation).toBe(50);
    // keepLines: 0 is rejected, so the default (500) applies — and is then clamped down to
    // maxLinesPerAutomation, because keeping more lines than the file may hold is incoherent.
    expect(config.retention.keepLines).toBe(50);
    expect(warnings.some((w) => w.includes("retention.keepLines"))).toBe(true);
    expect(warnings.some((w) => w.includes("retention.nonsense"))).toBe(true);
  });

  it("clamps keepLines so rotation cannot grow the file", () => {
    const { config, warnings } = withConfig({
      retention: { maxLinesPerAutomation: 100, keepLines: 900 },
    });
    expect(config.retention.keepLines).toBe(100);
    expect(warnings.some((w) => w.includes("cannot exceed"))).toBe(true);
  });

  it("reads the worktree opt-in map", () => {
    const { config, warnings } = withConfig({ worktree: { "repository:/r:x": true } });
    expect(config.worktree["repository:/r:x"]).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("ignores a non-boolean worktree entry", () => {
    const { config, warnings } = withConfig({ worktree: { "repository:/r:x": "yes" } });
    expect(config.worktree["repository:/r:x"]).toBeUndefined();
    expect(warnings.some((w) => w.includes("worktree"))).toBe(true);
  });

  it("survives a corrupt file with defaults and one warning", () => {
    const { config, warnings } = withConfig("{ not json");
    expect(config).toEqual(DEFAULTS);
    expect(warnings).toHaveLength(1);
  });

  it("refuses a JSON array at the root", () => {
    const { config, warnings } = withConfig([1, 2]);
    expect(config).toEqual(DEFAULTS);
    expect(warnings).toEqual(["config.json: must be a JSON object — using defaults"]);
  });

  it("never mutates DEFAULTS across loads", () => {
    withConfig({ retention: { maxLinesPerAutomation: 7 }, worktree: { a: true } });
    expect(DEFAULTS.retention.maxLinesPerAutomation).toBe(2000);
    expect(DEFAULTS.worktree).toEqual({});
  });
});

describe("ms", () => {
  it("converts each duration field", () => {
    expect(ms(DEFAULTS, "grace")).toBe(600_000);
    expect(ms(DEFAULTS, "defaultTimeout")).toBe(1_200_000);
    expect(ms(DEFAULTS, "maxTimeout")).toBe(14_400_000);
    expect(ms(DEFAULTS, "hookTimeout")).toBe(60_000);
    expect(ms(DEFAULTS, "catchUpWindow")).toBe(604_800_000);
    expect(ms(DEFAULTS, "consentExpiry")).toBe(2_592_000_000);
  });

  it("falls back to the default when handed a hand-built config", () => {
    expect(ms({ ...DEFAULTS, grace: "nonsense" }, "grace")).toBe(600_000);
  });
});
