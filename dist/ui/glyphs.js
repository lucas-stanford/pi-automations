/** The glyph vocabulary; the only place these characters appear. */
export const GLYPH = {
    armed: "●",
    running: "◐",
    off: "◌",
    disabled: "○",
    invalid: "✗",
    late: "↷",
    /** Opens the reason line under a row. */
    reason: "└",
    // --- triage list ---------------------------------------------------------------------------
    /** A run that ended ok. */
    ok: "✓",
    /** A paused watch, or an automation the stopped watcher holds back. */
    paused: "‖",
    /** The watcher, stopped. */
    stopped: "■",
    /** A watch that could not check. */
    problem: "!",
    /** A run that was missed. */
    missed: "–",
    /** A run that was stopped part-way. */
    aborted: "■",
    /** Something going right now: a running card, the step a run is on. */
    active: "▶",
    /** A step that has not started yet, on a run's page. */
    todo: "·",
    /** A link a run published. */
    link: "↗",
    // --- step tree, for run pages ---------------------------------------------------------------
    /** A step with more steps below it. */
    branch: "├─",
    /** The last step of a run. */
    corner: "└─",
    /** A step that has not started. */
    pending: "○",
    /** A step that finished cleanly. Same mark as an `ok` run, on purpose. */
    done: "▇",
    /** A step that was skipped, or never ran. */
    skipped: "▁",
    /** A step that failed, and the mark for a run that died without a record. */
    failed: "✗",
    /** Tracked on a flowchart. */
    flow: "⋔",
    // --- frame ---------------------------------------------------------------------------------
    boxTopLeft: "╭",
    boxTopRight: "╮",
    boxBottomLeft: "╰",
    boxBottomRight: "╯",
    boxHorizontal: "─",
    boxVertical: "│",
    /** Marks the selected row in a list. */
    cursor: "❯",
};
/** Braille spinner frames: one column wide everywhere, so the step tree stays aligned. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spinnerFrame(tick) {
    return SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length];
}
export function outcomeGlyph(outcome) {
    switch (outcome) {
        case "ok":
            return "▇";
        case "skipped":
            return "▁";
        case "missed":
            return "▁";
        case "aborted":
            return "▃";
        case "failed":
            return "✗";
    }
}
//# sourceMappingURL=glyphs.js.map