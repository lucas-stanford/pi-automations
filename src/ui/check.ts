// The check page: Schedule, Last check, Runs, Setup and Files. Pure.

import path from "node:path";
import { tildify } from "../paths.js";
import { timeoutText } from "../status.js";
import type { Config, Hook, RunRecord, Status } from "../types.js";
import { consentWords, runMark, runSays, watcherTicking, type WatcherFacts } from "./details.js";
import { GLYPH } from "./glyphs.js";
import { type LineTheme, PLAIN_THEME, strong, type UiColor } from "./theme.js";
import { padTo } from "./width.js";
import {
  armWords,
  errorHint,
  momentWords,
  scheduleWords,
  spanWords,
  startPhrase,
  tookMs,
  triggerWord,
  usualMs,
  whenWords,
} from "./words.js";

export interface CheckFacts {
  status: Status;
  now: Date;
  home: string;
  config: Config;
  /** Recent records, oldest first. */
  records?: RunRecord[];
  /** Script → the command that runs it on this machine. */
  interpreters?: Record<string, string>;
  digest?: string;
  /** The next cron instants, ISO. */
  nextRuns?: string[];
  watcher?: WatcherFacts;
}

const LABEL = 14;

const RECENT_COLOR: Record<RunRecord["outcome"], UiColor> = {
  ok: "success",
  failed: "error",
  skipped: "muted",
  missed: "warning",
  aborted: "warning",
};
const RECENT_GLYPH: Record<RunRecord["outcome"], string> = {
  ok: GLYPH.ok,
  failed: GLYPH.failed,
  skipped: GLYPH.late,
  missed: GLYPH.missed,
  aborted: GLYPH.aborted,
};

function hookText(hooks: Hook[], phase: "pre" | "post"): string[] {
  return hooks.map((h) => ("script" in h ? `${phase} ${h.script}` : `${phase} prompt: ${firstLine(h.prompt)}`));
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}

/** `11m ago`, `today 09:12`, `in 3m`, `tomorrow 09:00`: one clock, past or future. */
function both(iso: string, now: Date): string {
  return Date.parse(iso) > now.getTime() ? whenWords(iso, now) : momentWords(iso, now);
}

