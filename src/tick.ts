// The tick: run every minute by the OS job, `pa serve` or `pa tick`. `decideTick` is pure.

import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";

import { ms } from "./config.js";
import { nextTick, ticksBetween } from "./cron.js";
import { discover, located as locatedOnly } from "./discover.js";
import { oneLine } from "./errors.js";
import { runWatchScript } from "./hooks.js";
import { readRunLock, sweepStaleRunLocks, acquireTickLock } from "./locks.js";
import { ensureDir, fireLogPath, statePaths, type HostRoots } from "./paths.js";
import { foldAbandoned } from "./progress.js";
import { appendRecord, newRunId } from "./records.js";
import { decideWatch, watchDue } from "./watch.js";
import type {
  LaunchWorker,
  ModelResolver,
  RunScript,
  StartRun,
  WorkerEntry,
  WorkerStartup,
} from "./core/contracts.js";
import type { State } from "./state.js";
import type { Trust } from "./trust.js";
import type { Automation, Config, Located, Root, RunRecord, Schedule, Status, TickSource } from "./types.js";

export interface TickDecision {
  // Due but still within its stagger offset; `lastTickAt` must not advance past it.
  action: "none" | "wait" | "fire" | "missed";
  scheduledFor?: Date;
  late: boolean;
  /** How many due instants will never run. For `missed` this includes `scheduledFor` itself. */
  missedCount: number;
  missedUntil?: Date;
  // The earliest instant still holding for its stagger, on any decision.
  waitingFrom?: Date;
}

export interface DecideTickArgs {
  schedule: Schedule;
  claimedIso?: string;
  lastTickAt?: Date;
  now: Date;
  staggerSec: number;
  graceMs: number;
  catchUpWindowMs: number;
}

/** What should happen to one automation now. The window starts after the last tick and claim. */
export function decideTick(a: DecideTickArgs): TickDecision {
  const none: TickDecision = { action: "none", late: false, missedCount: 0 };

  const claimedMs = a.claimedIso ? Date.parse(a.claimedIso) : Number.NaN;
  const horizon = a.now.getTime() - a.catchUpWindowMs;

  const fromMs = Math.max(
    a.lastTickAt ? a.lastTickAt.getTime() : Number.NEGATIVE_INFINITY,
    Number.isNaN(claimedMs) ? Number.NEGATIVE_INFINITY : claimedMs,
    horizon,
  );
  if (!Number.isFinite(fromMs)) return none;

  const dues = ticksBetween(a.schedule, new Date(fromMs), a.now).filter((d) =>
    Number.isNaN(claimedMs) ? true : d.getTime() > claimedMs,
  );
  if (dues.length === 0) return none;

  // Fire the newest instant whose stagger has elapsed, not the newest due one.
  const readyCutoff = a.now.getTime() - a.staggerSec * 1000;
  const ready = dues.filter((d) => d.getTime() <= readyCutoff);
  const pending = dues.filter((d) => d.getTime() > readyCutoff);
  const waitingFrom = pending[0];

  if (ready.length === 0) {
    return {
      action: "wait",
      late: false,
      missedCount: 0,
      ...(waitingFrom ? { scheduledFor: waitingFrom, waitingFrom } : {}),
    };
  }

  const last = ready[ready.length - 1] as Date;
  const older = ready.length - 1;
  const previous = older > 0 ? (ready[ready.length - 2] as Date) : undefined;

  // Lateness is measured from the cron instant plus the stagger offset.
  const lateMs = a.now.getTime() - last.getTime() - a.staggerSec * 1000;

  const fire = (late: boolean): TickDecision => ({
    action: "fire",
    scheduledFor: last,
    late,
    missedCount: older,
    ...(previous ? { missedUntil: previous } : {}),
    ...(waitingFrom ? { waitingFrom } : {}),
  });

  const missed = (): TickDecision => ({
    action: "missed",
    scheduledFor: last,
    late: false,
    missedCount: older + 1,
    missedUntil: last,
    ...(waitingFrom ? { waitingFrom } : {}),
  });

  if (lateMs <= a.graceMs) return fire(false);

  // Past the grace period: a missed run.
  if (a.schedule.catchUp === "skip") return missed();

  // catch-up: once, unless the next regular tick is about to fire anyway.
  const upcoming = nextTick(a.schedule, a.now);
  const crowded = upcoming !== undefined && upcoming.getTime() - a.now.getTime() < a.graceMs;
  if (crowded) return missed();

  return fire(true);
}

