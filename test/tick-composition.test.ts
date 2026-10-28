/** Who has to compose a transport, and who keeps their default. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { runTick } from "../src/tick.js";
import { runPiTick } from "../src/hosts/pi/tick.js";
import { readRecords } from "../src/records.js";
import { automationIn, isolatedHome, proveIsolated } from "./helpers/isolated-env.js";
import { cleanupTempDirs, keepTempDir, tempDir } from "./helpers/temp.js";
import { armUserRoot } from "./helpers/arm.js";

afterAll(cleanupTempDirs);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

/** A user automation due every five minutes, in its own root. */
function fixture(opts: { cron?: string } = {}) {
  const home = tempDir("pi-tickcomp-");
  const root = path.join(home, "automations");
  const dir = path.join(root, "due-one");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: due-one\ndescription: A test automation.\non:\n  schedule:\n    cron: "${opts.cron ?? "*/5 * * * *"}"\n    timezone: UTC\n---\n\nDo the thing.\n`,
  );
  const stateDir = tempDir("pi-tickcomp-state-");
  armUserRoot(root, stateDir);
  return { root, dir, stateDir };
}

function claims(stateDir: string): Record<string, string> {
  const file = path.join(stateDir, "state.json");
  if (!existsSync(file)) return {};
  return (JSON.parse(readFileSync(file, "utf8")) as { claimed?: Record<string, string> }).claimed ?? {};
}

const ROOTS = (root: string) => [{ path: root, scope: "user" as const, kind: "agents" as const }];

/** Every `failed` record under a state directory, across all automations. */
function terminalRecords(stateDir: string): unknown[] {
  const runs = path.join(stateDir, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs).flatMap((f) =>
    readFileSync(path.join(runs, f), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { outcome?: string })
      .filter((r) => r.outcome === "failed"),
  );
}

describe("the portable tick will not compile without a transport", () => {
  const fixtureFile = path.join(REPO, "test", "fixtures", "bad-portable-tick.ts");
  const tsc = path.join(REPO, "node_modules", "typescript", "bin", "tsc");

  const diagnostics = (() => {
    expect(existsSync(fixtureFile)).toBe(true);
    try {
      execFileSync(
        process.execPath,
        [tsc, "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--skipLibCheck", fixtureFile],
        { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      return "";
    } catch (e) {
      return String((e as { stdout?: string }).stdout ?? "");
    }
  })();

  it("compiles the fixture and actually reports errors", () => {
    // Without this every expectation below would pass vacuously against an empty string.
    expect(diagnostics).not.toBe("");
    expect(diagnostics).toContain("bad-portable-tick.ts");
  });

  it("refuses an omitted transport — the composition that used to be allowed", () => {
    expect(diagnostics).toMatch(/spawnFire/);
  });

  it("refuses a transport that answers nothing, or answers the wrong thing", () => {
    // `() => {}` is the fire-and-forget shape every old fake had. It must not satisfy the contract
    // any more, or `fired` would again mean "we called something".
    expect(diagnostics).toMatch(/not assignable/);
  });
});

describe("the published surfaces keep their HEAD default", () => {
  /** Drive one published path in a child with its own HOME, USERPROFILE, PI_AGENT_DIR and cwd. */
  function driveDefault(kind: "root" | "serve", cron: string) {
    const iso = isolatedHome(`pi-default-${kind}-`);
    const dir = automationIn(
      iso,
      "due-one",
      `on:\n  schedule:\n    cron: "${cron}"\n    timezone: UTC\nhooks:\n  pre:\n    - script: stop.js\n`,
      {
        // A script hook exiting non-zero is the documented way a run stops before its body. The
        // marker proves the hook actually executed; hooks are given only `AUTOMATION_*`, so it is
        // written next to the automation rather than under the state directory.
        "stop.js":
          'const fs=require("node:fs"),p=require("node:path");\n' +
          'fs.writeFileSync(p.join(process.env.AUTOMATION_DIR,"prehook-marker.json"),JSON.stringify({key:process.env.AUTOMATION_KEY,phase:process.env.AUTOMATION_PHASE,index:process.env.AUTOMATION_HOOK_INDEX,pid:process.pid}));\n' +
          "process.exit(3);\n",
      },
    );

    // Refuses before any child runs if state or discovery would reach outside the fixture.
    const resolved = proveIsolated(iso);

    const deny = path.join(REPO, "test", "fixtures", "portable-deny-sdk.mjs");
    // Permits model selection so the run reaches its hooks, and refuses session startup,
    // notification and scheduler registration so it can never reach a vendor or the machine.
    const host = path.join(REPO, "test", "fixtures", "default-host-loader.mjs");
    const exitReceipt = path.join(iso.home, "worker-exit.txt");
    // Anything that leaves the worker unaccounted for keeps the fixture: a timeout, a child that
    // died before printing, an unparseable report, or an exit that could not be proven. Deleting it
    // would race a process that may still be writing and destroy the only evidence.
    let out: string;
    try {
      out = execFileSync(
        process.execPath,
        [path.join(REPO, "test", "fixtures", "isolated-tick-host.mjs"), REPO, kind, `user:${iso.roots}:due-one`],
        {
          encoding: "utf8",
          cwd: iso.cwd,
          windowsHide: true,
          timeout: 120_000,
          env: {
            ...iso.env,
            // Inherited by the worker the tick spawns, so both reach both processes.
            NODE_OPTIONS: `--import ${pathToFileURL(deny).href} --import ${pathToFileURL(host).href}`,
            PORTABLE_DENIAL_RECEIPT: path.join(iso.home, "denial-receipt.txt"),
            DEFAULT_HOST_PKG: REPO,
            WORKER_EXIT_RECEIPT: exitReceipt,
          },
        },
      );
    } catch (e) {
      throw new Error(
        `the ${kind} host did not complete; its fixture is preserved at ${keepTempDir(iso.home)} — ${(e as Error).message}`,
      );
    }

    // The entire stdout, so a stray write corrupts the parse rather than being skipped over.
    let report: {
      error: string | null;
      stateDir: string;
      summary: { fired: string[]; failed: string[]; uncertain: { key: string }[]; missed: string[] } | null;
      worker: { key: string; outcome: string; reason: string | null; scheduledFor: string | null } | null;
      workerRecords: number;
      workerExit: { pid: number; code: number } | null;
      workerGone: boolean | null;
      missed: number;
      records: { key: string; outcome: string; reason: string | null }[];
    };
    try {
      report = JSON.parse(out.trim());
    } catch (e) {
      throw new Error(
        `the ${kind} host printed no usable report; its fixture is preserved at ${keepTempDir(iso.home)} — ${(e as Error).message}`,
      );
    }
    // An exit that was never observed leaves a worker that may still be writing into this home.
    if (report.workerGone !== true && process.env.EXPECT_WORKER !== "0") keepTempDir(iso.home);
    return { iso, dir, resolved, report };
  }

  /** What every path must show: the hook ran, the worker finished, and it left one record. */
  function expectWorkerFinished(
    report: {
      stateDir: string;
      worker: { outcome: string; reason: string | null } | null;
      workerRecords: number;
      workerExit: { pid: number; code: number } | null;
      workerGone: boolean | null;
    },
    iso: { home: string },
    dir: string,
  ): void {
    // Written under the fixture, which is the half a tick-options-only test could never check.
    expect(report.stateDir.toLowerCase()).toContain(iso.home.toLowerCase());

    // The worker's own record, not a catch-up `missed` row the tick wrote without starting
    // anything, and exactly one of them for this key and instant.
    expect(report.worker).not.toBeNull();
    expect(report.workerRecords).toBe(1);
    const rec = report.worker as { outcome: string; reason: string | null };

    // The run reached its pre hook and stopped there, which is the whole point of the proof: a
    // startup failure or a worker that found no automation cannot produce this.
    const marker = JSON.parse(readFileSync(path.join(dir, "prehook-marker.json"), "utf8")) as {
      phase: string;
      index: string;
    };
    expect(marker.phase).toBe("pre");
    expect(marker.index).toBe("0");
    expect(rec.outcome).toBe("skipped");
    expect(rec.reason).toBe("pre[0] stop.js exited 3");

    // Finished, rather than merely having written something before teardown raced it, and with the
    // exit code a skipped run documents.
    expect(report.workerExit).not.toBeNull();
    expect(report.workerExit?.code).toBe(10);
    expect(Number.isInteger(report.workerExit?.pid)).toBe(true);
    expect(report.workerExit?.pid).toBeGreaterThan(0);
    expect(report.workerGone).toBe(true);
  }

  /** The record belongs to the automation that was due, at the instant the tick claimed. */
  function expectClaimedInstant(
    report: { worker: { key: string; scheduledFor: string | null } | null; stateDir: string },
    key: string,
  ): void {
    expect(report.worker?.key).toBe(key);
    const scheduledFor = report.worker?.scheduledFor ?? "";
    expect(scheduledFor, "the worker record carries no instant").not.toBe("");

    const state = JSON.parse(readFileSync(path.join(report.stateDir, "state.json"), "utf8")) as {
      claimed?: Record<string, string>;
    };
    // The same instant the tick wrote down, not merely some instant.
    expect(state.claimed?.[key]).toBe(scheduledFor);
  }

  it("runs a due automation through the package root with no transport supplied", () => {
    const { iso, dir, report } = driveDefault("root", "*/5 * * * *");

    expect(report.error).toBeNull();
    // An attempt is not enough: the launch must have been acknowledged, with nothing failed and
    // nothing uncertain, or a startup failure would pass as a working default.
    expect(report.summary?.failed).toEqual([]);
    expect(report.summary?.uncertain).toEqual([]);
    expect(report.summary?.fired).toHaveLength(1);
    expectWorkerFinished(report, iso, dir);
    expectClaimedInstant(report, `user:${iso.roots}:due-one`);
  }, 180_000);

  it("runs a due automation through detached serve with no transport supplied", () => {
    const { iso, dir, report } = driveDefault("serve", "*/5 * * * *");

    expect(report.error).toBeNull();
    expectWorkerFinished(report, iso, dir);
    expectClaimedInstant(report, `user:${iso.roots}:due-one`);
  }, 180_000);

  it("runPiTick is a pass-through when the caller supplies one", async () => {
    const f = fixture();
    const spawned: string[][] = [];

    const summary = await runPiTick({
      stateDir: f.stateDir,
      roots: ROOTS(f.root),
      spawnFire: async (args) => {
        spawned.push([...args]);
        return { ok: true, pid: 4242 };
      },
    });

    // The supplied transport was used, so the facade added no policy of its own.
    expect(spawned.length).toBeGreaterThan(0);
    expect(summary?.fired.length).toBeGreaterThan(0);
  });

  it("the root entry exports the pi-defaulting tick and the core entry the strict one", async () => {
    const root = await import("../src/index.js");
    const core = await import("../src/core/index.js");
    const neutral = await import("../src/tick.js");
    const pi = await import("../src/hosts/pi/tick.js");

    expect(root.runTick).toBe(pi.runPiTick);
    expect(core.runTick).toBe(neutral.runTick);
  });
});

/**
 * A JavaScript caller can always get past the compiler, so the runtime has to hold the line too.
 */
describe("a JavaScript caller with no usable transport", () => {
  /** What every case below asserts once the call has been refused. */
  function nothingConsumed(stateDir: string): void {
    // ZERO claims. Not "an uncertain claim that is kept" — nothing at all, so the instant is still
    // there for the next properly composed tick. This is the exact value that regressed: `p6a`
    // recorded `afterClaimed` holding `2026-09-21T00:10:00Z` with zero spawn calls.
    expect(claims(stateDir)).toEqual({});
    // A host that cannot start anything has a host fault, not a run outcome, so it writes no
    // terminal record. An older `missed` catch-up row can exist — it does in the p6 control too —
    // so the question is about terminal outcomes, not about the runs directory existing.
    expect(terminalRecords(stateDir)).toEqual([]);
  }

  it("is refused before any claim when the transport is omitted", async () => {
    const f = fixture();
    await expect(
      runTick({ stateDir: f.stateDir, roots: ROOTS(f.root) } as unknown as Parameters<typeof runTick>[0]),
    ).rejects.toThrow(/composed no worker transport/);
    nothingConsumed(f.stateDir);
  });

  for (const [name, value] of [
    ["null", null],
    ["a string", "bin/fire.js"],
    ["a number", 0],
    ["an object", {}],
    ["an array", []],
  ] as const) {
    it(`is refused before any claim when the transport is ${name}`, async () => {
      const f = fixture();

      await expect(
        runTick({
          stateDir: f.stateDir,
          roots: ROOTS(f.root),
          spawnFire: value as unknown as Parameters<typeof runTick>[0]["spawnFire"],
        }),
      ).rejects.toThrow(/composed no worker transport/);

      nothingConsumed(f.stateDir);
    });
  }

  it("says what is wrong and that nothing was consumed", async () => {
    const f = fixture();
    await expect(
      runTick({ stateDir: f.stateDir, roots: ROOTS(f.root) } as unknown as Parameters<typeof runTick>[0]),
    ).rejects.toThrow(/spawnFire is missing/);
    await expect(
      runTick({ stateDir: f.stateDir, roots: ROOTS(f.root), spawnFire: "x" } as unknown as Parameters<typeof runTick>[0]),
    ).rejects.toThrow(/spawnFire is string/);
    await expect(
      runTick({ stateDir: f.stateDir, roots: ROOTS(f.root) } as unknown as Parameters<typeof runTick>[0]),
    ).rejects.toThrow(/No instant was claimed/);
  });

  it("does NOT refuse a callable transport that merely answers badly — that is real uncertainty", async () => {
    const f = fixture();

    // Callable, so the tick proceeds and launches. What comes back is unusable, and THAT is
    // post-launch uncertainty: a worker may be running, so the claim is kept and no terminal record
    // is written. The two cases must not collapse into one another.
    const summary = await runTick({
      stateDir: f.stateDir,
      roots: ROOTS(f.root),
      spawnFire: (async () => ({ ok: true })) as unknown as Parameters<typeof runTick>[0]["spawnFire"],
    });

    const uncertain = summary?.uncertain ?? [];
    expect(uncertain.length).toBeGreaterThan(0);

    const key = (uncertain[0] as { key: string }).key;
    const claimed = claims(f.stateDir)[key];
    expect(claimed).toBeTruthy();

    // There IS a record here — a `missed` one, for an older catch-up instant, which the p6 control
    // also carried. What must not exist is a terminal record for the instant just claimed.
    expect(readRecords(f.stateDir, key, 50).filter((r) => r.scheduledFor === claimed)).toHaveLength(0);
  });
});
