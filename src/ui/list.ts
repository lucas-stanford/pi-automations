// The `/automations` page: Needs-you and Running-now cards, then a quiet agenda. The
// order only changes on real changes, never on a timer. No pi import.

import type { ListingModel, Row } from "../listing.js";
import type { Config, RunRecord, Status } from "../types.js";
import { consentWords, runSays, startsOnItsOwn, watcherTicking, wrapWords, type DetailsData, type WatcherFacts } from "./details.js";
import { GLYPH } from "./glyphs.js";
import { linkLine, noteRows } from "./graph.js";
import { messageAreaLines, messageText, shownMessage } from "./message.js";
import { bodyRows, pageRows, renderPage, titleLine, windowBlock } from "./page.js";
import { isRunning, type RunView } from "./run-view.js";
import { stepWords } from "./running.js";
import { type LineTheme, PLAIN_THEME, sectionHeading, strong, type UiColor } from "./theme.js";
import type { RenderHost, WindowComponent } from "./window.js";
import { ellipsize, padTo, truncateToWidth, visibleWidth, wrapHanging } from "./width.js";
import {
  agoLong,
  agoWords,
  armWords,
  errorHint,
  momentWords,
  nominalFire,
  runningWords,
  scheduleWords,
  sinceWords,
  spanWords,
  timeWords,
  tookMs,
  triggerWord,
  usualMs,
  whenLong,
  whenWords,
} from "./words.js";

export type ListAction =
  | "run"
  | "run-flow"
  | "stop"
  | "arm"
  | "arm-and-run"
  | "disarm"
  | "enable"
  | "disable"
  | "toggle"
  | "edit"
  | "log"
  | "check"
  | "window"
  | "pause-watch"
  | "resume-watch"
  | "dismiss-run"
  | `plugin:${string}`;

export type GlobalAction = "watcher-start" | "watcher-stop";

export interface ListAffordance {
  action: ListAction;
  label: string;
  /** The key that does the same from the list, shown beside it on the automation's page. */
  key?: string;
  why?: string;
}

/** What a person may do to this automation right now, derived from its state. */
export function actionsFor(status: Status): ListAffordance[] {
  const w = status.automation?.on.watch;
  const watch: ListAffordance[] = w
    ? [
        status.watchPausedAt
          ? {
              action: "resume-watch",
              key: "p",
              label: "resume its watch",
              why: `Resume the watch: check ${w.script} again every ${w.every}, from the next tick.`,
            }
          : {
              action: "pause-watch",
              key: "p",
              label: "pause its watch",
              why: `Pause the watch: stop checking ${w.script} until you resume it; you can still run it yourself.`,
            },
      ]
    : [];
  const log: ListAffordance = { action: "log", key: "l", label: "its last runs", why: "Show its last runs, newest first, with what each one published." };
  const check: ListAffordance = {
    action: "check",
    key: "c",
    label: "check: every technical detail",
    why: "Check it: its schedule, its last check, its setup and its files, and any error in its file.",
  };
  if (status.running) {
    return [
      { action: "window", key: "s", label: "show its run", why: "Open its run: its steps, its notes, and how long it usually takes." },
      // Only a run that is actually going can be stopped, so this appears here and nowhere else.
      { action: "stop", key: "x", label: "stop its run", why: "Stop this run now; its post hooks still run, and it is recorded as aborted." },
      ...watch,
      log,
      check,
    ];
  }
  switch (status.state) {
    case "armed": {
      const failed = status.last?.outcome === "failed";
      return [
        { action: "run", key: "r", label: failed ? "run it again now" : "run now", why: "Run it now; the page stays open and shows it running." },
        // Only for an automation that has a chart.
        ...(status.flow
          ? [{ action: "run-flow" as const, key: "f", label: "run and follow its flowchart", why: "Run it now and follow each step on its flowchart." }]
          : []),
        ...(failed ? [{ action: "dismiss-run" as const, key: "d", label: "dismiss: I've seen it", why: "Dismiss this failed run, so it stops asking until a newer run ends." }] : []),
        ...watch,
        log,
        check,
        status.scope === "repository"
          ? { action: "disarm", key: "space", label: "disarm it", why: "Disarm it: nothing starts it until you arm it again." }
          : { action: "disable", key: "space", label: "disable it", why: "Disable it: nothing starts it, not even r, until you enable it." },
      ];
    }
    case "off":
      return [
        { action: "arm", key: "a", label: "arm it, after a preview", why: "Show exactly what it runs on this machine, then ask before arming it." },
        { action: "arm-and-run", label: "arm it and run it once", why: "Arm it after the same preview, then run it once." },
        ...watch,
        check,
      ];
    case "disabled":
      return [
        { action: "enable", key: "space", label: "enable it", why: "Enable it: its schedule and its watch start again, and r runs it." },
        ...watch,
        check,
      ];
    case "invalid":
      return [check];
  }
}

export interface ListExtras {
  edit: { label: string; why: string };
  actions: { id: string; label: string; key?: string; why?: string }[];
}

const DEFAULT_EXTRAS: ListExtras = {
  edit: { label: "Edit AUTOMATION.md", why: "Open its AUTOMATION.md in your editor." },
  actions: [],
};

/** `edit it` for the built-in editor; a plugin's own words, in the page's lower case, otherwise. */
function editWords(label: string): string {
  if (label === DEFAULT_EXTRAS.edit.label) return "edit it";
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** The automation page's actions: its own, with edit before check and plugins after it. */
export function menuFor(status: Status, extras: ListExtras = DEFAULT_EXTRAS): ListAffordance[] {
  const own = actionsFor(status);
  const edit: ListAffordance = { action: "edit", key: "e", label: editWords(extras.edit.label), why: extras.edit.why };
  const plugins: ListAffordance[] = extras.actions.map((a) => ({
    action: `plugin:${a.id}` as const,
    ...(a.key && !RESERVED_KEYS.has(a.key) ? { key: a.key } : {}),
    label: a.label,
    ...(a.why ? { why: a.why } : {}),
  }));
  const at = own.findIndex((a) => a.action === "check");
  return [...own.slice(0, at), edit, own[at] as ListAffordance, ...plugins, ...own.slice(at + 1)];
}

export interface ListHeaderFacts {
  counts: { armed: number; off: number; disabled: number; invalid: number };
  running: number;
  watcher?: WatcherFacts;
}

/** The pseudo-key of the watcher's card. Never a real automation key, which always has a scope. */
export const WATCHER_KEY = "watcher";

export type SectionId = "needs" | "running" | "coming" | "watching" | "off";

export const SECTION_TITLE: Record<SectionId, string> = {
  needs: "Needs you",
  running: "Running now",
  coming: "Coming up",
  watching: "Watching",
  off: "Off and disabled",
};
const SECTION_ORDER: SectionId[] = ["needs", "running", "coming", "watching", "off"];
const CARD_SECTIONS: ReadonlySet<SectionId> = new Set(["needs", "running"]);

export type EntryKind =
  | "watcher"
  | "invalid"
  | "failed"
  | "watch"
  | "consent"
  | "running"
  /** Coming up: on its schedule, held by the watcher, or by hand only. */
  | "coming"
  | "hold"
  | "manual"
  /** Watching: a watch with no schedule, checking, paused, or held by the watcher. */
  | "watched"
  | "paused"
  /** Off and disabled: disabled, or an automation nobody has armed yet. */
  | "off"
  | "not-armed";

export interface InboxEntry {
  key: string;
  status?: Status;
  section: SectionId;
  kind: EntryKind;
  name: string;
}

export interface Triage {
  sections: { id: SectionId; title: string; items: InboxEntry[] }[];
  needs: number;
  running: number;
  paused: number;
  /** Armed automations that only run on their own while the watcher is on. */
  dependents: Status[];
}

export interface Cell {
  text: string;
  color?: UiColor;
}

type RecordsData = DetailsData & { records?: RunRecord[]; dismissedRunId?: string };

function recordsOf(d: RecordsData | undefined): RunRecord[] {
  return d?.records ?? (d?.lastRecord ? [d.lastRecord] : []);
}

function isDismissed(d: RecordsData | undefined): boolean {
  const last = d?.lastRecord ?? d?.records?.at(-1);
  return Boolean(d?.dismissedRunId && last && last.id === d.dismissedRunId);
}

/** The order inside a section: compared item by item, so it never depends on the clock's tick. */
type Rank = (string | number)[];

function compareRank(x: Rank, y: Rank): number {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const a = x[i] ?? "";
    const b = y[i] ?? "";
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }
  return 0;
}

