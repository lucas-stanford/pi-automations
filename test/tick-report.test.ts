/** A tick that could not start a run has to say so. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { runTick } from "../src/tick.js";
import type { StartRun } from "../src/core/contracts.js";
import { automationIn, isolatedHome, proveIsolated } from "./helpers/isolated-env.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";
import { armUserRoot } from "./helpers/arm.js";

afterAll(cleanupTempDirs);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

function fixture(opts: { cron?: string } = {}) {
  const home = tempDir("pi-report-");
  const root = path.join(home, "automations");
  const dir = path.join(root, "due-one");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: due-one\ndescription: A test automation.\non:\n  schedule:\n    cron: "${opts.cron ?? "*/5 * * * *"}"\n    timezone: UTC\n---\n\nDo the thing.\n`,
  );
  const stateDir = tempDir("pi-report-state-");
  armUserRoot(root, stateDir);
  return { root, stateDir };
}

const ROOTS = (root: string) => [{ path: root, scope: "user" as const, kind: "agents" as const }];

describe("what the summary now carries", () => {
  it("gives an uncertain launch its reason, because it has no record to carry one", async () => {
    const f = fixture();
    const summary = await runTick({
      stateDir: f.stateDir,
      roots: ROOTS(f.root),
      spawnFire: (async () => ({ ok: true })) as unknown as StartRun,
    });

    const uncertain = summary?.uncertain ?? [];
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]?.key).toBeTruthy();
    expect(uncertain[0]?.reason).toContain("no usable pid");
  });

  it("keeps the key, so callers can still deduplicate by automation", async () => {
    const f = fixture();
    const summary = await runTick({
      stateDir: f.stateDir,
      roots: ROOTS(f.root),
      spawnFire: (async () => ({ ok: true })) as unknown as StartRun,
    });

    const keys = (summary?.uncertain ?? []).map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toMatch(/due-one$/);
  });

  it("leaves a confirmed failure as a count — its record carries the error", async () => {
    const f = fixture();
    const summary = await runTick({
      stateDir: f.stateDir,
      roots: ROOTS(f.root),
      spawnFire: async () => ({ ok: false, reason: "the entrypoint is missing" }),
    });

    expect(summary?.failed).toHaveLength(1);
    expect(summary?.uncertain).toEqual([]);
  });
});

describe("the CLI tick command", () => {
  /** Runs `bin/pi-automations.js tick` for real, in an owned home. */
  function cli(iso: ReturnType<typeof isolatedHome>, extra: string[] = []): string {
    proveIsolated(iso);
    return execFileSync(
      process.execPath,
      [path.join(REPO, "bin", "pi-automations.js"), "tick", ...extra],
      { encoding: "utf8", windowsHide: true, timeout: 120_000, env: iso.env, cwd: iso.cwd },
    );
  }

  /** An owned home with one automation that is deliberately NOT due, so nothing can be started. */
  function quietHome(): ReturnType<typeof isolatedHome> {
    const iso = isolatedHome("pi-cli-quiet-");
    automationIn(iso, "not-due", 'on:\n  schedule:\n    cron: "0 0 1 1 *"\n    timezone: UTC\n');
    return iso;
  }
  it("prints a quiet tick exactly as it always has", () => {
    const out = cli(quietHome());

    // The compatibility promise: nothing is added when there is nothing to add.
    expect(out).toContain("fired 0");
    expect(out).not.toContain("failed ");
    expect(out).not.toContain("uncertain ");
  }, 90_000);

  it("emits valid JSON carrying every field, including the reasons", () => {
    const out = cli(quietHome(), ["--json"]);

    // Parsed, not pattern-matched: the point is that the addition cannot corrupt it, and the only
    // way to know that is to parse it.
    const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
    expect(Array.isArray(parsed.fired)).toBe(true);
    expect(Array.isArray(parsed.failed)).toBe(true);
    expect(Array.isArray(parsed.uncertain)).toBe(true);
    expect(Array.isArray(parsed.missed)).toBe(true);
  }, 90_000);
});

describe("driving a failed-only and an uncertain-only tick through the real channels", () => {
  const LOADER = path.join(REPO, "test", "fixtures", "report-tick-loader.mjs");
  const FAILED_REASON = "REPORT-FIXTURE-CONFIRMED-FAILURE-4b21";

  /** An owned home with one automation that is due, proven isolated before any child runs. */
  function dueHome(label: string) {
    const iso = isolatedHome(label);
    automationIn(iso, "due-one", 'on:\n  schedule:\n    cron: "*/5 * * * *"\n    timezone: UTC\n');
    proveIsolated(iso);
    return iso;
  }

  function run(iso: ReturnType<typeof isolatedHome>, mode: "failed" | "uncertain", script: string[], extra: string[] = [], env: Record<string, string> = {}): string {
    return execFileSync(
      process.execPath,
      ["--import", pathToFileURL(LOADER).href, ...script, ...extra],
      {
        encoding: "utf8",
        cwd: iso.cwd,
        windowsHide: true,
        timeout: 120_000,
        env: { ...iso.env, REPORT_PKG: REPO, REPORT_MODE: mode, ...env },
      },
    );
  }

  const tickJs = [path.join(REPO, "bin", "tick.js")];
  const cliJs = [path.join(REPO, "bin", "pi-automations.js"), "tick"];

  /** Every terminal record under a fixture's state directory. */
  function terminalRecords(stateDir: string): { outcome?: string; error?: { message?: string } }[] {
    const runs = path.join(stateDir, "runs");
    if (!existsSync(runs)) return [];
    return readdirSync(runs).flatMap((f) =>
      readFileSync(path.join(runs, f), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { outcome?: string; error?: { message?: string } })
        .filter((r) => r.outcome === "failed" || r.outcome === "ok"),
    );
  }

  it("bin/tick.js reports a confirmed failure, whose reason lives in its record", () => {
    const iso = dueHome("pi-rep-tick-failed-");
    const out = run(iso, "failed", tickJs);

    expect(out).toContain("failed 1");
    expect(out).toContain("fired 0");
    // Not reported as uncertain: the transport said plainly that it did not start.
    expect(out).not.toContain("uncertain ");

    // Exactly one record, carrying the reason — which is why the tick line does not repeat it.
    const failed = terminalRecords(iso.stateDir);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error?.message ?? "").toContain(FAILED_REASON);
  }, 180_000);

  it("bin/tick.js reports an uncertain launch, its reason, and writes no record", () => {
    const iso = dueHome("pi-rep-tick-uncertain-");
    const out = run(iso, "uncertain", tickJs);

    expect(out).toContain("uncertain 1");
    expect(out).toContain("fired 0");
    // The reason has to be printed: an uncertain launch has no record to read it from.
    expect(out).toMatch(/uncertain .*: .*no usable pid/);

    // There is genuinely no terminal record.
    expect(terminalRecords(iso.stateDir)).toEqual([]);

    // The claim is kept, so nothing re-fires it into a possible duplicate.
    const state = JSON.parse(readFileSync(path.join(iso.stateDir, "state.json"), "utf8")) as {
      claimed?: Record<string, string>;
    };
    expect(Object.keys(state.claimed ?? {}).length).toBeGreaterThan(0);
  }, 180_000);

  it("the CLI text output reports both, with the uncertain reason", () => {
    const failed = run(dueHome("pi-rep-cli-failed-"), "failed", cliJs);
    expect(failed).toContain("failed 1");

    const uncertain = run(dueHome("pi-rep-cli-uncertain-"), "uncertain", cliJs);
    expect(uncertain).toContain("uncertain 1");
    expect(uncertain).toMatch(/uncertain .*: .*no usable pid/);
  }, 180_000);

  /** The whole document, so a stray write before it corrupts the parse instead of hiding. */
  function jsonTick(mode: "failed" | "uncertain") {
    const out = run(dueHome(`pi-rep-json-${mode}-`), mode, cliJs, ["--json"]);
    return JSON.parse(out.trim()) as {
      fired: string[];
      failed: string[];
      uncertain: { key: string; reason: string }[];
      missed: string[];
    };
  }

  it("the CLI --json output carries an uncertain launch with its reason", () => {
    const parsed = jsonTick("uncertain");

    expect(parsed.fired).toEqual([]);
    expect(parsed.failed).toEqual([]);
    expect(parsed.uncertain).toHaveLength(1);
    expect(parsed.uncertain[0]?.reason).toContain("no usable pid");
    expect(parsed.uncertain[0]?.key).toMatch(/due-one$/);
  }, 180_000);

  it("the CLI --json output carries a confirmed failure as a key, not a reason", () => {
    const parsed = jsonTick("failed");

    expect(parsed.fired).toEqual([]);
    expect(parsed.uncertain).toEqual([]);
    // A key, because the reason is in the record this launch earned.
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0]).toMatch(/due-one$/);
  }, 180_000);

  /** `serve` returns no summary, so its log is the only place it says anything. */
  function serveLog(mode: "failed" | "uncertain") {
    const iso = dueHome(`pi-rep-serve-${mode}-`);
    const driver = path.join(REPO, "test", "fixtures", "isolated-tick-host.mjs");
    // This transport never spawns, so waiting for a worker would only waste the timeout.
    const out = run(iso, mode, [driver, REPO, "serve", `user:${iso.roots}:due-one`], [], {
      EXPECT_WORKER: "0",
    });
    const report = JSON.parse(out.trim()) as { worker: unknown; serveLog: string[] };
    expect(report.worker).toBeNull();
    return report.serveLog.join("\n");
  }

  it("the serve log reports an uncertain-only tick, which it used to drop entirely", () => {
    const log = serveLog("uncertain");

    expect(log).toMatch(/uncertain 1/);
    expect(log).toMatch(/uncertain .*: .*no usable pid/);
  }, 180_000);

  it("the serve log reports a failed-only tick, which it also used to drop", () => {
    const log = serveLog("failed");

    expect(log).toMatch(/failed 1/);
    // A confirmed failure earns a record, so the line counts it rather than repeating the reason.
    expect(log).not.toMatch(/uncertain 1/);
  }, 180_000);

});
