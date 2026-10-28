// The state decision: invalid → disabled → off → armed. Resolution runs only for would-be armed.

import { existsSync } from "node:fs";
import path from "node:path";

import { ms } from "./config.js";
import { isoWithOffset, nextTick, staggerCapFor } from "./cron.js";
import { scriptFiles } from "./digest.js";
import { formatDuration, parseDuration } from "./duration.js";
import { oneLine } from "./errors.js";
import { resolveInterpreter, type WhichFn } from "./interpreters.js";
import { isRunLockStale, readRunLock } from "./locks.js";
import { lastRecord } from "./records.js";
import { readFlowPlan } from "./flow-plan.js";
import { staggerSeconds } from "./stagger.js";
import { readPausedWatches, readWatchStates } from "./state.js";
import { nextCheckAt } from "./watch.js";
import type { ModelResolver } from "./core/contracts.js";
import type { Trust } from "./trust.js";
import type {
  AutomationState,
  Config,
  Discovered,
  Located,
  Status,
  WatchState,
} from "./types.js";

export interface StatusDeps {
  trust: Trust;
  config: Config;
  stateDir: string;
  now: Date;
  // Re-checks models; omitted for a fast listing.
  resolveModel?: ModelResolver;
  platform?: NodeJS.Platform;
  which?: WhichFn;
  /** Injected for tests. */
  locale?: string;
}

/** The part of the decision that needs only the file and the consent record. Pure. */
export function decideState(
  d: Discovered,
  armedByTrust: boolean,
  offReason?: string,
): { state: AutomationState; reason?: string } {
  if (!d.ok) return { state: "invalid", reason: d.error };
  if (!d.located.automation.enabled) return { state: "disabled" };
  if (!armedByTrust) return { state: "off", reason: offReason ?? "not armed" };
  return { state: "armed" };
}

export async function computeStatuses(found: Discovered[], deps: StatusDeps): Promise<Status[]> {
  const out: Status[] = [];
  // Read once for the whole listing: the tick writes every check to state.json.
  const watches = readWatchStates(deps.stateDir);
  const paused = readPausedWatches(deps.stateDir);
  for (const d of found) {
    out.push(await computeOne(d, deps, watches, paused));
  }
  return out;
}