export interface TickDeps {
  config: Config;
  stateDir: string;
  trust: Trust;
  state: State;
  now: Date;
  spawnFire: StartRun;
  statuses: Status[];
  /** How an `on.watch` script runs. Without one, a due watch is recorded as unable to run. */
  runScript?: RunScript;
  located?: ReadonlyMap<string, Located>;
  tickedBy?: TickSource;
}

export interface TickSummary {
  fired: string[];
  /** Due, claimed, and confirmed not to have started. One terminal record each. */
  failed: string[];
  // Attempted, but not known to have started: no record, so the reason is kept here.
  uncertain: Array<{ key: string; reason: string }>;
  missed: string[];
  skipped: string[];
  swept: string[];
  waiting: string[];
  checked: string[];
  considered: number;
}

// Refuse a due automation that cannot be started, before claiming its instant.
function refuseWithoutTransport(spawnFire: unknown): void {
  if (typeof spawnFire === "function") return;
  throw new Error(
    "cannot run a tick — this host composed no worker transport " +
      `(spawnFire is ${spawnFire === undefined ? "missing" : typeof spawnFire}). ` +
      "No instant was claimed, so nothing has been consumed and the next properly composed tick " +
      "will still run it.",
  );
}

export async function tick(deps: TickDeps): Promise<TickSummary> {
  const summary: TickSummary = {
    fired: [],
    failed: [],
    uncertain: [],
    missed: [],
    skipped: [],
    swept: [],
    waiting: [],
    checked: [],
    considered: 0,
  };

  const graceMs = ms(deps.config, "grace");
  const catchUpWindowMs = ms(deps.config, "catchUpWindow");

  // A run whose host died mid-flight left no record; write one now.
  const swept = sweepStaleRunLocks(deps.stateDir, deps.config, deps.now, (rec) =>
    // What the abandoned run had reported is folded onto its record, and its progress closed.
    appendRecord(deps.stateDir, foldAbandoned(deps.stateDir, rec, deps.now), deps.config.retention),
  );
  summary.swept = swept.map((r) => r.key);

  const armed = deps.statuses.filter((s) => s.state === "armed" && s.automation?.on.schedule);
  summary.considered = armed.length;

  let earliestWait: number | undefined;

  for (const s of armed) {
    const schedule = s.automation?.on.schedule;
    if (!schedule) continue;
    const claimedIso = deps.state.claimOf(s.key);

    const decision = decideTick({
      schedule,
      ...(claimedIso ? { claimedIso } : {}),
      ...(deps.state.lastTickAt ? { lastTickAt: new Date(deps.state.lastTickAt) } : {}),
      now: deps.now,
      staggerSec: s.staggerSec,
      graceMs,
      catchUpWindowMs,
    });

    if (decision.action === "none") continue;

    // Rewind lastTickAt so a stagger-held instant stays in the next window.
    if (decision.waitingFrom) {
      const t = decision.waitingFrom.getTime();
      if (earliestWait === undefined || t < earliestWait) earliestWait = t;
    }

    if (decision.action === "wait") {
      summary.waiting.push(s.key);
      continue;
    }

    // One record per tick per automation, carrying the count — never one line per missed instant.
    if (decision.missedCount > 0) {
      appendRecord(
        deps.stateDir,
        missedRecord(s, decision.missedCount, decision.missedUntil, deps.now),
        deps.config.retention,
      );
    }

    if (decision.action === "missed") {
      if (decision.scheduledFor) {
        deps.state.claim(s.key, decision.scheduledFor.toISOString());
      }
      summary.missed.push(s.key);
      continue;
    }

    const iso = (decision.scheduledFor as Date).toISOString();

    // Before the claim, so a launch-time throw never consumes the instant.
    refuseWithoutTransport(deps.spawnFire);

    // The claim is the mutual exclusion between ticks. Losing it means another got there first.
    if (!deps.state.claim(s.key, iso)) continue;

    const held = readRunLock(deps.stateDir, s.key);
    if (held) {
      appendRecord(
        deps.stateDir,
        {
          id: newRunId(deps.now),
          key: s.key,
          name: s.name,
          scope: s.scope,
          root: s.root.path,
          trigger: "schedule",
          scheduledFor: iso,
          late: decision.late,
          recordedAt: deps.now.toISOString(),
          outcome: "skipped",
          reason: `still running since ${held.startedAt}`,
        },
        deps.config.retention,
      );
      summary.skipped.push(s.key);
      continue;
    }

    // Persist the claim before spawning: never a duplicate run.
    deps.state.save();

    const outcome = await startRun(deps, [
      s.key,
      "--scheduled-for",
      iso,
      ...(decision.late ? ["--late"] : []),
    ]);

    if (outcome.kind === "started") {
      summary.fired.push(s.key);
      continue;
    }

    if (outcome.kind === "failed") {
      // Confirmed not started: one terminal record for the claimed instant, and the claim stays.
      appendRecord(
        deps.stateDir,
        {
          id: newRunId(deps.now),
          key: s.key,
          name: s.name,
          scope: s.scope,
          root: s.root.path,
          trigger: "schedule",
          scheduledFor: iso,
          late: decision.late,
          recordedAt: deps.now.toISOString(),
          startedAt: deps.now.toISOString(),
          endedAt: deps.now.toISOString(),
          outcome: "failed",
          error: { kind: "host", message: `the run could not be started: ${outcome.reason}` },
        },
        deps.config.retention,
      );
      summary.failed.push(s.key);
      continue;
    }

    // Uncertain: no record, no replacement; the claim stays.
    summary.uncertain.push({ key: s.key, reason: outcome.reason });
  }

  await checkWatches(deps, summary);

  deps.state.lastTickAt = new Date(
    earliestWait === undefined ? deps.now.getTime() : Math.min(deps.now.getTime(), earliestWait - 1),
  ).toISOString();
  if (deps.tickedBy) deps.state.lastTickBy = deps.tickedBy;
  deps.state.save();

  return summary;
}

