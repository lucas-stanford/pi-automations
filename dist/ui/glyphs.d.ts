/** The glyph vocabulary; the only place these characters appear. */
import type { Outcome } from "../types.js";
export declare const GLYPH: {
    readonly armed: "●";
    readonly running: "◐";
    readonly off: "◌";
    readonly disabled: "○";
    readonly invalid: "✗";
    readonly late: "↷";
    /** Opens the reason line under a row. */
    readonly reason: "└";
    /** A run that ended ok. */
    readonly ok: "✓";
    /** A paused watch, or an automation the stopped watcher holds back. */
    readonly paused: "‖";
    /** The watcher, stopped. */
    readonly stopped: "■";
    /** A watch that could not check. */
    readonly problem: "!";
    /** A run that was missed. */
    readonly missed: "–";
    /** A run that was stopped part-way. */
    readonly aborted: "■";
    /** Something going right now: a running card, the step a run is on. */
    readonly active: "▶";
    /** A step that has not started yet, on a run's page. */
    readonly todo: "·";
    /** A link a run published. */
    readonly link: "↗";
    /** A step with more steps below it. */
    readonly branch: "├─";
    /** The last step of a run. */
    readonly corner: "└─";
    /** A step that has not started. */
    readonly pending: "○";
    /** A step that finished cleanly. Same mark as an `ok` run, on purpose. */
    readonly done: "▇";
    /** A step that was skipped, or never ran. */
    readonly skipped: "▁";
    /** A step that failed, and the mark for a run that died without a record. */
    readonly failed: "✗";
    /** Tracked on a flowchart. */
    readonly flow: "⋔";
    readonly boxTopLeft: "╭";
    readonly boxTopRight: "╮";
    readonly boxBottomLeft: "╰";
    readonly boxBottomRight: "╯";
    readonly boxHorizontal: "─";
    readonly boxVertical: "│";
    /** Marks the selected row in a list. */
    readonly cursor: "❯";
};
/** Braille spinner frames: one column wide everywhere, so the step tree stays aligned. */
export declare const SPINNER: readonly ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export declare function spinnerFrame(tick: number): string;
export declare function outcomeGlyph(outcome: Outcome): string;
