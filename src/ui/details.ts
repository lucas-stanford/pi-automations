/** Helpers for the automation page and cards: run outcomes, consent words and the watcher state. */

import { summaryLine } from "../summary.js";
import type { Outcome, RunRecord, Status } from "../types.js";
import { GLYPH } from "./glyphs.js";
import { type LineTheme, type UiColor } from "./theme.js";
import { truncateToWidth, visibleWidth } from "./width.js";

export interface DetailsData {
  lastRecord?: RunRecord;
  flowSource?: "automation" | "file" | "config" | "none";
  /** The recent outcomes, oldest first. */
  history?: Outcome[];
  /** Recent records, oldest first, when the caller already read them. */
  records?: RunRecord[];
  /** The failed run a person dismissed with `d`; a newer failure shows again. */
  dismissedRunId?: string;
}

/** The watcher (the OS job): `on`, `stale` (quiet or another install's) or `off`. */
export interface WatcherFacts {
  state: "on" | "stale" | "off";
  /** ISO of the last tick, when there has been one. */
  lastTickAt?: string;
  /** Why it is stale, or where the ticks come from when it is not the OS job. */
  note?: string;
  /** False when the ticks come from something `w` cannot stop, such as `pa serve`. */
  controllable?: boolean;
}

/** A tick comes once a minute; five quiet minutes means nothing is ticking. */
export const WATCHER_QUIET_MS = 5 * 60_000;

/** The watcher state; without the job, recent ticks mean "on" only when `serve` made them. */
export function classifyWatcher(
  job: { installed: boolean; stale: boolean },
  lastTickAt: string | undefined,
  now: Date,
  lastTickBy?: string,
): WatcherFacts {
  const age = lastTickAt ? now.getTime() - Date.parse(lastTickAt) : Number.POSITIVE_INFINITY;
  const ticking = age <= WATCHER_QUIET_MS;
  const tick = lastTickAt ? { lastTickAt } : {};
  if (!job.installed) {
    return ticking && lastTickBy === "serve"
      ? { state: "on", ...tick, note: "pa serve", controllable: false }
      : { state: "off", ...tick };
  }
  if (job.stale) return { state: "stale", ...tick, note: "it was registered for another install of pi-automations" };
  return ticking ? { state: "on", ...tick } : { state: "stale", ...tick };
}

/** On, or registered for another install but still ticking (so nothing is on hold). */
export function watcherTicking(w: WatcherFacts | undefined, now: Date): boolean {
  if (!w) return true;
  if (w.state === "on") return true;
  return w.state === "stale" && w.lastTickAt !== undefined && now.getTime() - Date.parse(w.lastTickAt) <= WATCHER_QUIET_MS;
}

/** An armed automation that starts on its own: a schedule, or a watch that is not paused. */
export function startsOnItsOwn(s: Status): boolean {
  const a = s.automation;
  return s.state === "armed" && Boolean(a && (a.on.schedule || (a.on.watch && !s.watchPausedAt)));
}

/** The reason an automation is off. */
export function offWords(reason: string | undefined): string {
  const r = (reason ?? "not armed").replace(/\s+—\s+\/automations arm \S+$/, "").trim();
  return r === "not armed" ? "not armed yet" : r;
}

/**
 * `waiting for your consent` for an automation nobody has armed; its own reason otherwise.
 */
export function consentWords(reason: string | undefined): string {
  const r = offWords(reason);
  return r === "not armed yet" ? "waiting for your consent" : r;
}

/** `name` on the left and `● armed · user` on the right of one line. */
export function spread(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 2) return truncateToWidth(`${left}  ${right}`, width);
  return `${left}${" ".repeat(gap)}${right}`;
}

const RUN_MARK: Record<Outcome, { glyph: string; word: string; color: UiColor }> = {
  ok: { glyph: GLYPH.ok, word: "ok", color: "success" },
  failed: { glyph: GLYPH.failed, word: "failed", color: "error" },
  skipped: { glyph: GLYPH.late, word: "skipped", color: "muted" },
  missed: { glyph: GLYPH.missed, word: "missed", color: "warning" },
  aborted: { glyph: GLYPH.aborted, word: "aborted", color: "warning" },
};

/** `✓ ok` in its colour. */
export function runMark(outcome: Outcome, t: LineTheme): string {
  const m = RUN_MARK[outcome];
  return t.fg(m.color, `${m.glyph} ${m.word}`);
}

/** What a run said: its error when it failed, its summary otherwise. */
export function runSays(rec: RunRecord): string {
  if (rec.outcome === "failed") return rec.error?.message ?? rec.reason ?? "failed";
  return summaryLine(rec, 400) || rec.reason || "";
}

export function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
    while (visibleWidth(line) > width) {
      const head = truncateToWidth(line, width);
      if (head === "") {
        const first = Array.from(line)[0] ?? "";
        if (first === "") break;
        out.push(first);
        line = line.slice(first.length);
        continue;
      }
      out.push(head);
      line = line.slice(head.length);
    }
  }
  if (line) out.push(line);
  return out;
}