export function checkPageLines(f: CheckFacts, theme?: LineTheme): string[] {
  const t = theme ?? PLAIN_THEME;
  const s = f.status;
  const a = s.automation;
  const now = f.now;
  const out: string[] = [];
  const section = (title: string): void => {
    if (out.length > 0) out.push("");
    out.push(strong(t, title));
  };
  const row = (label: string, value: string): void => {
    out.push(`  ${t.fg("muted", padTo(label, LABEL))}${value}`);
  };

  if (s.state === "invalid") {
    section("Problem");
    if (s.problems && s.problems.length > 0) {
      const [field] = (s.reason ?? "").split(":", 1);
      row("Error", t.fg("error", `${field}: ${s.problems.length} problem${s.problems.length === 1 ? "" : "s"}`));
      for (const p of s.problems) row("", t.fg("error", p));
    } else {
      row("Error", t.fg("error", s.reason ?? "its AUTOMATION.md could not be read"));
    }
    const hint = errorHint(s.reason);
    if (hint) row("Hint", hint);
  } else if (s.state === "off") {
    section("Waiting for you");
    row("Consent", t.fg("warning", consentWords(s.reason)));
    const arm = armWords(a);
    if (arm) row("Arming", arm);
  }

  if (a) {
    section("Schedule");
    row("Starts", startPhrase(a));
    const sch = a.on.schedule;
    if (sch) {
      row("Cron", [`${sch.cron} (${scheduleWords(sch)})`, sch.timezone, sch.catchUp === "once" ? "catch-up once" : ""].filter(Boolean).join(" · "));
      if (s.state === "armed" && (f.nextRuns?.length ?? 0) > 0) {
        row("Scheduled for", (f.nextRuns ?? []).map((iso) => whenWords(iso, now, sch.timezone)).join(" · "));
      }
    }
    if (a.on.watch) {
      const paused = s.watchPausedAt ? t.fg("warning", ` · paused since ${momentWords(s.watchPausedAt, now)}`) : "";
      row("Watch", `${a.on.watch.script} every ${a.on.watch.every}${paused}`);
    }
    if (s.state === "armed" && f.watcher && !watcherTicking(f.watcher, now)) {
      row("Watcher", t.fg("warning", f.watcher.state === "off" ? "off: nothing starts on its own until it starts" : "late: nothing is on time until it ticks again"));
    }
  }

  if (a?.on.watch) {
    section("Last check");
    const w = s.watch;
    if (w) {
      const result = w.problem ? t.fg("warning", w.problem) : w.exit === 0 ? "found something (exit 0)" : w.exit === 3 ? "nothing to do (exit 3)" : `exit ${w.exit ?? "?"}`;
      row("Checked", `${both(w.checkedAt, now)} · ${result} · took ${spanWords(w.durationMs)}`);
      if (w.said) row("It said", `“${w.said}”`);
      row("Last started", w.firedAt ? both(w.firedAt, now) : "never");
    } else {
      row("Checked", "not yet");
    }
    if (s.running) row("Next check", "after the run that is going now");
    else if (s.watchPausedAt) row("Next check", "none while it is paused · p resumes it");
    else if (s.state !== "armed") row("Next check", `none while it is ${s.state}`);
    else if (s.nextCheck) row("Next check", Date.parse(s.nextCheck) <= now.getTime() ? "at the next tick" : both(s.nextCheck, now));
  }

  if (a || (f.records?.length ?? 0) > 0) {
    section("Runs");
    const records = f.records ?? [];
    if (s.running) {
      const r = s.running;
      row("Running", t.fg("accent", `for ${spanWords(now.getTime() - Date.parse(r.startedAt))}${r.timeoutMs > 0 ? ` of ${spanWords(r.timeoutMs)}` : ""} · started ${triggerWord(r.trigger)}`));
    }
    const last = records.at(-1);
    if (last) {
      const took = tookMs(last);
      row("Last run", [runMark(last.outcome, t), momentWords(last.startedAt ?? last.recordedAt, now), ...(took !== undefined ? [`took ${spanWords(took)}`] : []), `started ${triggerWord(last.trigger)}`].join(t.fg("muted", " · ")));
      const says = runSays(last).replace(/\s+/g, " ").trim();
      if (says) row(last.outcome === "ok" ? "Answer" : "Reason", says);
      row("Recent", `${records.map((r) => t.fg(RECENT_COLOR[r.outcome], RECENT_GLYPH[r.outcome])).join(" ")}  ${t.fg("muted", "oldest to newest · l shows them")}`);
      const usual = usualMs(records);
      if (usual) row("Usually", spanWords(usual));
    } else if (s.last) {
      row("Last run", `${runMark(s.last.outcome, t)} · ${momentWords(s.last.at, now)}`);
    } else {
      row("Last run", "never run");
    }
  }

  if (a) {
    section("Setup");
    row("Model", s.resolvedModel?.display ?? a.model ?? "the host's default model");
    row("Timeout", timeoutText(s, f.config));
    if (s.staggerSec) row("Stagger", `${s.staggerSec}s`);
    const hooks = [...hookText(a.hooks.pre, "pre"), ...hookText(a.hooks.post, "post")];
    row("Hooks", hooks.length ? hooks.join(" · ") : "none");
    if (s.flow) row("Flowchart", "tracked · f runs it and follows the chart");
    for (const [script, cmd] of Object.entries(f.interpreters ?? {})) row("Interpreter", `${script} → ${cmd}`);
  }

  section("Files");
  row("Directory", tildify(s.dir, f.home));
  row("File", tildify(path.join(s.dir, "AUTOMATION.md"), f.home));
  row("Scope", s.scope);
  row("Key", s.key);
  if (f.digest) row("Digest", f.digest);
  return out;
}