// Coming up by next run; Watching by name (a next check moves every few minutes).
function comingRank(s: Status): Rank {
  const a = s.automation;
  if (a?.on.schedule && s.nextFire) return [0, Date.parse(nominalFire(s.nextFire, s.staggerSec)), s.name];
  if (a?.on.schedule) return [0, Number.MAX_SAFE_INTEGER, s.name];
  if (a?.on.watch) return [1, 0, s.name];
  return [2, 0, s.name];
}

/** A watch with no schedule: it belongs in Watching. With a schedule too, its next run decides. */
function watchOnly(s: Status): boolean {
  return Boolean(s.automation?.on.watch && !s.automation.on.schedule);
}

const NEEDS_RANK: Partial<Record<EntryKind, number>> = { watcher: 0, invalid: 1, failed: 2, watch: 3, consent: 4 };

function classify(s: Status, data: ListData, now: Date, watcher: WatcherFacts | undefined): { entry: InboxEntry; rank: Rank } {
  const a = s.automation;
  const d = data.details?.[s.key];
  const at = (section: SectionId, kind: EntryKind, rank: Rank) => ({ entry: { key: s.key, status: s, section, kind, name: s.name }, rank });
  const needs = (kind: EntryKind) => at("needs", kind, [NEEDS_RANK[kind] ?? 9, s.name]);

  // A running run comes first, even if its file broke mid-run.
  if (s.state === "invalid" && !s.running) return needs("invalid");
  if (s.running) return at("running", "running", [Date.parse(s.running.startedAt), s.name]);
  if (s.state === "armed" && s.last?.outcome === "failed" && !isDismissed(d)) return needs("failed");
  if (s.state === "armed" && a?.on.watch && !s.watchPausedAt && s.watch?.problem) return needs("watch");
  if (s.state === "off") {
    return consentWords(s.reason) === "waiting for your consent" ? at("off", "not-armed", [s.name]) : needs("consent");
  }
  if (s.state === "disabled") return at("off", "off", [s.name]);
  if (watchOnly(s)) {
    if (s.watchPausedAt) return at("watching", "paused", [s.name]);
    if (!watcherTicking(watcher, now)) return at("watching", "hold", [s.name]);
    return at("watching", "watched", [s.name]);
  }
  if (startsOnItsOwn(s) && !watcherTicking(watcher, now)) return at("coming", "hold", comingRank(s));
  if (a?.on.schedule) return at("coming", "coming", comingRank(s));
  return at("coming", "manual", comingRank(s));
}

/** Sort every automation into its section, the watcher first when it needs you. */
export function triage(data: ListData, now: Date, _opts: { canControlWatcher?: boolean } = {}): Triage {
  const statuses = data.model.groups.flatMap((g) => g.rows.map((r) => r.status));
  const watcher = data.facts.watcher;
  const ranked = statuses.map((s) => classify(s, data, now, watcher));
  // In the order Coming up shows them, so the watcher's page reads like the agenda.
  const dependents = statuses.filter(startsOnItsOwn).sort((x, y) => compareRank(comingRank(x), comingRank(y)));
  if (watcher && watcher.state !== "on" && dependents.length > 0) {
    ranked.push({ entry: { key: WATCHER_KEY, section: "needs", kind: "watcher", name: "The watcher" }, rank: [0, ""] });
  }
  const sections = SECTION_ORDER.map((id) => ({
    id,
    title: SECTION_TITLE[id],
    items: ranked
      .filter((r) => r.entry.section === id)
      .sort((x, y) => compareRank(x.rank, y.rank))
      .map((r) => r.entry),
  })).filter((s) => s.items.length > 0);
  const count = (id: SectionId) => sections.find((s) => s.id === id)?.items.length ?? 0;
  return {
    sections,
    needs: count("needs"),
    running: count("running"),
    paused: statuses.filter((s) => s.automation?.on.watch && s.watchPausedAt).length,
    dependents,
  };
}

export interface RunStepNow {
  label: string;
  note?: string;
}

/** A card: what happened, why, the one key, and when it runs again on its own. */
export interface Card {
  glyph: Cell;
  name: string;
  rest: string;
  why?: Cell;
  /** A dim line about earlier runs: `2 of the last 7 runs failed · l shows them`. */
  pattern?: string;
  /** Absent when nothing here can fix it; `does` then says where it is fixed. */
  key?: string;
  does: string;
  /** `it runs again on its own today 22:00`, then shorter ways to say it for a narrow terminal. */
  leave?: string[];
}

export interface CardOptions {
  canControl?: boolean;
  step?: RunStepNow;
}

function oneLine(text: string | undefined): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  return t ? t : undefined;
}

/** `it runs again on its own today 22:00`, when it will, so leaving it is a real choice. */
function againWords(s: Status, now: Date, watcher: WatcherFacts | undefined): string[] | undefined {
  if (!startsOnItsOwn(s) || !watcherTicking(watcher, now)) return undefined;
  const a = s.automation;
  if (a?.on.schedule && s.nextFire) {
    const when = whenWords(nominalFire(s.nextFire, s.staggerSec), now, a.on.schedule.timezone);
    return [`it runs again on its own ${when}`, `it runs again ${when}`];
  }
  if (a?.on.watch && !s.watchPausedAt) {
    return [`its watch looks again within ${a.on.watch.every}`, `it looks again within ${a.on.watch.every}`];
  }
  return undefined;
}

const PLATFORM_JOB: Record<string, string> = {
  win32: "It is the Windows scheduled task \\pi-automations\\tick",
  darwin: "It is a LaunchAgent that runs pa tick",
  linux: "It is a systemd user timer (or a cron entry) that runs pa tick",
};

function jobSentence(): string {
  return PLATFORM_JOB[process.platform] ?? "It is an operating-system job that runs pa tick";
}

function waitingWords(deps: Status[]): string {
  const names = deps.map((s) => s.name);
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
  return `${list} ${names.length === 1 ? "waits" : "wait"} for it`;
}

/** The watcher's card: off, late, or ticking for another install. */
function watcherCard(w: WatcherFacts, deps: Status[], now: Date, canControl: boolean): Card {
  const control = canControl && w.controllable !== false;
  const base = { glyph: { text: GLYPH.problem, color: "warning" as const }, name: "The watcher" };
  if (w.state === "stale" && watcherTicking(w, now)) {
    // Still ticking, but it runs another install's code.
    return {
      ...base,
      rest: " is registered for another install",
      why: { text: "it still ticks, but it stops when that install goes away" },
      ...(control ? { key: "w", does: "restart it for this one" } : { does: "restart it where it was registered" }),
    };
  }
  if (w.state === "stale") {
    const quiet = w.lastTickAt ? `no tick for ${spanWords(now.getTime() - Date.parse(w.lastTickAt))}` : "it has never ticked";
    return {
      ...base,
      rest: ` is late — ${quiet}`,
      why: { text: `nothing runs on its own until it ticks again · ${waitingWords(deps)}` },
      ...(control ? { key: "w", does: "restart it" } : { does: "restart it with: pa watcher start" }),
    };
  }
  return {
    ...base,
    rest: " is off — nothing runs on its own",
    why: { text: waitingWords(deps) },
    ...(control ? { key: "w", does: "start it" } : { does: w.note ? `the ticks come from ${w.note}` : "start it with: pa watcher start" }),
  };
}