async function computeOne(
  d: Discovered,
  deps: StatusDeps,
  watches: Record<string, WatchState>,
  paused: Record<string, string>,
): Promise<Status> {
  const { trust, config, now } = deps;

  const base = d.ok
    ? {
        key: d.located.key,
        name: d.located.automation.name,
        scope: d.located.root.scope,
        root: d.located.root,
        dir: d.located.dir,
      }
    : {
        key: d.key,
        // The file could not be parsed, so the directory name is the only name we have.
        name: path.basename(d.dir),
        scope: d.root.scope,
        root: d.root,
        dir: d.dir,
      };

  const staggerSec = staggerSeconds(
    base.key,
    staggerCapFor(d.ok ? d.located.automation.on.schedule : undefined, config.staggerMaxSeconds, now),
  );
  const defaultTimeoutMs = ms(config, "defaultTimeout");

  if (!d.ok) {
    return {
      ...base,
      state: "invalid",
      reason: d.error,
      ...(d.problems ? { problems: d.problems } : {}),
      effectiveTimeoutMs: defaultTimeoutMs,
      staggerSec,
      ...lastOf(deps.stateDir, base.key),
    };
  }

  const l = d.located;
  const a = l.automation;

  // Consent is refreshed on every sighting, so an unplugged drive's consent is not swept at once.
  trust.touch(l, now);

  const armedByTrust = trust.isArmed(l, now);
  const offReason = trust.offReason(l, now);
  const decided = decideState(d, armedByTrust, offReason);

  const lock = readRunLock(deps.stateDir, l.key);
  // A lock is not proof of a live run; a read must not sweep or write records.
  const running = lock && !isRunLockStale(lock, ms(config, "hookTimeout"), now) ? lock : undefined;

  // Tracked: an own chart or `config.flowTracking` (the same rule as `trackerFor`).
  const tracked = readFlowPlan(l.dir) !== undefined || config.flowTracking[l.key] === true;
  const watched = a.on.watch ? watches[l.key] : undefined;
  const pausedAt = a.on.watch ? paused[l.key] : undefined;

  const common = {
    ...base,
    automation: a,
    staggerSec,
    effectiveTimeoutMs: parseDuration(a.timeout ?? "") ?? defaultTimeoutMs,
    ...(running ? { running } : {}),
    ...(tracked ? { flow: true } : {}),
    ...(watched ? { watch: watched } : {}),
    ...(pausedAt ? { watchPausedAt: pausedAt } : {}),
    ...lastOf(deps.stateDir, l.key),
  };

  if (decided.state !== "armed") {
    // No resolution for a disabled or unconsented automation.
    return decided.reason
      ? { ...common, state: decided.state, reason: decided.reason }
      : { ...common, state: decided.state };
  }

  // --- resolution, for automations that would otherwise be armed ---

  const maxTimeoutMs = ms(config, "maxTimeout");
  if (a.timeout) {
    const t = parseDuration(a.timeout);
    if (t !== undefined && t > maxTimeoutMs) {
      return {
        ...common,
        state: "invalid",
        reason: `timeout: ${a.timeout} exceeds this host's maximum of ${config.maxTimeout}`,
      };
    }
  }

  const repoMissing =
    l.root.scope === "repository" && l.repoRoot !== undefined && !existsSync(l.repoRoot);
  if (repoMissing) {
    return { ...common, state: "off", reason: `repository not found: ${l.repoRoot}` };
  }

  const interpreterProblem = checkInterpreters(l, deps);
  if (interpreterProblem) {
    return { ...common, state: "invalid", reason: interpreterProblem };
  }

  let resolvedModel: Status["resolvedModel"];
  if (deps.resolveModel) {
    try {
      resolvedModel = await deps.resolveModel(a.model);
    } catch (e) {
      return { ...common, state: "invalid", reason: oneLine(e) };
    }
  }

  const armed: Status = {
    ...common,
    state: "armed",
    ...(resolvedModel ? { resolvedModel } : {}),
  };

  if (a.on.schedule) {
    const next = nextTick(a.on.schedule, now);
    if (next) {
      armed.nextFire = isoWithOffset(
        new Date(next.getTime() + staggerSec * 1000),
        a.on.schedule.timezone,
      );
    }
  }

  // A paused watch has no next check: nothing will run it until it is resumed.
  if (a.on.watch && !pausedAt) {
    armed.nextCheck = nextCheckAt(watched, a.on.watch, now).toISOString();
  }

  return armed;
}

/** The interpreter for every script, or the first refusal as a one-line error. */
function checkInterpreters(l: Located, deps: StatusDeps): string | undefined {
  for (const s of scriptFiles(l)) {
    const abs = path.resolve(l.dir, s.script);
    const r = deps.which
      ? resolveInterpreter(abs, deps.platform, deps.which, s.script)
      : resolveInterpreter(abs, deps.platform, undefined, s.script);
    // `hooks.pre[0]: x.sh <reason>` — the field without its `.script`, as it has always read.
    if (!r.ok) return `${s.field.replace(/\.script$/, "")}: ${s.script} ${r.reason}`;
  }
  return undefined;
}

/** The interpreter display commands, recorded at arm time. */
export function interpreterMap(
  l: Located,
  platform?: NodeJS.Platform,
  which?: WhichFn,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of scriptFiles(l)) {
    const abs = path.resolve(l.dir, s.script);
    const r = which
      ? resolveInterpreter(abs, platform, which, s.script)
      : resolveInterpreter(abs, platform, undefined, s.script);
    if (r.ok) out[s.script] = r.display;
  }
  return out;
}

function lastOf(stateDir: string, key: string): Pick<Status, "last"> {
  const rec = lastRecord(stateDir, key);
  if (!rec) return {};
  const last: NonNullable<Status["last"]> = {
    outcome: rec.outcome,
    at: rec.endedAt ?? rec.recordedAt,
  };
  if (rec.reason) last.reason = rec.reason;
  if (rec.error) last.reason = last.reason ?? rec.error.kind;
  if (rec.startedAt && rec.endedAt) {
    last.durationMs = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
  }
  return { last };
}

/** `20m` / `10m (host default)` for the consent preview and `check`. */
export function timeoutText(s: Status, config: Config): string {
  if (s.automation?.timeout) return s.automation.timeout;
  return `${formatDuration(ms(config, "defaultTimeout"))} (host default)`;
}
