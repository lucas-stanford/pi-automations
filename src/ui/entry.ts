// A finished run as a transcript entry. Pure.

import { outputLines, summaryLine } from "../summary.js";
import { GLYPH } from "./glyphs.js";
import { noteLines } from "./graph.js";
import { clock } from "./running.js";
import { localStamp } from "./words.js";
import { type LineTheme, PLAIN_THEME, type UiColor } from "./theme.js";
import type { RunView } from "./run-view.js";
import { truncateToWidth, wrapHard } from "./width.js";
import type { Outcome, RunRecord } from "../types.js";

/** What is stored on the entry: the record plus how the child exited and its stderr tail. */
export interface RunEntryData {
  record?: RunRecord;
  /** Present when the child closed without a record. */
  exitCode?: number;
  stderrTail?: string[];
  /** Name to show when there is no record to take one from. */
  name: string;
  /** The step list, rendered when the run ended. Plain text; the renderer applies its theme. */
  flowLines?: string[];
  /** Which run this receipt is for, also for a run that died without a record. */
  key?: string;
  runId?: string;
  /** Provider faults already known when the receipt is created. Hosts may add later log faults. */
  problems?: string[];
}

export const RUN_ENTRY_TYPE = "pi-automations/run";

export function entryDataFor(view: RunView, flowLines?: string[]): RunEntryData {
  return {
    name: view.name,
    ...(view.key ? { key: view.key } : {}),
    ...(view.runId ? { runId: view.runId } : {}),
    ...(view.record ? { record: view.record } : {}),
    ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}),
    ...(view.stderrTail.length > 0 ? { stderrTail: view.stderrTail } : {}),
    ...(flowLines && flowLines.length > 0 ? { flowLines } : {}),
    ...(view.problems && view.problems.length > 0 ? { problems: [...view.problems] } : {}),
  };
}

function outcomeColor(outcome: Outcome | undefined, crashed: boolean): UiColor {
  if (crashed) return "error";
  switch (outcome) {
    case "failed":
      return "error";
    case "aborted":
      return "warning";
    case "skipped":
    case "missed":
      return "dim";
    default:
      return "success";
  }
}

function outcomeGlyphFor(outcome: Outcome | undefined, crashed: boolean): string {
  if (crashed) return GLYPH.failed;
  switch (outcome) {
    case "failed":
      return GLYPH.failed;
    case "skipped":
    case "missed":
      return GLYPH.skipped;
    case "aborted":
      return "▃";
    default:
      return GLYPH.done;
  }
}

function durationOf(rec: RunRecord): string | undefined {
  if (!rec.startedAt || !rec.endedAt) return undefined;
  const d = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
  return Number.isNaN(d) ? undefined : clock(d);
}

/** The collapsed line: `▇ flow-example ok · 1:12 · 2 hooks`. */
export function collapsedEntryLine(data: RunEntryData, width: number, theme?: LineTheme): string {
  const t = theme ?? PLAIN_THEME;
  const rec = data.record;
  const crashed = rec === undefined;
  const colour = outcomeColor(rec?.outcome, crashed);
  const glyph = t.fg(colour, outcomeGlyphFor(rec?.outcome, crashed));
  const name = t.fg("text", rec?.name ?? data.name);

  if (!rec) {
    return truncateToWidth(
      `${glyph} ${name} ${t.fg("error", `exited ${data.exitCode ?? "?"} without a record`)}`,
      width,
    );
  }

  const bits: string[] = [rec.outcome];
  const dur = durationOf(rec);
  if (dur) bits.push(dur);
  const hooks = rec.hooks?.length ?? 0;
  if (hooks > 0) bits.push(`${hooks} hook${hooks === 1 ? "" : "s"}`);

  // End the collapsed line with what happened; `summaryLine` already falls back to the reason.
  const said = summaryLine(rec, Math.max(16, width - 40));
  if (said) bits.push(said);

  return truncateToWidth(`${glyph} ${name} ${t.fg(colour, bits.join(" · "))}`, width);
}

/** Everything the record knows. The session file is printed as a plain path, not a command. */
export function expandedEntryLines(
  data: RunEntryData,
  width: number,
  theme?: LineTheme,
): string[] {
  const t = theme ?? PLAIN_THEME;
  const out: string[] = [];
  const line = (s: string) => out.push(truncateToWidth(s, width));

  out.push(collapsedEntryLine(data, width, theme));

  const rec = data.record;
  if (rec) {
    const when = localStamp(rec.startedAt ?? rec.recordedAt);
    line(
      t.fg(
        "muted",
        `  ${rec.trigger}${rec.late ? ` ${GLYPH.late} late` : ""} · ${when}${rec.model ? ` · ${rec.model}` : ""}${rec.timeout ? ` · timeout ${rec.timeout}` : ""}`,
      ),
    );
    if (rec.scheduledFor) line(t.fg("muted", `  scheduled for ${rec.scheduledFor}`));
    if (rec.error) line(t.fg("error", `  ${rec.error.kind}: ${rec.error.message}`));

    for (const h of rec.hooks ?? []) {
      const colour: UiColor =
        h.status === "failed" ? "error" : h.status === "skipped" ? "dim" : "success";
      const exit = h.exit === undefined ? "" : ` exit ${h.exit}`;
      line(
        `  ${t.fg(colour, h.status.padEnd(8))}${h.phase}[${h.index}] ${h.source} · ${clock(h.durationMs)}${exit}${
          h.reason ? ` — ${h.reason}` : ""
        }`,
      );
    }

    // What the run produced comes before the plumbing.
    const produced = outputLines(rec, Math.max(8, width - 4), 8);
    if (produced.length > 0) {
      line("");
      for (const l of produced) line(t.fg("text", `  ${l}`));
      if (rec.output?.truncated) {
        line(t.fg("muted", "  … full output in the session"));
      }
      line("");
    }

    if (rec.session?.file) line(t.fg("muted", `  session ${rec.session.file}`));
    if (rec.flow?.problem) line(t.fg("warning", `  flow: ${rec.flow.problem}`));
    for (const p of rec.pluginProblems ?? []) line(t.fg("warning", `  ${p}`));
    // What the run published and where, clickable where the terminal supports it.
    for (const l of noteLines([...(rec.message ? [rec.message] : []), ...(rec.notes ?? [])], width, t)) out.push(l);
  }

  // Beside the outcome and attributed to the provider.
  for (const p of data.problems ?? []) line(t.fg("warning", `  provider: ${p}`));

  // The step list, exactly as it was rendered when the run ended.
  for (const l of data.flowLines ?? []) line(`  ${l}`);

  for (const l of data.stderrTail ?? []) {
    // Wrapped, not cut: the tail of a stack trace is what you need.
    for (const chunk of wrapHard(`  ${l}`, width)) out.push(t.fg("muted", chunk));
  }

  return out;
}

/** The part of pi-tui's `Component` an entry needs, declared here so `src/ui` stays free of pi. */
export interface EntryComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** Laid out for the drawn width (pi stops drawing on an overlong line); cached per width. */
export function runEntryComponent(
  data: RunEntryData,
  expanded: boolean,
  theme?: LineTheme,
): EntryComponent {
  let laidOut: { width: number; lines: string[] } | undefined;
  return {
    render(width: number): string[] {
      if (laidOut?.width !== width) {
        laidOut = {
          width,
          lines: expanded
            ? expandedEntryLines(data, width, theme)
            : [collapsedEntryLine(data, width, theme)],
        };
      }
      return laidOut.lines;
    },
    invalidate(): void {
      laidOut = undefined;
    },
  };
}