export function cardFor(entry: InboxEntry, data: ListData, now: Date, opts: CardOptions = {}): Card {
  const watcher = data.facts.watcher;
  if (entry.kind === "watcher") {
    const deps = data.model.groups
      .flatMap((g) => g.rows.map((r) => r.status))
      .filter(startsOnItsOwn)
      .sort((x, y) => compareRank(comingRank(x), comingRank(y)));
    return watcherCard(watcher ?? { state: "off" }, deps, now, opts.canControl ?? true);
  }
  const s = entry.status as Status;
  const d = data.details?.[s.key];
  const records = recordsOf(d);
  switch (entry.kind) {
    case "invalid": {
      const hint = errorHint(s.reason);
      return {
        glyph: { text: GLYPH.failed, color: "error" },
        name: s.name,
        rest: " has a problem in its file",
        why: { text: oneLine(s.reason) ?? "it could not be read" },
        ...(hint ? { pattern: hint } : {}),
        key: "e",
        does: "fix it",
      };
    }
    case "failed": {
      const rec = d?.lastRecord ?? records.at(-1);
      const message = rec?.outcome === "failed" ? (rec.error?.message ?? rec.reason) : undefined;
      const why = oneLine(message ?? s.last?.reason);
      const failures = records.filter((r) => r.outcome === "failed").length;
      const leave = againWords(s, now, watcher);
      return {
        glyph: { text: GLYPH.failed, color: "error" },
        name: s.name,
        rest: ` failed ${agoWords(s.last?.at ?? now.toISOString(), now)}`,
        why: why ? { text: why } : { text: "it did not say why", color: "muted" },
        ...(failures >= 2 ? { pattern: `${failures} of the last ${records.length} runs failed · l shows them` } : {}),
        key: "r",
        does: "run it again",
        ...(leave ? { leave } : {}),
      };
    }
    case "watch": {
      const every = s.automation?.on.watch?.every;
      const leave = every && watcherTicking(watcher, now) ? [`it looks again within ${every}`] : undefined;
      return {
        glyph: { text: GLYPH.problem, color: "warning" },
        name: s.name,
        rest: "'s watch could not check",
        why: { text: oneLine(s.watch?.problem) ?? "its watch script failed" },
        key: "c",
        does: "see what it said",
        ...(leave ? { leave } : {}),
      };
    }
    case "consent": {
      const arm = armWords(s.automation);
      return {
        glyph: { text: GLYPH.problem, color: "warning" },
        name: s.name,
        rest: ` is off: ${consentWords(s.reason)}`,
        ...(arm ? { why: { text: arm, color: "muted" } } : {}),
        key: "a",
        does: "look at it, then arm it again",
      };
    }
    case "running": {
      const r = s.running;
      const usual = usualMs(records);
      const broken = s.state === "invalid" ? ` · its file has a problem now` : "";
      const step = opts.step;
      const why = step
        ? `now: ${step.label}${step.note ? ` · ${oneLine(step.note)}` : ""}`
        : r
          ? `started ${triggerWord(r.trigger)} at ${timeWords(r.startedAt)}`
          : "";
      const elapsed = r ? spanWords(now.getTime() - Date.parse(r.startedAt)) : "";
      return {
        glyph: { text: GLYPH.active, color: "accent" },
        name: s.name,
        rest: ` is running · ${elapsed} in${usual ? `, usually takes ${spanWords(usual)}` : ""}${broken}`,
        ...(why ? { why: { text: why } } : {}),
        key: "s",
        does: "show it",
      };
    }
    default:
      return { glyph: { text: " " }, name: s.name, rest: "", does: "" };
  }
}

export interface AgendaRow {
  when?: Cell;
  last?: Cell;
  note?: Cell;
}

// `✓ 12d ago`, `↷ skipped 3d ago`, `never run`: dim, and its ✓ is not green — fine is the default.
function lastCell(s: Status, now: Date): Cell {
  if (!s.last) return { text: "never run", color: "muted" };
  const ago = agoWords(s.last.at, now);
  switch (s.last.outcome) {
    case "ok":
      return { text: `${GLYPH.ok} ${ago}`, color: "muted" };
    case "failed":
      return { text: `${GLYPH.failed} failed ${ago}`, color: "muted" };
    case "skipped":
      return { text: `${GLYPH.late} skipped ${ago}`, color: "muted" };
    case "missed":
      return { text: `${GLYPH.missed} missed ${ago}`, color: "muted" };
    case "aborted":
      return { text: `${GLYPH.aborted} stopped ${ago}`, color: "muted" };
  }
}

export function agendaRow(entry: InboxEntry, now: Date): AgendaRow {
  const s = entry.status as Status;
  const a = s.automation;
  switch (entry.kind) {
    case "off":
      return {};
    case "not-armed":
      return { note: { text: "not armed · a arms it after a preview", color: "muted" } };
    case "paused":
      return { when: { text: "paused · p resumes", color: "warning" }, last: lastCell(s, now) };
    case "hold":
      return { when: { text: "on hold", color: "warning" }, last: lastCell(s, now) };
    case "manual":
      return { when: { text: "when you run it", color: "muted" }, last: lastCell(s, now) };
    case "watched":
      // Its steady interval, never a countdown: the next check is on its page.
      return { when: { text: a?.on.watch ? `every ${a.on.watch.every}` : "" }, last: lastCell(s, now) };
    default: {
      const when = a?.on.schedule && s.nextFire ? whenWords(nominalFire(s.nextFire, s.staggerSec), now, a.on.schedule.timezone) : "";
      return { when: { text: when }, last: lastCell(s, now) };
    }
  }
}

/** `daily` from `daily 08:00`, `weekdays` from `weekdays 09:00`, `every 15 min` as it is. */
function cadenceWords(cron: string): string {
  return scheduleWords({ cron }).replace(/ \d\d:\d\d$/, "");
}

function nextSentence(s: Status, now: Date): string | undefined {
  const a = s.automation;
  if (!a) return undefined;
  const parts: string[] = [];
  if (a.on.schedule && s.nextFire) {
    const at = whenLong(nominalFire(s.nextFire, s.staggerSec), now, a.on.schedule.timezone);
    parts.push(`Next run ${at}, then ${cadenceWords(a.on.schedule.cron)}.`);
  }
  if (a.on.watch && !s.watchPausedAt) {
    const every = `every ${a.on.watch.every}`;
    parts.push(
      s.nextCheck
        ? `${parts.length ? "Its watch also checks" : "Its watch checks"} ${whenLong(s.nextCheck, now)}, then ${every}.`
        : `${parts.length ? "Its watch also checks" : "Its watch checks"} ${every}.`,
    );
  }
  if (a.on.watch && s.watchPausedAt && a.on.schedule) parts.push("Its watch is paused.");
  return parts.length ? parts.join(" ") : undefined;
}

/** The sentence an automation's page opens with, in its state's colour. */
export function automationLead(s: Status, data: Pick<ListData, "details" | "facts">, now: Date): Cell {
  const a = s.automation;
  const d = data.details?.[s.key];
  const watcher = data.facts.watcher;
  if (s.running) {
    const r = s.running;
    const elapsed = now.getTime() - Date.parse(r.startedAt);
    const usual = usualMs(recordsOf(d));
    return { text: `${s.name} is running: ${runningWords(elapsed, usual, r.timeoutMs)}`, color: "accent" };
  }
  if (s.state === "invalid") {
    const hint = errorHint(s.reason);
    return { text: `${s.name} has a problem in its file: ${oneLine(s.reason) ?? "it could not be read"}.${hint ? ` Hint: ${hint}.` : ""}`, color: "error" };
  }
  if (s.state === "off") {
    const why = consentWords(s.reason);
    return why === "waiting for your consent"
      ? { text: `${s.name} is not armed yet. Nothing runs it until you arm it, after a preview of what it runs.`, color: "muted" }
      : { text: `${s.name} is off: ${why}. Look at it again, then arm it.`, color: "warning" };
  }
  if (s.state === "disabled") return { text: `${s.name} is disabled. Nothing starts it, not even r, until you enable it.`, color: "muted" };
  const ticking = watcherTicking(watcher, now);
  if (s.last?.outcome === "failed" && !isDismissed(d)) {
    const again = startsOnItsOwn(s) && ticking ? nextSentence(s, now) : undefined;
    return { text: `${s.name} failed ${agoLong(s.last.at, now)}.${again ? ` ${again.replace(/^Next run/, "It runs again on its own")}` : ""}`, color: "error" };
  }
  if (a?.on.watch && !s.watchPausedAt && s.watch?.problem) {
    const again = s.nextCheck && ticking ? ` It tries again ${whenLong(s.nextCheck, now)}.` : "";
    return { text: `${s.name}'s watch could not check: ${oneLine(s.watch.problem)}.${again}`, color: "warning" };
  }
  if (a?.on.watch && s.watchPausedAt && !a.on.schedule) {
    return { text: `${s.name}'s watch is paused since ${sinceWords(s.watchPausedAt, now)}, so nothing starts it on its own. You can still run it.`, color: "warning" };
  }
  if (startsOnItsOwn(s) && !ticking) {
    const until = watcher?.state === "stale" ? "ticks again" : "starts";
    return { text: `${s.name} is waiting for the watcher: nothing runs on its own until it ${until}.`, color: "warning" };
  }
  const healthy = !s.last || s.last.outcome === "ok" || s.last.outcome === "skipped";
  const first = healthy ? `${s.name} is healthy.` : `${s.name} is armed.`;
  const next = nextSentence(s, now) ?? (a?.on.manual ? "It runs only when you run it." : "Nothing starts it on its own.");
  return { text: `${first} ${next}`, color: healthy ? "success" : "text" };
}