// Run due watch scripts after the schedules, then start a run for each new finding.
async function checkWatches(deps: TickDeps, summary: TickSummary): Promise<void> {
  const startedHere = new Set(summary.fired);
  const due = deps.statuses.filter((s) => {
    const watch = s.state === "armed" ? s.automation?.on.watch : undefined;
    if (!watch) return false;
    if (deps.state.watchPausedAt(s.key)) return false;
    if (startedHere.has(s.key)) return false;
    if (readRunLock(deps.stateDir, s.key)) return false;
    return watchDue(deps.state.watchOf(s.key), watch, deps.now);
  });
  if (due.length === 0) return;

  // Watch scripts can be slow: save now and re-read afterwards.
  deps.state.save();
  const checks = await Promise.all(
    due.map(async (s) => {
      const prev = deps.state.watchOf(s.key);
      const check = await runWatchScript(deps.located?.get(s.key) ?? locatedFrom(s), {
        config: deps.config,
        ...(deps.runScript ? { runScript: deps.runScript } : {}),
        ...(prev?.answeredAt ? { lastChecked: prev.answeredAt } : {}),
      });
      return { s, prev, check };
    }),
  );
  deps.state.load();

  for (const { s, prev, check } of checks) {
    summary.checked.push(s.key);
    const decision = decideWatch(prev, check, deps.now);

    // Paused while its script ran: start and claim nothing, so the finding is still new on resume.
    if (deps.state.watchPausedAt(s.key)) {
      const { firedAt: _at, firedFor: _for, ...seen } = decision.next;
      deps.state.recordWatch(s.key, {
        ...seen,
        ...(prev?.firedAt ? { firedAt: prev.firedAt } : {}),
        ...(prev?.firedFor ? { firedFor: prev.firedFor } : {}),
      });
      continue;
    }

    if (!decision.fire) {
      deps.state.recordWatch(s.key, decision.next);
      continue;
    }

    // Refused before recording, so the finding stays new.
    refuseWithoutTransport(deps.spawnFire);

    deps.state.recordWatch(s.key, decision.next);
    deps.state.save();

    const outcome = await startRun(deps, [s.key, "--watch"]);
    if (outcome.kind === "started") {
      summary.fired.push(s.key);
      continue;
    }
    if (outcome.kind === "failed") {
      // Confirmed not started: one record; the finding stays recorded.
      appendRecord(
        deps.stateDir,
        {
          id: newRunId(deps.now),
          key: s.key,
          name: s.name,
          scope: s.scope,
          root: s.root.path,
          trigger: "watch",
          late: false,
          recordedAt: deps.now.toISOString(),
          startedAt: deps.now.toISOString(),
          endedAt: deps.now.toISOString(),
          outcome: "failed",
          error: { kind: "host", message: `the run could not be started: ${outcome.reason}` },
        },
        deps.config.retention,
      );
      summary.failed.push(s.key);
      continue;
    }
    summary.uncertain.push({ key: s.key, reason: outcome.reason });
  }
}

