/** `fired` means a worker started. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { defaultSpawnFire, runTick } from "../src/tick.js";
import { launchLocalWorker } from "../src/providers/worker.js";
import { readRecords } from "../src/records.js";
import type { LaunchWorker, StartRun } from "../src/core/contracts.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";
import { armUserRoot } from "./helpers/arm.js";

afterAll(cleanupTempDirs);

function fixture() {
  const home = tempDir("pi-tickstart-");
  const root = path.join(home, "automations");
  const dir = path.join(root, "due-one");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    '---\nname: due-one\ndescription: A test automation.\non:\n  schedule:\n    cron: "*/5 * * * *"\n    timezone: UTC\n---\n\nDo the thing.\n',
  );
  const stateDir = tempDir("pi-tickstart-state-");
  armUserRoot(root, stateDir);
  return {
    root,
    stateDir,
    roots: [{ path: root, scope: "user" as const, kind: "agents" as const }],
  };
}

function claimOf(stateDir: string, key: string): string | undefined {
  const file = path.join(stateDir, "state.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as { claimed?: Record<string, string> }).claimed?.[key];
}

/** Run one tick with a transport that answers exactly `answer`. */
async function tickWith(answer: unknown) {
  const f = fixture();
  const calls: string[][] = [];
  const summary = await runTick({
    stateDir: f.stateDir,
    roots: f.roots,
    spawnFire: (async (args) => {
      calls.push([...args]);
      return answer;
    }) as unknown as StartRun,
  });
  return { f, calls, summary };
}

describe("an acknowledgment that does not actually acknowledge", () => {
  it("is uncertain when the transport answers with neither ok:true nor ok:false", async () => {
    const { summary, calls } = await tickWith({ started: true });

    expect(calls.length).toBeGreaterThan(0);
    expect(summary?.fired ?? []).toEqual([]);
    expect((summary?.uncertain ?? []).length).toBeGreaterThan(0);
    expect(summary?.failed ?? []).toEqual([]);
  });

  it("is uncertain when ok:true arrives with no usable pid", async () => {
    // `ok: true` on its own is an assertion with nothing behind it. A confirmed start has to
    // identify the process it is confirming, or `fired` means only "we called something".
    for (const bad of [{ ok: true }, { ok: true, pid: 0 }, { ok: true, pid: -1 }, { ok: true, pid: "123" }, { ok: true, pid: 1.5 }]) {
      const { summary } = await tickWith(bad);
      expect(summary?.fired ?? []).toEqual([]);
      expect((summary?.uncertain ?? []).length).toBeGreaterThan(0);
    }
  });

  it("is uncertain when ok:false arrives with no reason", async () => {
    // A failure with no reason cannot produce a useful record, and guessing one would put words in
    // the transport's mouth.
    const { summary } = await tickWith({ ok: false });
    expect(summary?.failed ?? []).toEqual([]);
    expect((summary?.uncertain ?? []).length).toBeGreaterThan(0);
  });

  it("is uncertain when the transport answers with a primitive", async () => {
    for (const bad of [true, 0, "ok", null, undefined]) {
      const { summary } = await tickWith(bad);
      expect(summary?.fired ?? []).toEqual([]);
      expect((summary?.uncertain ?? []).length).toBeGreaterThan(0);
    }
  });

  it("is uncertain when the transport THROWS, because it may have spawned first", async () => {
    // Callable, so the preflight passes and the tick genuinely tries.
    const f = fixture();
    const summary = await runTick({
      stateDir: f.stateDir,
      roots: [{ path: f.root, scope: "user" as const, kind: "agents" as const }],
      spawnFire: (async () => {
        throw new Error("the transport exploded on the way out");
      }) as unknown as StartRun,
    });

    expect(summary?.failed ?? []).toEqual([]);
    const uncertain = summary?.uncertain ?? [];
    expect(uncertain.length).toBeGreaterThan(0);

    // No terminal record for the instant just claimed: a worker may be running, and saying it
    // failed would invite someone to start a second one.
    const key = (uncertain[0] as { key: string }).key;
    const claimed = claimOf(f.stateDir, key);
    expect(claimed).toBeTruthy();
    expect(readRecords(f.stateDir, key, 50).filter((r) => r.scheduledFor === claimed)).toHaveLength(0);
  });

  it("writes NO terminal record for any of them, and keeps the claim", async () => {
    const { f, summary } = await tickWith({ ok: true });
    const key = ((summary?.uncertain ?? [])[0] as { key: string }).key;
    const claimed = claimOf(f.stateDir, key);

    expect(claimed).toBeTruthy();
    // Scoped to the instant just claimed: an older `missed` catch-up record can legitimately exist,
    // and asserting "no records at all" would assert something that was never true.
    expect(readRecords(f.stateDir, key, 50).filter((r) => r.scheduledFor === claimed)).toHaveLength(0);
  });
});

describe("a CONFIRMED startup failure", () => {
  it("is counted as failed, not fired and not uncertain", async () => {
    const { summary } = await tickWith({ ok: false, reason: "the entrypoint is missing" });

    expect(summary?.fired ?? []).toEqual([]);
    expect(summary?.uncertain ?? []).toEqual([]);
    expect((summary?.failed ?? []).length).toBeGreaterThan(0);
  });

  it("writes exactly ONE terminal record, naming the EXACT instant just claimed", async () => {
    const { f, summary } = await tickWith({ ok: false, reason: "the entrypoint is missing" });
    const key = (summary?.failed ?? [])[0] as string;
    const claimed = claimOf(f.stateDir, key);
    expect(claimed).toBeTruthy();

    const all = readRecords(f.stateDir, key, 50);
    const mine = all.filter((r) => r.outcome === "failed");

    expect(mine).toHaveLength(1);
    // The instant is what distinguishes this record from the older `missed` catch-up record that
    // every p6 probe — including the control — also carried. Without it the two are the same row.
    expect(mine[0]?.scheduledFor).toBe(claimed);
    expect(mine[0]?.error?.kind).toBe("host");
    expect(mine[0]?.error?.message).toContain("the entrypoint is missing");
  });

  it("keeps the claim, because the instant was attempted and refused", async () => {
    const { f, summary } = await tickWith({ ok: false, reason: "nope" });
    const key = (summary?.failed ?? [])[0] as string;
    // Re-firing it on the next tick would be a duplicate attempt, not a recovery.
    expect(claimOf(f.stateDir, key)).toBeTruthy();
  });
});

describe("a CONFIRMED start", () => {
  it("is counted as fired, with no record — the run writes its own", async () => {
    const { f, summary } = await tickWith({ ok: true, pid: 4242 });
    const key = (summary?.fired ?? [])[0] as string;
    expect(key).toBeTruthy();

    const claimed = claimOf(f.stateDir, key);
    expect(readRecords(f.stateDir, key, 50).filter((r) => r.scheduledFor === claimed)).toHaveLength(0);
  });
});

describe("the real transport, launching for real", () => {
  /** A file that exists — so preflight passes — but that the OS cannot execute. */
  function unexecutable(dir: string): string {
    const p = path.join(dir, "not-runnable.md");
    writeFileSync(p, "# not a program\n");
    return p;
  }

  it("reports ok:false when the launch itself fails, rather than acknowledging a start", async () => {
    const stateDir = tempDir("pi-reallaunch-");
    const spawnFire = defaultSpawnFire(stateDir, launchLocalWorker, {
      file: unexecutable(stateDir),
      args: [],
    });

    // Past the preflight — the entry is really there — and into the actual spawn, which fails. This
    // is the acknowledgment doing its job, not the file check doing it for free.
    const ack = await spawnFire(["user:probe:unrunnable"]);
    expect(ack.ok).toBe(false);
  });

  it("leaves no unhandled rejection when the caller awaits started only", async () => {
    const stateDir = tempDir("pi-norejection-");
    const spawnFire = defaultSpawnFire(stateDir, launchLocalWorker, {
      file: unexecutable(stateDir),
      args: [],
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    try {
      const ack = await spawnFire(["user:probe:norejection"]);
      expect(ack.ok).toBe(false);

      // A failed launch REJECTS `completion`, and nothing here ever awaits it. Unattached, that is
      // an unhandled rejection that takes the ticker down moments after a tick it already survived
      // — the worst shape of failure, because it is remote from its cause.
      await new Promise((r) => setTimeout(r, 200));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("attaches to a FOREIGN transport's completion too, not just the local one", async () => {
    const stateDir = tempDir("pi-foreign-");
    const entry = path.join(stateDir, "worker.js");
    writeFileSync(entry, "process.exit(0);\n");

    const foreign: LaunchWorker = () => ({
      started: Promise.resolve({ ok: true as const, pid: 4242 }),
      // Rejected, with NOTHING attached here. If the caller does not attach, node reports it.
      completion: Promise.reject(new Error("the foreign transport lost its worker")),
      release: () => {},
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    try {
      const ack = await defaultSpawnFire(stateDir, foreign, { file: entry, args: [] })([
        "user:probe:foreign",
      ]);
      expect(ack.ok).toBe(true);

      await new Promise((r) => setTimeout(r, 200));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("acknowledges a real start with a real pid", async () => {
    const stateDir = tempDir("pi-realstart-");
    const entry = path.join(stateDir, "worker.js");
    writeFileSync(entry, "setTimeout(() => process.exit(0), 100);\n");

    // The real transport, a real child, and the entry is node itself so the script genuinely runs.
    const spawnFire = defaultSpawnFire(stateDir, launchLocalWorker, {
      file: process.execPath,
      args: [entry],
    });

    const ack = await spawnFire(["user:probe:realstart"]);
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.pid).toBeGreaterThan(0);
  });
});