const LABEL_W = 11;

/** `Last run` and `Message`: how its last run went, what it said, and what it left for you. */
function lastRunLines(s: Status, d: RecordsData | undefined, width: number, now: Date, t: LineTheme): string[] {
  const out: string[] = [];
  const valueW = Math.max(10, width - 2 - LABEL_W);
  const row = (label: string, value: string) => out.push(truncateToWidth(`  ${t.fg("muted", padTo(label, LABEL_W))}${value}`, width));
  const records = recordsOf(d);
  const last = records.at(-1);
  if (last) {
    const at = momentWords(last.endedAt ?? last.recordedAt, now);
    const took = tookMs(last);
    const mark =
      last.outcome === "ok"
        ? `${t.fg("success", GLYPH.ok)} ${at}`
        : last.outcome === "failed"
          ? `${t.fg("error", `${GLYPH.failed} failed`)} ${at}`
          : last.outcome === "skipped"
            ? `${t.fg("muted", `${GLYPH.late} skipped`)} ${at}`
            : last.outcome === "aborted"
              ? `${t.fg("warning", `${GLYPH.aborted} stopped`)} ${at}`
              : `${t.fg("warning", `${GLYPH.missed} missed`)} ${at}`;
    const quiet = last.outcome === "skipped" || last.outcome === "missed";
    row("Last run", `${mark}${took !== undefined && !quiet ? ` · took ${spanWords(took)}` : ""}`);
    // A run's own message says what its reply would; a failure still says why it failed.
    const own = last.message;
    const says = (own && last.outcome !== "failed") || (last.outcome === "ok" && !last.output?.text?.trim()) ? undefined : oneLine(runSays(last));
    if (says) {
      const lines = wrapWords(says, valueW);
      const shown = lines.slice(0, 3);
      if (lines.length > 3) shown[2] = ellipsize(`${shown[2]} …`, valueW);
      for (const l of shown) row("", l);
    }
    const failures = records.filter((r) => r.outcome === "failed").length;
    if (failures >= 2) row("", t.fg("muted", `${failures} of the last ${records.length} runs failed`));
    const notes = last.notes ?? [];
    if (own) {
      const text = messageText(own.text);
      const lines = text ? wrapWords(text, valueW) : [];
      const shown = lines.slice(0, 4);
      if (lines.length > 4) shown[3] = ellipsize(`${shown[3]} …`, valueW);
      shown.forEach((l, i) => row(i === 0 ? "Message" : "", l));
      own.links.forEach((l, i) => row(shown.length === 0 && i === 0 ? "Message" : "", linkLine(l, valueW, "", t)));
      if (notes.length > 0) row("", t.fg("muted", `and ${notes.length} note${notes.length === 1 ? "" : "s"} · l shows them`));
    } else if (notes.length > 0) {
      const shownNotes = notes.slice(-4);
      noteRows(shownNotes, valueW).forEach((l, i) => row(i === 0 ? "Message" : "", l));
      if (notes.length > shownNotes.length) row("", t.fg("muted", `and ${notes.length - shownNotes.length} earlier · l shows them`));
    }
  } else if (s.last) {
    row("Last run", `${s.last.outcome === "failed" ? t.fg("error", `${GLYPH.failed} failed`) : s.last.outcome === "ok" ? t.fg("success", GLYPH.ok) : t.fg("muted", s.last.outcome)} ${momentWords(s.last.at, now)}`);
  } else {
    row("Last run", t.fg("muted", "never run"));
  }
  return out;
}

/** Line 1: `Automations` and the watcher state on the right. */
export function headerLines(facts: ListHeaderFacts, width: number, theme?: LineTheme, now = new Date()): string[] {
  const t = theme ?? PLAIN_THEME;
  const left = strong(t, "Automations");
  const right = facts.watcher ? watcherWords(facts.watcher, now, t) : undefined;
  return [titleLine(left, right, width)];
}

function watcherWords(w: WatcherFacts, now: Date, t: LineTheme): string {
  if (w.state === "on" || watcherTicking(w, now)) return t.fg("muted", "watcher on");
  return t.fg("warning", w.state === "off" ? "watcher off" : "watcher late");
}

/** What `w` does now: stop a watcher that is on, start one that is off, restart a late one. */
function watcherKey(w: WatcherFacts | undefined): "stop" | "start" | "restart" | undefined {
  if (!w || w.controllable === false) return undefined;
  if (w.state === "on") return "stop";
  return w.state === "stale" ? "restart" : "start";
}

export interface ListData {
  model: ListingModel;
  facts: ListHeaderFacts;
  details?: Record<string, RecordsData>;
  config?: Config;
  home?: string;
  now?: Date;
  /** Absent: `e` opens AUTOMATION.md in an editor and no plugin adds anything. */
  extras?: ListExtras;
  steps?: Record<string, RunStepNow>;
}

/** The runs going on in this host, for a page that should notice one start or end. */
export interface ListRuns {
  running(): string[];
  step?(key: string): RunStepNow | undefined;
  subscribe(listener: () => void): () => void;
}

/** The part of the run registry the page reads. Structural, so this module needs no registry. */
export interface RunsSource {
  all(): { view: RunView }[];
  subscribe(listener: () => void): () => void;
}

/** The registry as the page sees it: what runs, and the deepest step each is on. */
export function listRunsFrom(registry: RunsSource): ListRuns {
  const going = () => registry.all().filter((e) => isRunning(e.view));
  return {
    running: () => going().map((e) => e.view.key),
    step: (key) => {
      const step = going()
        .find((e) => e.view.key === key)
        ?.view.steps.filter((s) => s.state === "active")
        .at(-1);
      return step ? { label: stepWords(step.label), ...(step.note ? { note: step.note } : {}) } : undefined;
    },
    subscribe: (listener) => {
      const off = registry.subscribe(listener);
      return off;
    },
  };
}

export interface ListHost {
  tui: RenderHost;
  theme?: LineTheme;
  close(): void;
  // A fresh `refresh()`; every action re-renders from it first, so nothing acts on a stale status.
  // `background` marks the timed re-read: the host may answer from slower-moving caches.
  reload(opts?: { background?: boolean }): Promise<ListData>;
  act(action: ListAction, status: Status): Promise<ListFlash | void> | ListFlash | void;
  /** Start or stop the watcher. Absent where the host cannot, and then `w` says so. */
  actGlobal?(action: GlobalAction): Promise<ListFlash | void> | ListFlash | void;
  /** The clock the page's times are read from. Ticks redraw times but never re-sort. */
  now?: () => Date;
  runs?: ListRuns;
  tickMs?: number;
  /**
   * Re-read everything this often, so an open page keeps up with what other processes do: runs
   * the watcher fires, watch checks, new records and messages. Absent: only runs in this process.
   */
  refreshMs?: number;
}

export interface ListFlash {
  message: string;
  tone: "success" | "info" | "warning" | "error";
}

const KEY = {
  up: ["\u001b[A", "\u001bOA"],
  down: ["\u001b[B", "\u001bOB"],
  pageUp: ["\u001b[5~"],
  pageDown: ["\u001b[6~"],
  home: ["\u001b[H", "\u001b[1~"],
  end: ["\u001b[F", "\u001b[4~"],
  enter: ["\r", "\n"],
  esc: ["\u001b"],
};

type HelpLine = [string, string, string?];

