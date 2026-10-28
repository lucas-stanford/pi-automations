/** The portable host proof. */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, keepTempDir, tempDir } from "./helpers/temp.js";

let preservationControl: string | undefined;
let cleanupControl: string | undefined;
afterAll(() => {
  cleanupTempDirs();
  if (preservationControl === undefined || cleanupControl === undefined) return;
  try {
    expect(existsSync(preservationControl), "unconfirmed fixture survived cleanup").toBe(true);
    expect(existsSync(cleanupControl), "ordinary fixture was cleaned").toBe(false);
  } finally {
    // This control has no process; it only exercises retention.
    rmSync(preservationControl, { recursive: true, force: true });
  }
});

async function waitForTickExit(exited: Promise<number | null>, withinMs: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`tick parent did not exit within ${withinMs}ms`)), withinMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const PKG = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const DENY = pathToFileURL(path.join(FIXTURES, "portable-deny-sdk.mjs")).href;
const LIFECYCLE = path.join(FIXTURES, "portable-lifecycle.mjs");
const WORKER = path.join(FIXTURES, "portable-worker.js");
const RUNTIME = path.join(FIXTURES, "portable-runtime.mjs");
const TICK_LOADER = pathToFileURL(path.join(FIXTURES, "portable-tick-loader.mjs")).href;
const CORE = path.join(PKG, "dist", "core", "index.js");
const TICK = path.join(PKG, "bin", "tick.js");

