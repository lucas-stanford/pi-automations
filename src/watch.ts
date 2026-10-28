// `on.watch`: a script decides when to run. Pure decisions.

import { createHash } from "node:crypto";

import { parseDuration } from "./duration.js";
import type { Watch, WatchState } from "./types.js";

/** A check counts as due slightly early, so tick jitter does not add a minute. */
export const WATCH_SLACK_MS = 30_000;

/** The longest `said` line kept in state and shown in a listing. */
export const WATCH_SAID_MAX = 200;

/** The longest a watch script may run: under the tick lock's five-minute staleness. */
export const WATCH_TIMEOUT_MAX_MS = 2 * 60_000;

/** `every` in milliseconds. Parsing already refused anything this cannot read. */
export function everyMs(watch: Watch): number {
  return parseDuration(watch.every) ?? 5 * 60_000;
}

/** Is the watch due a check at `now`? */
export function watchDue(prev: WatchState | undefined, watch: Watch, now: Date): boolean {
  if (!prev) return true;
  const last = Date.parse(prev.checkedAt);
  if (Number.isNaN(last)) return true;
  const elapsed = now.getTime() - last;
  // A clock that moved backwards must not park the watch until it catches up again.
  if (elapsed < 0) return true;
  return elapsed >= everyMs(watch) - WATCH_SLACK_MS;
}

/** When the next check is due; can be in the past (overdue). Never checked means due now. */
export function nextCheckAt(prev: WatchState | undefined, watch: Watch, now: Date): Date {
  if (!prev) return now;
  const last = Date.parse(prev.checkedAt);
  if (Number.isNaN(last) || last > now.getTime()) return now;
  return new Date(last + everyMs(watch));
}

/** What one run of the script came to, from whoever ran it. */
export interface WatchCheck {
  /** The exit code. Absent when the script never exited; then `problem` says why. */
  exit?: number;
  problem?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WatchDecision {
  /** Start a run now. */
  fire: boolean;
  /** Why, in a few words, for a listing and a dry run. */
  because: string;
  /** What to remember about this check. */
  next: WatchState;
}

/** `sha256:<hex>` of what the script printed, ignoring surrounding whitespace. */
export function fingerprint(output: string): string {
  return `sha256:${createHash("sha256").update(output.trim(), "utf8").digest("hex")}`;
}

/**
 * One line of what a check said: stdout's first line when it found something, else stderr's last.
 */
export function saidLine(check: WatchCheck): string | undefined {
  if (check.problem !== undefined) return clip(check.problem);
  const firstOut = lines(check.stdout)[0];
  if (check.exit === 0) return firstOut !== undefined ? clip(firstOut) : undefined;
  const lastErr = lines(check.stderr).pop();
  const said = lastErr ?? firstOut;
  return said !== undefined ? clip(said) : undefined;
}

/**
 * What a finished check means:
 * - exit 0 with output different from the last run's finding: start a run;
 * - exit 0 with the same output: no run;
 * - another exit code: no run, and the last finding is forgotten;
 * - no exit (timeout, signal, start failure): no run, nothing forgotten.
 */
export function decideWatch(
  prev: WatchState | undefined,
  check: WatchCheck,
  now: Date,
): WatchDecision {
  const said = saidLine(check);
  const answered = check.problem === undefined && check.exit !== undefined;
  const base: WatchState = {
    checkedAt: now.toISOString(),
    ...(check.problem !== undefined
      ? { problem: check.problem }
      : check.exit !== undefined
        ? { exit: check.exit }
        : { problem: "the script ended without an exit code" }),
    durationMs: Math.max(0, Math.round(check.durationMs)),
    ...(said !== undefined ? { said } : {}),
    ...(prev?.firedAt ? { firedAt: prev.firedAt } : {}),
    ...(answered ? { answeredAt: now.toISOString() } : prev?.answeredAt ? { answeredAt: prev.answeredAt } : {}),
  };

  if (!answered) {
    return {
      fire: false,
      because: `could not check: ${base.problem}`,
      next: { ...base, ...(prev?.firedFor ? { firedFor: prev.firedFor } : {}) },
    };
  }
  if (check.exit !== 0) {
    return { fire: false, because: `nothing to do (exit ${check.exit})`, next: base };
  }

  const found = fingerprint(check.stdout);
  if (prev?.firedFor === found) {
    return {
      fire: false,
      because: "the same as what started the last run",
      next: { ...base, firedFor: found },
    };
  }
  return {
    fire: true,
    because: "found something new",
    next: { ...base, firedAt: now.toISOString(), firedFor: found },
  };
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= WATCH_SAID_MAX ? one : `${one.slice(0, WATCH_SAID_MAX - 1)}…`;
}