function helpSections(extras: ListExtras, compact = false): { title: string; keyW: number; lines: HelpLine[] }[] {
  const plugins: HelpLine[] = extras.actions
    .filter((a) => a.key && !RESERVED_KEYS.has(a.key))
    .map((a) => [a.key as string, a.label.charAt(0).toLowerCase() + a.label.slice(1)]);
  return [
    {
      title: "The page",
      keyW: 14,
      lines: [
        ["Needs you", "something went wrong or waits for you; the key on it deals with it", "something waits for you; the key on it deals with it"],
        ["Running now", "runs going right now; nothing to do", "runs going right now"],
        ["Coming up", "what runs on its schedule, soonest first; nothing to do", "scheduled runs, soonest first"],
        ["Watching", "what a watch starts, by name, and how often it checks", "what a watch starts, and how often it checks"],
        ["Off and disabled", "disabled or not armed yet; open one to enable or arm it", "disabled or not armed; open one to enable or arm it"],
      ],
    },
    {
      title: "On the selected automation",
      keyW: 10,
      lines: [
        ["enter", "open it: what it does, its last run, every action"],
        ["r  f", "run now · run and follow its flowchart"],
        ["x  s", "stop its run · show its run"],
        ["p  d", "pause or resume its watch · dismiss a failed run"],
        ["space  a", "disarm, disable or enable · arm it (shows the consent preview first)", "disarm, disable or enable · arm it (after the consent preview)"],
        ["e  l  c", "edit · its runs · check: every technical detail"],
        ...plugins,
      ],
    },
    {
      title: "The watcher",
      keyW: 10,
      lines: [["w", "start it, or stop it (it asks first and names what would stop)", "start it, or stop it (it asks first)"]],
    },
    {
      title: "Moving around",
      keyW: 0,
      lines: compact
        ? [["", "↑↓ PgUp PgDn Home End  move   R  refresh   esc  back   q  close   y  yes"]]
        : [
            ["", "↑↓ PgUp PgDn Home End   move     R  refresh"],
            ["", "esc  back, or close     q  close     y  yes, when asked"],
          ],
    },
  ];
}