const AUTOMATION = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: A portable automation.\n${extra}---\n\nSay something.\n`;

// The REAL installed SDK entry, resolved the way `importPi` resolves it — and checked to exist.
//
// Resolved HERE, outside any denial, because a control that points at a name nobody installed
// proves only that a string was matched. This is the file the denial has to refuse.
const SDK_ENTRY = (() => {
  const dir = path.join(PKG, "node_modules", "@earendil-works", "pi-coding-agent");
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
    main?: string;
    exports?: unknown;
  };
  const fromExports = (e: unknown): string | undefined => {
    if (!e || typeof e !== "object") return undefined;
    const root = (e as Record<string, unknown>)["."] ?? e;
    if (typeof root === "string") return root;
    if (!root || typeof root !== "object") return undefined;
    for (const k of ["import", "module", "default", "require"]) {
      const v = (root as Record<string, unknown>)[k];
      if (typeof v === "string") return v;
    }
    return undefined;
  };
  const rel =
    typeof pkg.exports === "string" ? pkg.exports : (fromExports(pkg.exports) ?? pkg.main ?? "index.js");
  const entry = path.join(dir, rel);
  if (!existsSync(entry)) throw new Error(`the real SDK entry does not exist: ${entry}`);
  return entry;
})();

/** Run one lifecycle mode in a child, under the SDK denial. Its last stdout line is the report. */
function lifecycle(mode: string, base: string): Record<string, unknown> {
  const r = spawnSync(process.execPath, ["--import", DENY, LIFECYCLE, mode, base], {
    encoding: "utf8",
    cwd: PKG,
    env: { ...process.env, PORTABLE_SDK_ENTRY: SDK_ENTRY },
    timeout: 60_000,
  });
  if (r.status !== 0) {
    throw new Error(`lifecycle ${mode} exited ${r.status}: ${r.stderr || r.stdout}`);
  }
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) throw new Error(`lifecycle ${mode} produced no report: ${r.stderr}`);
  return JSON.parse(last) as Record<string, unknown>;
}

describe("a host that is not pi", () => {
  it("refuses the SDK by bare specifier, with its own marker", () => {
    const r = lifecycle("control-bare", tempDir("portable-control-bare"));
    expect(r.denied).toBe(true);
    expect(r.hook, "a bare specifier must be caught by the resolve hook").toBe("resolve");
    expect(String(r.message)).toContain("PORTABLE-SDK-DENIED-8f3a1c");
    expect(String(r.message)).toContain("@earendil-works/pi-coding-agent");
  });

  it("refuses the REAL installed entry by file URL, which is how it is actually imported", () => {
    const r = lifecycle("control-url", tempDir("portable-control-url"));
    expect(r.target, "the control must point at the real entry, not a name").toContain(
      "pi-coding-agent",
    );
    expect(r.denied).toBe(true);
    // The load hook, not resolve: a file URL resolves fine and is refused when it is loaded. This
    // is the route `importPi` actually takes.
    expect(r.hook).toBe("load");
    expect(String(r.message)).toContain("PORTABLE-SDK-DENIED-8f3a1c");
  });

  it("is a denial, not a blanket refusal: an unrelated missing package fails normally", () => {
    const r = lifecycle("control-missing", tempDir("portable-control-missing"));
    expect(r.denied).toBe(false);
    expect(r.code).toBe("ERR_MODULE_NOT_FOUND");
    expect(String(r.message)).not.toContain("PORTABLE-SDK-DENIED");
  });

  it("runs a manual automation to a persisted record, a summary and an ordinary view", () => {
    const r = lifecycle("ok", tempDir("portable-ok"));
    expect(r.outcome).toBe("ok");
    expect(r.historyCount).toBe(1);
    expect(r.historyOutcome).toBe("ok");
    expect(r.summary).toBe("the portable answer");
    expect(r.sessionFormat).toBe("portable/v1");
    expect(r.sessionExists).toBe(true);
  });

  it("renders a real listing from real statuses", () => {
    const r = lifecycle("ok", tempDir("portable-listing"));
    const listing = r.listing as string[];
    expect(Array.isArray(listing)).toBe(true);
    // A header, a scope group and the automation itself — the lines a host would print.
    expect(listing.join("\n")).toContain("NAME");
    expect(listing.join("\n")).toContain("portable");
    expect(listing.some((l) => /USER/.test(l))).toBe(true);
    expect(String(r.statusLine)).toContain("automations");
  });

  it("renders the transcript it really wrote, through the same reader pair", () => {
    const r = lifecycle("ok", tempDir("portable-session"));
    expect(r.sessionRead, "the portable transcript must decode through the composed readers").toBe(
      true,
    );
    const lines = r.sessionLines as string[];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("the portable answer");
  });

  it("records a failure with the reason the runtime gave", () => {
    const r = lifecycle("fail", tempDir("portable-fail"));
    expect(r.outcome).toBe("failed");
    expect(r.historyOutcome).toBe("failed");
    expect(String(r.summary)).toContain("the portable model refused");
  });

  it("stops on a cancel request for its run id, cooperatively", () => {
    const r = lifecycle("cancel", tempDir("portable-cancel"));
    expect(r.outcome).toBe("aborted");
    expect(r.reason).toBe("stopped by request");
    expect(r.historyOutcome).toBe("aborted");
  });

  it("reads a legacy pi transcript without loading the SDK, and says so when it cannot", () => {
    const r = lifecycle("decode", tempDir("portable-decode"));
    expect(r.legacyOk).toBe(true);
    expect(r.legacyLines).toEqual(["from a pi history"]);
    expect(r.legacyId).toBe("legacy-1");
    // An unknown tag is diagnosed whether the file is empty or missing entirely: the format is what
    // is unsupported, and having nothing to show is not an explanation.
    expect(r.unknownEmpty).toBe("mystery/v9");
    expect(r.unknownAbsent).toBe("other/v3");
    expect(String((r.diagnostic as string[])[0])).toContain("mystery/v9");
  });
});

describe("the detached leg, through the real tick", () => {
  const base = tempDir("portable-detached");
  const agentDir = path.join(base, "agent");
  const home = path.join(base, "home");
  const root = path.join(agentDir, "automations");
  const stateDir = path.join(agentDir, "pi-automations");
  const gate = path.join(base, "gate");
  const cwd = path.join(base, "cwd");
  const dirName = "portable-detached";

  /** The real key, taken from discovery — it embeds the root path, not just the directory name. */
  let key = "";
  let tickCode: number | null = null;
  let tickErr = "";
  let tickOut = "";
  let workerPid = 0;
  let runId = "";
  let lockedWhileTickRan = false;
  let recordsWhileGated: { id: string; outcome: string }[] = [];
  let aliveAfterTickExit = false;
  let receipts: { label: string; denied: boolean; entry: string }[] = [];

  /** Retained OUTSIDE beforeAll, so a setup that times out can still be cleaned up. */
  let tickChild: ReturnType<typeof spawn> | undefined;
  const receiptFile = path.join(base, "denial-receipts.jsonl");

  beforeAll(async () => {
    for (const d of [home, cwd, path.join(root, dirName)]) mkdirSync(d, { recursive: true });
    // Every five minutes, not every minute: the default catch-up window is seven days and
    // `ticksBetween` walks at most 10,000 instants, so a per-minute schedule seen for the first
    // time yields a newest instant ~80 minutes stale and is correctly decided "missed".
    writeFileSync(
      path.join(root, dirName, "AUTOMATION.md"),
      AUTOMATION("portable-detached", 'on:\n  schedule: "*/5 * * * *"\n'),
      "utf8",
    );

    const core = await import(path.join(PKG, "dist", "core", "index.js"));
    const found = core.discover({ roots: [{ path: root, scope: "user", kind: "agents" }] });
    const target = core.located(found)[0];
    if (!target) throw new Error(`fixture did not parse: ${JSON.stringify(found)}`);
    key = target.key;
    new core.Trust(stateDir).arm(target, core.digestOf(target), {}, new Date(), 0);

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_AGENT_DIR: agentDir,
      PORTABLE_PKG: PKG,
      PORTABLE_HOME: home,
      PORTABLE_AGENT_DIR: agentDir,
      PORTABLE_WORKER: WORKER,
      PORTABLE_CORE: CORE,
      PORTABLE_RUNTIME: RUNTIME,
      PORTABLE_ROOT: root,
      PORTABLE_STATE: stateDir,
      PORTABLE_SESSIONS: path.join(base, "sessions"),
      PORTABLE_GATE: gate,
      // The denial travels into the tick AND, through the loader's worker entry, into the worker.
      // Each self-verifies against the real entry and appends a receipt.
      PORTABLE_DENY_URL: DENY,
      PORTABLE_SDK_ENTRY: SDK_ENTRY,
      PORTABLE_DENIAL_RECEIPT: receiptFile,
    } as NodeJS.ProcessEnv;
    delete env.PORTABLE_MODE;
    delete env.PORTABLE_DENIAL_LABEL;
    delete env.PI_HOME;
    delete env.XDG_CONFIG_HOME;

    const tick = spawn(process.execPath, ["--import", DENY, "--import", TICK_LOADER, TICK], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    tickChild = tick;
    tick.on("error", (e) => {
      tickErr += `spawn failed: ${String(e)}`;
    });
    tick.stderr.on("data", (b) => {
      tickErr += String(b);
    });
    tick.stdout.on("data", (b) => {
      tickOut += String(b);
    });

    const exited = new Promise<number | null>((resolve) => {
      tick.on("exit", (c) => resolve(c));
      tick.on("error", () => resolve(null));
    });

    // Wait for the REAL run lock — written by the lifecycle inside the worker, not by this test.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const lock = core.readRunLock(stateDir, key);
      if (lock?.pid) {
        workerPid = lock.pid;
        runId = lock.runId;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    lockedWhileTickRan = Number.isInteger(workerPid) && workerPid > 0;
    if (!lockedWhileTickRan) throw new Error("the worker did not publish a usable pid");
    tickCode = await waitForTickExit(exited, 30_000);

    // The tick parent is gone. The worker is still holding the gate, so nothing it does can have
    // depended on the ticker staying alive.
    recordsWhileGated = core.readRecords(stateDir, key, 10);
    aliveAfterTickExit = isAlive(workerPid);

    writeFileSync(gate, "go", "utf8");

    const done = Date.now() + 30_000;
    while (Date.now() < done) {
      if (core.readRecords(stateDir, key, 10).some((r: { id: string }) => r.id === runId)) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    receipts = existsSync(receiptFile)
      ? readFileSync(receiptFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  }, 110_000);

  /** Bounded cleanup for both children this test owns. */
  afterAll(async () => {
    await cleanupOwnedFixture(
      base,
      gate,
      [
        { what: "tick", pid: tickChild?.pid ?? 0 },
        { what: "worker", pid: workerPid },
      ],
    );
  }, 30_000);

  it("carries the SDK denial into the tick AND the worker, proven against the real entry", () => {
    const labels = receipts.map((r) => r.label).sort();
    expect(labels, `receipts: ${JSON.stringify(receipts)}`).toEqual([
      "portable-worker.js",
      "tick.js",
    ]);
    for (const r of receipts) {
      expect(r.denied, `${r.label} did not refuse the SDK`).toBe(true);
      expect(r.entry).toBe(SDK_ENTRY);
    }
  });

  it("starts a worker that takes the real run lock", () => {
    expect(tickErr, tickErr).not.toContain("tick failed");
    expect(tickOut, `tick stdout: ${tickOut} stderr: ${tickErr}`).toContain("fired 1");
    expect(lockedWhileTickRan, `tick stdout: ${tickOut} stderr: ${tickErr}`).toBe(true);
    expect(workerPid).toBeGreaterThan(0);
  });

  it("lets the tick parent exit while the run is still going", () => {
    expect(tickCode).toBe(0);
    expect(aliveAfterTickExit).toBe(true);
    // The only record written by the time the parent was gone is the ticker's own bookkeeping for
    // the schedule instants it chose not to catch up on. The RUN has no record: it is still holding
    // the gate, so nothing about its outcome could have been decided yet.
    expect(recordsWhileGated.map((r) => r.id)).not.toContain(runId);
    expect(recordsWhileGated.every((r) => r.outcome === "missed")).toBe(true);
  });

  it("finishes the run after the parent is gone, with a real record and a normal view", async () => {
    const core = await import(path.join(PKG, "dist", "core", "index.js"));
    const record = core
      .readRecords(stateDir, key, 10)
      .find((r: { id: string }) => r.id === runId);
    expect(record, `no record for ${runId}`).toBeDefined();

    expect(record.outcome).toBe("ok");
    expect(record.trigger).toBe("schedule");
    expect(core.summaryLine(record, 180)).toBe("the detached answer");
    expect(record.session?.format).toBe("portable/v1");
    expect(existsSync(record.session.file)).toBe(true);

    // The normal viewer path, end to end: read the transcript the worker actually wrote, decode it
    // through the format seam with this host's decoder, and render it with the shared builder.
    const { decodePortableTranscript, PORTABLE_FORMAT } = await import(
      pathToFileURL(RUNTIME).href
    );
    // The same pair a host composes: pi's real decoder for untagged history, this host's for its
    // own. A stub returning [] here would not be legacy-readable composition.
    const read = core.decodeTranscript(readFileSync(record.session.file, "utf8"), record.session, {
      legacy: core.parseSessionLines,
      alternative: { format: PORTABLE_FORMAT, decode: decodePortableTranscript },
    });
    expect(read.ok).toBe(true);
    expect(core.buildSessionLines(read.parsed.lines, { width: 80 }).join("\n")).toContain(
      "the detached answer",
    );
  });
});

// Wait, bounded, until a pid is observably gone.
//
// Bounded because a test must not hang on a child that will not die, and observable because a
// terminal record only says a run finished, not that its process left.
async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Which owned children could not be shown to have exited. */
async function accountForOwned(
  owned: { what: string; pid: number }[],
  io: { gone: (pid: number, withinMs: number) => boolean | Promise<boolean> },
  withinMs = 10_000,
): Promise<string[]> {
  const unproven: string[] = [];
  for (const { what, pid } of owned) {
    if (!Number.isInteger(pid) || pid <= 0) {
      unproven.push(`${what}: no usable pid (${String(pid)})`);
      continue;
    }
    try {
      if (!(await io.gone(pid, withinMs))) unproven.push(`${what}: exit of pid ${pid} was not confirmed`);
    } catch (e) {
      unproven.push(`${what}: pid ${pid} — ${(e as NodeJS.ErrnoException)?.code ?? String(e)}`);
    }
  }
  return unproven;
}

async function cleanupOwnedFixture(
  base: string,
  gate: string,
  owned: { what: string; pid: number }[],
  io: { gone: (pid: number, withinMs: number) => boolean | Promise<boolean> } = { gone },
): Promise<void> {
  const unproven: string[] = [];
  try {
    if (!existsSync(gate)) writeFileSync(gate, "go", "utf8");
  } catch (e) {
    unproven.push(`could not release gate: ${String(e)}`);
  }
  unproven.push(...(await accountForOwned(owned, io)));
  if (unproven.length > 0) {
    const kept = keepTempDir(base);
    throw new Error(`owned children unaccounted for, fixture preserved at ${kept}: ${unproven.join("; ")}`);
  }
}

function isAlive(pid: number): boolean {
  // Only ESRCH means "no such process". EPERM means it is alive and owned by somebody else, and
  // reading that as gone would report a still-running worker as exited.
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${String(pid)}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    throw e;
  }
}

describe("a fixture is only deleted once its owned children are proven gone", () => {
  const never = () => false;
  const always = () => true;

  it("accepts a tick exit that was observed", async () => {
    expect(await waitForTickExit(Promise.resolve(0), 1000)).toBe(0);
  });

  it("bounds a tick exit that never settles, without starting a process", async () => {
    await expect(waitForTickExit(new Promise(() => {}), 20)).rejects.toThrow("did not exit within 20ms");
  }, 1000);

  it("accounts for a child that exited on its own", async () => {
    expect(await accountForOwned([{ what: "worker", pid: 4242 }], { gone: always })).toEqual([]);
  });

  it("refuses to call a child gone when the wait ran out", async () => {
    const out = await accountForOwned([{ what: "worker", pid: 4242 }], { gone: never });

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("was not confirmed");
  });

  it("refuses an unusable pid instead of skipping it quietly", async () => {
    for (const pid of [0, -1, Number.NaN, 1.5]) {
      const out = await accountForOwned([{ what: "worker", pid }], { gone: always });
      expect(out, `pid ${String(pid)}`).toHaveLength(1);
      expect(out[0]).toContain("no usable pid");
    }
  });

  it("reports an error the liveness check could not read, rather than assuming exit", async () => {
    const out = await accountForOwned([{ what: "worker", pid: 4242 }], {
      gone: () => {
        const e = new Error("no permission") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      },
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("EPERM");
  });

  it("names every unaccounted child, not just the first", async () => {
    const out = await accountForOwned(
      [
        { what: "tick", pid: 0 },
        { what: "worker", pid: 4242 },
      ],
      { gone: never },
    );

    expect(out).toHaveLength(2);
    expect(out.join(" ")).toContain("tick");
    expect(out.join(" ")).toContain("worker");
  });

  it("never interprets an invalid pid as proof of exit", () => {
    for (const pid of [0, -1, Number.NaN, 1.5]) expect(() => isAlive(pid)).toThrow(/invalid pid/);
  });

  it("retains an unconfirmed fixture through the actual global cleanup", async () => {
    preservationControl = tempDir("portable-preservation-control-");
    cleanupControl = tempDir("portable-cleanup-control-");
    await expect(cleanupOwnedFixture(
      preservationControl,
      path.join(preservationControl, "gate"),
      [{ what: "controlled worker", pid: 4242 }],
      { gone: never },
    )).rejects.toThrow(`fixture preserved at ${preservationControl}`);
    expect(readFileSync(path.join(preservationControl, "gate"), "utf8")).toBe("go");
  });
});