function locatedFrom(s: Status): Located {
  return {
    automation: s.automation as Automation,
    dir: s.dir,
    file: path.join(s.dir, "AUTOMATION.md"),
    root: s.root,
    key: s.key,
  };
}

function missedRecord(
  s: Status,
  count: number,
  scheduledFor: Date | undefined,
  now: Date,
): RunRecord {
  const rec: RunRecord = {
    id: newRunId(now),
    key: s.key,
    name: s.name,
    scope: s.scope,
    root: s.root.path,
    trigger: "schedule",
    late: false,
    recordedAt: now.toISOString(),
    outcome: "missed",
    reason: "host unavailable",
    count,
  };
  if (scheduledFor) rec.scheduledFor = scheduledFor.toISOString();
  return rec;
}

export async function runTick(options: {
  stateDir: string;
  now?: Date;
  spawnFire: StartRun;
  // Restrict discovery. Tests must set it, or they discover the real `~/.agents/automations`.
  roots?: Root[];
  // A factory called once per tick, so a long-lived `serve` sees credentials added while it runs.
  modelResolver?: () => Promise<ModelResolver | undefined>;
  /** The user directories to discover from. Composes with registered repository roots. */
  host?: HostRoots;
  // How this host runs an `on.watch` script. Omitted, a due watch records that it could not run.
  runScript?: RunScript;
  tickedBy?: TickSource;
}): Promise<TickSummary | undefined> {
  const { loadConfig } = await import("./config.js");
  const { State } = await import("./state.js");
  const { Trust } = await import("./trust.js");
  const { computeStatuses } = await import("./status.js");

  const dir = options.stateDir;
  const now = options.now ?? new Date();
  const { config } = loadConfig(dir);

  // Long enough for slow discovery, short enough that a reboot does not block for an hour.
  const release = acquireTickLock(dir, 300_000, now);
  if (!release) return undefined;

  try {
    const state = new State(dir);
    const trust = new Trust(dir);

    const found = options.roots
      ? discover({ roots: options.roots })
      : discover({
          extraRepoRoots: state.roots,
          ...(options.host ? { host: options.host } : {}),
        });

    // Without a resolver, statuses are computed without model checks; fire() re-checks anyway.
    const resolveModel = options.modelResolver ? await options.modelResolver() : undefined;

    const statuses = await computeStatuses(found, {
      trust,
      config,
      stateDir: dir,
      now,
      ...(resolveModel ? { resolveModel } : {}),
    });
    trust.save();

    const summary = await tick({
      config,
      stateDir: dir,
      trust,
      state,
      now,
      spawnFire: options.spawnFire,
      statuses,
      located: new Map(locatedOnly(found).map((l) => [l.key, l])),
      ...(options.runScript ? { runScript: options.runScript } : {}),
      ...(options.tickedBy ? { tickedBy: options.tickedBy } : {}),
    });

    state.pruneClaims(statuses.map((s) => s.key));
    state.save();

    return summary;
  } finally {
    release();
  }
}