export function createListScreen(host: ListHost, initial: ListData): WindowComponent {
  const theme = host.theme ?? PLAIN_THEME;
  const canControl = Boolean(host.actGlobal);
  const clock = (): Date => host.now?.() ?? data.now ?? new Date();

  let data = initial;
  let tri = triage(data, data.now ?? host.now?.() ?? new Date());
  let selectedKey: string | undefined = order()[0]?.key;
  let selectedIndex = 0;
  let page: { key: string; index: number } | undefined;
  let confirm: "watcher-stop" | undefined;
  let help = false;
  let flash: (ListFlash & { pending?: boolean }) | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let rereadTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function order(): InboxEntry[] {
    return tri.sections.flatMap((s) => s.items);
  }

  function requestRender(): void {
    if (disposed) return;
    try {
      host.tui.requestRender();
    } catch {
      disposed = true;
    }
  }

  // The clock: times on the page move, the order does not.
  const ticker = host.now
    ? setInterval(() => {
        if (!disposed) requestRender();
      }, host.tickMs ?? 15_000)
    : undefined;
  ticker?.unref?.();

  // What other processes change (the watcher's runs, watch checks, records) only shows on a re-read.
  let polling = false;
  const refresher = host.refreshMs
    ? setInterval(() => {
        if (disposed || polling) return;
        polling = true;
        void reload(undefined, { background: true })
          .catch(() => undefined)
          .finally(() => {
            polling = false;
          });
      }, host.refreshMs)
    : undefined;
  refresher?.unref?.();

  // A run starting or ending is a real change: re-read, so its card comes and goes.
  let runningSet = host.runs ? [...host.runs.running()].sort().join("\n") : "";
  const unsubscribe = host.runs?.subscribe(() => {
    if (disposed || !host.runs) return;
    const next = [...host.runs.running()].sort().join("\n");
    if (next !== runningSet) {
      runningSet = next;
      void reload().catch(() => undefined);
      rereadSoon();
    } else {
      requestRender();
    }
  });

  /** A flash clears itself after four seconds; a pending one stays until its answer replaces it. */
  function setFlash(next: (ListFlash & { pending?: boolean }) | undefined): void {
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = undefined;
    }
    flash = next;
    if (next && !next.pending) {
      flashTimer = setTimeout(() => {
        flash = undefined;
        requestRender();
      }, 4_000);
      flashTimer.unref?.();
    }
    requestRender();
  }

  function rereadSoon(): void {
    if (rereadTimer) clearTimeout(rereadTimer);
    rereadTimer = setTimeout(() => {
      rereadTimer = undefined;
      if (!disposed) void reload().catch(() => undefined);
    }, 1_500);
    rereadTimer.unref?.();
  }

  function clearFlash(): void {
    if (flash && !flash.pending) setFlash(undefined);
  }

  function selectedEntry(): InboxEntry | undefined {
    const all = order();
    const found = all.find((e) => e.key === selectedKey);
    if (found) return found;
    // Its automation has gone: the nearest one to where it was.
    const near = all[Math.min(selectedIndex, all.length - 1)];
    selectedKey = near?.key;
    return near;
  }

  function entryOf(key: string | undefined): InboxEntry | undefined {
    return key === undefined ? undefined : order().find((e) => e.key === key);
  }

  function move(delta: number): void {
    const all = order();
    if (all.length === 0) return;
    const at = Math.max(0, all.findIndex((e) => e.key === selectedEntry()?.key));
    const next = Math.min(all.length - 1, Math.max(0, at + delta));
    if (next === at) return;
    selectedKey = all[next]?.key;
    selectedIndex = next;
    requestRender();
  }

  // Re-read everything; the cursor follows its automation.
  async function reload(targetKey?: string, opts?: { background?: boolean }): Promise<InboxEntry | undefined> {
    data = await host.reload(opts);
    if (disposed) return undefined;
    const at = order().findIndex((e) => e.key === selectedKey);
    if (at !== -1) selectedIndex = at;
    tri = triage(data, data.now ?? host.now?.() ?? new Date());
    selectedEntry();
    if (page && !entryOf(page.key)) {
      page = undefined;
      setFlash({ tone: "warning", message: "that automation is no longer listed" });
    }
    if (page) {
      const status = entryOf(page.key)?.status;
      const n = status ? menuFor(status, data.extras ?? DEFAULT_EXTRAS).length : 1;
      page.index = Math.min(page.index, Math.max(0, n - 1));
    }
    requestRender();
    return targetKey ? entryOf(targetKey) : selectedEntry();
  }

  /** Every action goes through here, so none of them can act on a stale status. */
  function allowed(action: ListAction, status: Status): boolean {
    if (action === "toggle") return toggleTarget(status) !== undefined;
    if (action === "edit" || action.startsWith("plugin:")) return true;
    return actionsFor(status).some((a) => a.action === action);
  }

  function run(action: ListAction | "watch-toggle", targetKey: string | undefined): void {
    if (!targetKey || targetKey === WATCHER_KEY) return;
    void reload(targetKey).then((item) => {
      const status = item?.status;
      if (!status) {
        setFlash({ tone: "warning", message: "that automation is no longer listed" });
        return;
      }
      // `p` decides pause or resume from the status it just re-read, not the one on screen.
      const actual: ListAction =
        action === "watch-toggle" ? (status.watchPausedAt ? "resume-watch" : "pause-watch") : action;
      // Recompute affordances: an automation that started running must not be run again.
      if (!allowed(actual, status)) {
        setFlash({ tone: "warning", message: whyNot(actual, status) ?? "that action is no longer available here" });
        return;
      }
      void Promise.resolve(host.act(actual, status)).then((result) => {
        if (isFlash(result)) {
          setFlash(result);
          void reload();
        }
        // A run takes a moment to take its lock, so look again: the page then shows it running.
        if (actual === "run" || actual === "run-flow" || actual === "stop") rereadSoon();
      });
    });
  }

  // A key that does not apply says why, in the words of the automation. Undefined when it applies.
  function whyNot(action: ListAction | "watch-toggle", status: Status): string | undefined {
    const n = status.name;
    const key = KEY_OF[action];
    const why = ((): string | undefined => {
      if (action === "watch-toggle") return status.automation?.on.watch ? undefined : `${n} has no watch to pause`;
      if (allowed(action, status)) return undefined;
      if (status.state === "invalid" && action !== "check") return `${n} cannot do that until its file is fixed · e edits it`;
      switch (action) {
        case "run":
        case "run-flow":
          if (status.running) return `${n} is already running · s shows it`;
          if (status.state === "off") return `${n} is not armed · a shows what it runs, then arms it`;
          if (status.state === "disabled") return `${n} is disabled · space enables it`;
          if (action === "run-flow") return `${n} is not on a flowchart · r runs it`;
          return undefined;
        case "stop":
          return `${n} is not running`;
        case "window":
          return `${n} is not running · l shows its last runs`;
        case "dismiss-run":
          return status.running ? `${n} is running` : `${n} has no failed run to dismiss`;
        case "arm":
          return `${n} is already armed`;
        case "toggle":
          return `space has nothing to do for ${n}`;
        default:
          return `that does not apply to ${n}`;
      }
    })();
    return why ? `${key} · ${why}` : undefined;
  }

  function runGlobal(action: GlobalAction): void {
    if (!host.actGlobal) return;
    const restart = action === "watcher-start" && data.facts.watcher?.state === "stale";
    setFlash({
      tone: "info",
      pending: true,
      message:
        action === "watcher-start"
          ? `${restart ? "Restarting" : "Starting"} the watcher — waiting for its first tick…`
          : "Stopping the watcher…",
    });
    void Promise.resolve(host.actGlobal(action))
      .then((result) => {
        setFlash(isFlash(result) ? result : undefined);
        void reload();
      })
      .catch((e: unknown) => setFlash({ tone: "error", message: String((e as Error)?.message ?? e) }));
  }

  function isFlash(value: unknown): value is ListFlash {
    return typeof value === "object" && value !== null && "message" in value && "tone" in value;
  }

  /** `w`: start, stop after a question, restart — or say why it cannot. */
  function watcherKeyPressed(): void {
    const w = data.facts.watcher;
    const what = canControl ? watcherKey(w) : undefined;
    if (what === "stop") {
      confirm = "watcher-stop";
      requestRender();
    } else if (what) {
      runGlobal("watcher-start");
    } else if (w?.note && w.controllable === false) {
      setFlash({ tone: "warning", message: `w · the ticks come from ${w.note}: stop it where it runs` });
    } else {
      setFlash({ tone: "warning", message: "w · the watcher cannot be started or stopped from here" });
    }
  }

  // --- drawing ---------------------------------------------------------------------------------

  const cursorMark = (on: boolean): string => (on ? strong(theme, GLYPH.cursor) : " ");

  function flashFrame(): { flash: { text: string; color: UiColor } } | Record<string, never> {
    return flash ? { flash: { text: flash.message, color: flash.tone === "info" ? "accent" : flash.tone } } : {};
  }

  /** A card's lines: `❯ ✗ name what`, why, the pattern, then `r  run it again   or leave it: …`. */
  function cardLines(card: Card, on: boolean, width: number): string[] {
    const pad = "      ";
    const room = Math.max(1, width - pad.length);
    const out = [truncateToWidth(ellipsize(`  ${cursorMark(on)} ${theme.fg(card.glyph.color ?? "text", card.glyph.text)} ${strong(theme, card.name)}${card.rest}`, width), width)];
    if (card.why) out.push(`${pad}${theme.fg(card.why.color ?? "text", ellipsize(card.why.text, room))}`);
    if (card.pattern) out.push(`${pad}${theme.fg("muted", ellipsize(card.pattern, room))}`);
    const left = card.key ? `${pad}${strong(theme, card.key)}  ${card.does}` : `${pad}${theme.fg("muted", card.does)}`;
    let line = truncateToWidth(left, width);
    for (const option of card.leave ?? []) {
      const text = `or leave it: ${option}`;
      const col = Math.max(visibleWidth(left) + 3, 33);
      if (col + visibleWidth(text) <= width) {
        line = `${left}${" ".repeat(col - visibleWidth(left))}${theme.fg("muted", text)}`;
        break;
      }
    }
    out.push(line);
    return out;
  }

  function listBody(width: number, now: Date): { lines: string[]; spans: Map<string, [number, number]>; starts: number[] } {
    const lines: string[] = [];
    const spans = new Map<string, [number, number]>();
    const starts: number[] = [];
    const sel = selectedEntry()?.key;
    if (!tri.sections.some((s) => s.id === "needs")) lines.push(`  ${theme.fg("success", GLYPH.ok)} Nothing needs you.`);

    const agenda = tri.sections.filter((s) => !CARD_SECTIONS.has(s.id)).flatMap((s) => s.items);
    const rows = new Map(agenda.map((e) => [e.key, agendaRow(e, now)]));
    const whenW = Math.max(8, ...[...rows.values()].map((r) => visibleWidth(r.when?.text ?? ""))) + 3;
    const nameW = Math.min(32, Math.max(8, ...agenda.map((e) => visibleWidth(e.name))) + 5);

    for (const section of tri.sections) {
      if (lines.length > 0) lines.push("");
      starts.push(lines.length);
      lines.push(`  ${sectionHeading(theme, section.id, section.title)}`);
      section.items.forEach((entry, i) => {
        const on = entry.key === sel;
        if (CARD_SECTIONS.has(section.id)) {
          if (i > 0) lines.push("");
          const card = cardFor(entry, data, now, {
            canControl,
            ...(stepOf(entry.key) ? { step: stepOf(entry.key) as RunStepNow } : {}),
          });
          const from = lines.length;
          starts.push(from);
          lines.push(...cardLines(card, on, width));
          spans.set(entry.key, [from, lines.length - 1]);
          return;
        }
        spans.set(entry.key, [lines.length, lines.length]);
        starts.push(lines.length);
        lines.push(agendaLine(entry, rows.get(entry.key) ?? {}, on, width, whenW, nameW));
      });
    }
    if (order().length === 0) {
      lines.push("", theme.fg("muted", ellipsize("  No automations yet · put an AUTOMATION.md in ~/.agents/automations/<name>/, then press R", width)));
    }
    return { lines, spans, starts };
  }

  function stepOf(key: string): RunStepNow | undefined {
    return host.runs?.step?.(key) ?? data.steps?.[key];
  }

  function agendaLine(entry: InboxEntry, row: AgendaRow, on: boolean, width: number, whenW: number, nameW: number): string {
    const off = entry.section === "off";
    const plainName = (w: number) => padTo(ellipsize(entry.name, Math.max(4, w - 2)), w);
    const styleName = (text: string) => (on ? strong(theme, text) : off ? theme.fg("muted", text) : text);
    const lead = `  ${cursorMark(on)} `;
    if (off) {
      const note = row.note ? theme.fg(row.note.color ?? "muted", row.note.text) : "";
      const name = note ? plainName(nameW) : entry.name;
      return truncateToWidth(ellipsize(`${lead}${styleName(name)}${note}`.replace(/\s+$/, ""), width), width);
    }
    const when = theme.fg(row.when?.color ?? "text", padTo(row.when?.text ?? "", whenW));
    const last = row.last ? theme.fg(row.last.color ?? "muted", row.last.text) : "";
    const full = `${lead}${when}${styleName(plainName(nameW))}${last}`;
    if (visibleWidth(full) <= width) return full.replace(/\s+$/, "");
    // Short of room, the last result goes first, then the name gives way.
    const room = Math.max(4, width - visibleWidth(lead) - whenW);
    return truncateToWidth(`${lead}${when}${styleName(ellipsize(entry.name, room))}`, width);
  }

  function listPage(width: number, rows: number | undefined, now: Date): string[] {
    const { lines, spans, starts } = listBody(width, now);
    const span = spans.get(selectedEntry()?.key ?? "") ?? [0, 0];
    const room = rows === undefined ? lines.length : bodyRows(rows);
    const area = (n?: number): string[] => messageArea(selectedEntry(), width, now, n);
    // The list keeps priority: the area takes what is left, or a few rows when the list can spare them.
    const natural = area().length;
    let areaRoom = natural;
    if (rows !== undefined) {
      const listMin = Math.min(lines.length, Math.max(6, Math.ceil(room * 0.55)));
      areaRoom = Math.min(natural, room - Math.min(lines.length, room));
      // Short of what is left: the heading, a line of text and three links, or less, if the list can spare them.
      for (let size = Math.min(natural, 6); size > areaRoom && size >= 3; size--) {
        if (room - size >= listMin) {
          areaRoom = size;
          break;
        }
      }
    }
    const below = areaRoom >= 3 ? area(areaRoom) : [];
    return renderPage(
      {
        title: headerLines(data.facts, width, theme, now)[0] ?? "",
        body: [...windowCards(lines, span, rows === undefined ? lines.length : room - below.length, starts), ...below],
        // Only keys no card prints: a card's own key is on the card, once.
        hints: [{ text: "↑↓ move", rank: 2 }, { text: "enter open", rank: 1 }],
        pinned: ["? help", "esc close"],
        ...flashFrame(),
      },
      width,
      rows,
      theme,
    );
  }

  /** The selected automation's last message, under the list. A failure's card already says why. */
  function messageArea(entry: InboxEntry | undefined, width: number, now: Date, room?: number): string[] {
    const s = entry?.status;
    if (!entry || !s) return [];
    const last = recordsOf(data.details?.[s.key]).at(-1);
    const shown = shownMessage(last);
    if (!last || !shown) return [];
    if (shown.from === "reply" && entry.section === "needs") return [];
    return messageAreaLines({ name: s.name, when: momentWords(last.endedAt ?? last.recordedAt, now), shown, width, ...(room !== undefined ? { room } : {}), theme });
  }

  /** The part of the page that fits, with the selected card or row whole in it. */
  function windowCards(lines: string[], span: [number, number], room: number, starts: number[]): string[] {
    if (lines.length <= room) return lines;
    if (room < 3) return windowBlock(lines, span[0], span[1], room, theme);
    const fits = (start: number): boolean => {
      const shown = room - (start > 0 ? 1 : 0) - (start + room - (start > 0 ? 1 : 0) < lines.length ? 1 : 0);
      return span[1] < start + shown;
    };
    const height = span[1] - span[0] + 1;
    const centred = Math.max(0, span[0] - Math.floor((room - 2 - height + 1) / 2));
    const candidates = [0, ...starts.filter((s) => s <= span[0])];
    const before = candidates.filter((s) => s <= centred && fits(s));
    const start = before.length > 0 ? Math.max(...before) : (candidates.filter((s) => s >= centred).find(fits) ?? span[0]);
    const above = start > 0;
    const shown = room - (above ? 1 : 0) - (start + room - (above ? 1 : 0) < lines.length ? 1 : 0);
    const end = start + shown;
    return [
      ...(above ? [theme.fg("muted", "  ↑ more above")] : []),
      ...lines.slice(start, end),
      ...(end < lines.length ? [theme.fg("muted", "  ↓ more below")] : []),
    ];
  }

  function automationPage(entry: InboxEntry, width: number, rows: number | undefined, now: Date): string[] {
    if (!page) return [];
    const s = entry.status as Status;
    const d = data.details?.[s.key];
    const body: string[] = [];
    const textW = Math.max(10, width - 4);
    const lead = automationLead(s, data, now);
    for (const l of wrapWords(lead.text, textW)) body.push(`  ${theme.fg(lead.color ?? "text", l)}`);
    body.push("");
    const description = oneLine(s.automation?.description);
    if (description) {
      for (const l of wrapWords(description, textW)) body.push(`  ${l}`);
      body.push("");
    }
    if (s.state !== "invalid" || s.last) {
      body.push(...lastRunLines(s, d, width, now, theme), "");
    }
    const options = menuFor(s, data.extras ?? DEFAULT_EXTRAS);
    page.index = Math.min(page.index, Math.max(0, options.length - 1));
    const actionsAt = body.length;
    options.forEach((o, i) => {
      const on = i === page?.index;
      body.push(truncateToWidth(`  ${cursorMark(on)} ${padTo(o.key ?? "", 7)}${on ? strong(theme, o.label) : o.label}`, width));
    });
    const room = rows === undefined ? body.length : bodyRows(rows);
    const at = actionsAt + page.index;
    return renderPage(
      {
        title: strong(theme, s.name),
        body: body.length <= room ? body : windowBlock(body, at, at, room, theme),
        hints: [{ text: "↑↓ choose", rank: 2 }, { text: "enter do it", rank: 1 }],
        pinned: ["esc back"],
        ...flashFrame(),
      },
      width,
      rows,
      theme,
    );
  }

  /** What one automation will miss while the watcher is off, in words. */
  function missSentence(s: Status, now: Date): string {
    const a = s.automation;
    const parts: string[] = [];
    if (a?.on.watch && !s.watchPausedAt) {
      const due = s.nextCheck !== undefined && Date.parse(s.nextCheck) > now.getTime();
      parts.push(`its watch: ${checkMissWords(s, now)}${due ? ", or after it" : ""}`);
    }
    if (a?.on.schedule) {
      const when = s.nextFire ? `no run ${atWords(nominalFire(s.nextFire, s.staggerSec), now, a.on.schedule.timezone)}` : "no runs";
      parts.push(`its schedule: ${when}; ${a.on.schedule.catchUp === "once" ? "catch-up once runs it late, when the watcher is back" : "it does not catch up"}`);
    }
    return parts.join(" · ");
  }

  function watcherPage(width: number, rows: number | undefined, now: Date): string[] {
    const w = data.facts.watcher ?? { state: "off" as const };
    const card = cardFor({ key: WATCHER_KEY, section: "needs", kind: "watcher", name: "The watcher" }, data, now, { canControl });
    const body: string[] = [];
    const textW = Math.max(10, width - 4);
    for (const l of wrapWords(`${card.name}${card.rest}.`, textW)) body.push(`  ${theme.fg("warning", l)}`);
    body.push("");
    for (const l of wrapWords(`${jobSentence()}. It wakes once a minute; it is the only thing that fires schedules and checks watches.`, textW)) body.push(`  ${l}`);
    body.push("");
    body.push(`  ${theme.fg("muted", padTo("Last tick", LABEL_W))}${w.lastTickAt ? momentWords(w.lastTickAt, now) : theme.fg("muted", "never")}`);
    if (w.note) body.push(truncateToWidth(`  ${theme.fg("muted", padTo("Note", LABEL_W))}${w.note}`, width));
    body.push("");
    const deps = tri.dependents;
    if (deps.length > 0) {
      body.push(`  ${strong(theme, "Waiting for it")}`);
      const nameW = Math.min(24, Math.max(...deps.map((s) => visibleWidth(s.name))) + 3);
      for (const s of deps) {
        for (const l of wrapHanging(`    ${padTo(s.name, nameW)}${missSentence(s, now)}`, width)) body.push(l);
      }
      body.push("");
    }
    if (card.key) body.push(`  ${cursorMark(true)} ${padTo(card.key, 7)}${strong(theme, card.does)}`);
    else body.push(`  ${theme.fg("muted", card.does)}`);
    return renderPage(
      {
        title: strong(theme, "The watcher"),
        body,
        hints: card.key ? [{ text: "enter do it", rank: 1 }] : [],
        pinned: ["esc back"],
        ...flashFrame(),
      },
      width,
      rows,
      theme,
    );
  }

  function confirmPage(width: number, rows: number | undefined, now: Date): string[] {
    const w = data.facts.watcher;
    const body: string[] = [];
    const tickWords = w?.lastTickAt ? ` It is on; the last tick was ${agoWords(w.lastTickAt, now)}.` : "";
    for (const l of wrapWords(`${jobSentence()}. It wakes once a minute and is the only thing that fires schedules and checks watches.${tickWords}`, width)) body.push(l);
    body.push("");
    const deps = tri.dependents;
    const nameW = Math.min(20, Math.max(8, ...deps.map((s) => visibleWidth(s.name))));
    const row = (mark: string, name: string, text: string): void => {
      const lead = `  ${mark} ${padTo(ellipsize(name, nameW), nameW)}  `;
      for (const l of wrapHanging(`${lead}${text}`, width)) body.push(l);
    };
    if (deps.length) {
      body.push(strong(theme, "Stops"));
      for (const s of deps) row(theme.fg("warning", GLYPH.problem), s.name, missSentence(s, now));
    } else {
      body.push(theme.fg("muted", "Nothing waits for it: every armed automation here runs only when you run it."));
    }
    body.push("");
    body.push(strong(theme, "Keeps working"));
    const running = data.model.groups.flatMap((g) => g.rows.map((r) => r.status)).filter((s) => s.running);
    for (const s of running) row(theme.fg("accent", GLYPH.active), s.name, "its run carries on to the end");
    row(" ", "runs by hand", "r, f and enter work as usual");
    body.push("");
    for (const l of wrapWords("Starting it again takes a few seconds: w, then it waits for its first tick.", width)) body.push(theme.fg("muted", l));
    return renderPage(
      {
        title: strong(theme, theme.fg("warning", "Stop the watcher?")),
        body,
        hints: [],
        pinned: ["y stop the watcher", "esc keep it running"],
      },
      width,
      rows,
      theme,
    );
  }

  function helpPage(width: number, rows: number | undefined): string[] {
    const build = (compact: boolean) =>
      helpSections(data.extras ?? DEFAULT_EXTRAS, compact).map((s) => {
        const lines = s.lines.map(([key, long, short]) => {
          const lead = `    ${padTo(key, s.keyW)}`;
          const text = visibleWidth(lead) + visibleWidth(long) <= width || !short ? long : short;
          return truncateToWidth(`${lead}${theme.fg("muted", ellipsize(text, Math.max(1, width - visibleWidth(lead))))}`, width);
        });
        return [`  ${strong(theme, s.title)}`, ...lines];
      });
    const spaced = (sections: string[][]) => sections.flatMap((s, i) => (i === 0 ? s : ["", ...s]));
    const full = build(false);
    const room = rows === undefined ? Number.MAX_SAFE_INTEGER : bodyRows(rows);
    // Short of rows, the moving-around keys share a line before the sections lose their spacing.
    const body = [spaced(full), spaced(build(true)), build(true).flat()].find((b) => b.length <= room) ?? build(true).flat();
    return renderPage(
      { title: `${strong(theme, "Automations")}${theme.fg("muted", " · help")}`, body, hints: [], pinned: ["any key closes"] },
      width,
      rows,
      theme,
    );
  }

  function actOnKey(key: string, entry: InboxEntry): boolean {
    const status = entry.status as Status;
    const pluginAction = (data.extras ?? DEFAULT_EXTRAS).actions.find((a) => a.key === key && !RESERVED_KEYS.has(key));
    const action = ACTION_OF[key] ?? (pluginAction ? (`plugin:${pluginAction.id}` as const) : undefined);
    if (!action) return false;
    const why = whyNot(action, status);
    if (why) setFlash({ tone: "warning", message: why });
    else run(action, entry.key);
    return true;
  }

  return {
    render(width: number): string[] {
      const now = clock();
      const rows = pageRows(host.tui);
      const w = Math.max(1, width);
      if (help) return helpPage(w, rows);
      if (confirm) return confirmPage(w, rows, now);
      if (page) {
        if (page.key === WATCHER_KEY) {
          if (entryOf(WATCHER_KEY)) return watcherPage(w, rows, now);
          page = undefined;
        } else {
          const entry = entryOf(page.key);
          if (entry?.status) return automationPage(entry, w, rows, now);
          page = undefined;
        }
      }
      return listPage(w, rows, now);
    },

    handleInput(key: string): void {
      clearFlash();
      if (help) {
        help = false;
        requestRender();
        return;
      }

      // Only y says yes: the enter that opened a question must never also answer it.
      if (confirm) {
        if (key === "y" || key === "Y") {
          confirm = undefined;
          runGlobal("watcher-stop");
          return;
        }
        if (KEY.esc.includes(key) || key === "n" || key === "N") {
          confirm = undefined;
          requestRender();
        }
        return;
      }

      if (key === "?") {
        help = true;
        requestRender();
        return;
      }
      if (key === "q") return host.close();
      if (key === "R") {
        void reload().catch(() => undefined);
        return;
      }
      if (key === "w") return watcherKeyPressed();

      if (page) {
        if (KEY.esc.includes(key)) {
          page = undefined;
          requestRender();
          return;
        }
        if (page.key === WATCHER_KEY) {
          if (KEY.enter.includes(key)) watcherKeyPressed();
          return;
        }
        const entry = entryOf(page.key);
        const status = entry?.status;
        if (!entry || !status) return;
        const options = menuFor(status, data.extras ?? DEFAULT_EXTRAS);
        if (KEY.up.includes(key) || KEY.down.includes(key) || KEY.home.includes(key) || KEY.end.includes(key)) {
          const delta = KEY.up.includes(key) ? -1 : KEY.down.includes(key) ? 1 : KEY.home.includes(key) ? -options.length : options.length;
          page.index = Math.min(options.length - 1, Math.max(0, page.index + delta));
          requestRender();
          return;
        }
        const byKey = options.findIndex((o) => o.key !== undefined && (o.key === key || (o.key === "space" && key === " ")));
        if (KEY.enter.includes(key) || byKey !== -1) {
          const chosen = options[byKey !== -1 ? byKey : page.index];
          if (byKey !== -1) page.index = byKey;
          requestRender();
          if (chosen) run(chosen.action, entry.key);
          return;
        }
        actOnKey(key, entry);
        return;
      }

      if (KEY.esc.includes(key)) return host.close();
      if (KEY.up.includes(key)) return move(-1);
      if (KEY.down.includes(key)) return move(1);
      if (KEY.pageUp.includes(key)) return move(-10);
      if (KEY.pageDown.includes(key)) return move(10);
      if (KEY.home.includes(key)) return move(-order().length);
      if (KEY.end.includes(key)) return move(order().length);

      const entry = selectedEntry();
      if (!entry) return;
      if (KEY.enter.includes(key)) {
        page = { key: entry.key, index: 0 };
        requestRender();
        return;
      }
      if (entry.key === WATCHER_KEY) {
        if (ROW_KEYS.has(key)) setFlash({ tone: "warning", message: `${key === " " ? "space" : key} · that acts on an automation; this card is the watcher · w ${watcherKey(data.facts.watcher) ?? "controls it"}` });
        return;
      }
      actOnKey(key, entry);
    },

    invalidate(): void {
      requestRender();
    },

    dispose(): void {
      disposed = true;
      if (flashTimer) clearTimeout(flashTimer);
      if (rereadTimer) clearTimeout(rereadTimer);
      if (ticker) clearInterval(ticker);
      if (refresher) clearInterval(refresher);
      unsubscribe?.();
    },
  };
}

/** `at 22:24` later today, `tomorrow 09:00` after. Future times only: see `checkMissWords`. */
function atWords(iso: string, now: Date, timezone?: string): string {
  const when = whenWords(iso, now, timezone);
  return when.startsWith("in ") || when.startsWith("today ") || when === "now" ? `at ${timeWords(iso, timezone)}` : when;
}

// What a watch misses while the watcher is off.
function checkMissWords(s: Status, now: Date): string {
  if (!s.nextCheck) return "no checks";
  if (Date.parse(s.nextCheck) > now.getTime()) return `no check ${atWords(s.nextCheck, now)}`;
  if (!s.watch?.checkedAt) return "no checks yet";
  return `no checks since ${sinceWords(s.watch.checkedAt, now)}`;
}

const ACTION_OF: Record<string, ListAction | "watch-toggle"> = {
  s: "window",
  r: "run",
  f: "run-flow",
  " ": "toggle",
  e: "edit",
  a: "arm",
  l: "log",
  c: "check",
  x: "stop",
  d: "dismiss-run",
  p: "watch-toggle",
};
const ROW_KEYS = new Set(Object.keys(ACTION_OF));
const RESERVED_KEYS: ReadonlySet<string> = new Set([...ROW_KEYS, "w", "R", "?", "q"]);
const KEY_OF: Record<string, string> = Object.fromEntries(
  Object.entries(ACTION_OF).map(([k, a]) => [a, k === " " ? "space" : k]),
) as Record<string, string>;
KEY_OF["pause-watch"] = "p";
KEY_OF["resume-watch"] = "p";
KEY_OF["disable"] = "space";
KEY_OF["enable"] = "space";
KEY_OF["disarm"] = "space";
KEY_OF["arm-and-run"] = "enter";

function toggleTarget(status: Status): ListAction | undefined {
  if (status.state === "off") return "arm";
  if (status.scope === "user") {
    if (status.state === "armed") return "disable";
    if (status.state === "disabled") return "enable";
  }
  if (status.scope === "repository") {
    if (status.state === "armed") return "disarm";
  }
  return undefined;
}

export function actionForToggle(status: Status): ListAction | undefined {
  return toggleTarget(status);
}

export type { Row };