/** Three outcomes: "did not start" gets a terminal record, "unknown" must never get one. */
type StartOutcome =
  | { kind: "started" }
  | { kind: "failed"; reason: string }
  | { kind: "uncertain"; reason: string };

// Validate the acknowledgment: anything unreadable is `uncertain`, never `failed`.
async function startRun(deps: TickDeps, args: string[]): Promise<StartOutcome> {
  let ack: unknown;
  try {
    ack = await deps.spawnFire(args);
  } catch (e) {
    return { kind: "uncertain", reason: `the transport failed: ${oneLine(e).slice(0, 200)}` };
  }

  if (typeof ack !== "object" || ack === null) {
    return { kind: "uncertain", reason: `the transport returned ${typeof ack}` };
  }

  const a = ack as { ok?: unknown; pid?: unknown; reason?: unknown };

  if (a.ok === true) {
    // `ok: true` must identify the process it confirms.
    return typeof a.pid === "number" && Number.isInteger(a.pid) && a.pid > 0
      ? { kind: "started" }
      : { kind: "uncertain", reason: "the transport acknowledged a start with no usable pid" };
  }

  if (a.ok === false) {
    return typeof a.reason === "string" && a.reason !== ""
      ? { kind: "failed", reason: a.reason }
      : { kind: "uncertain", reason: "the transport reported a failure with no reason" };
  }

  return { kind: "uncertain", reason: "the transport returned no usable acknowledgment" };
}

/**
 * Spawn a detached worker logging to its fire log; resolves on startup. `workerEnv` comes from the
 * host.
 */
export function defaultSpawnFire(
  stateDirPath: string,
  launch: LaunchWorker,
  worker: WorkerEntry,
  workerEnv?: () => Record<string, string> | undefined,
): StartRun {
  let extra: Record<string, string> | undefined | null = null;

  return async (args: readonly string[]): Promise<WorkerStartup> => {
    const logsDir = statePaths(stateDirPath).logs;
    ensureDir(logsDir);

    const key = args[0] ?? "unknown";
    const logFile = fireLogPath(stateDirPath, key);

    // Node's `spawn` event does not prove the entry loaded; the host checks what its entry needs.
    if (!existsSync(worker.file)) {
      return { ok: false, reason: `the worker executable does not exist: ${worker.file}` };
    }

    if (extra === null) extra = workerEnv?.() ?? undefined;

    let fd: number;
    try {
      fd = openSync(logFile, "a");
    } catch (e) {
      // Not swallowed: skipping the launch would count a run that never existed as fired.
      return { ok: false, reason: `cannot open the run log for ${key}: ${(e as Error).message}` };
    }

    try {
      const started = launch({
        entry: worker.file,
        args: [...worker.args, ...args],
        detached: true,
        output: { kind: "file", fd },
        ...(extra ? { env: { ...process.env, ...extra } as Record<string, string> } : {}),
      });

      // Completion can reject for a detached worker; handle it so it is never unhandled.
      started.completion.catch(() => {});

      const ack = await started.started;
      started.release();
      return ack;
    } finally {
      // The child holds its own descriptor, so close ours to avoid leaking one per fire.
      try {
        closeSync(fd);
      } catch {
      }
    }
  };
}
