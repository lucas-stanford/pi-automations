// Lines for run pages, the footer and the strip. Pure.
import { buildStepListLines, linkLine, noteRows } from "./graph.js";
import { messageText } from "./message.js";
import { GLYPH, spinnerFrame } from "./glyphs.js";
import { outputLines, summaryLine } from "../summary.js";
import { activeStep, elapsedMs, isRunning, } from "./run-view.js";
import { ellipsize, fitTo, padTo, truncateToWidth, visibleWidth, wrapHard } from "./width.js";
import { agoLong, runningWords, spanLong, spanWords, timeWords, tookMs } from "./words.js";
import { PLAIN_THEME, strong } from "./theme.js";
/** `m:ss`, or `h:mm:ss` past an hour: a stable width for a counter that ticks every second. */
export function clock(msValue) {
    const total = Math.max(0, Math.floor(msValue / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
/** How many wrapped lines of the run's own output a run page shows. */
export const DETAIL_OUTPUT_LINES = 12;
/** `missed` and `aborted` are dim and `skipped` is muted: none of them is a fault. */
function outcomeColor(outcome) {
    switch (outcome) {
        case "ok":
            return "success";
        case "failed":
            return "error";
        case "skipped":
            return "muted";
        case "missed":
        case "aborted":
            return "dim";
    }
}
/** A step's name as a person says it. */
export function stepWords(label) {
    const hook = label.match(/^(pre|post)\[(\d+)\]\s+(.*)$/);
    if (hook)
        return `${hook[1]} hook${hook[2] === "0" ? "" : ` ${Number(hook[2]) + 1}`} · ${hook[3]}`;
    const body = label.match(/^body\s+(\S+)$/);
    if (body)
        return `body · ${body[1].replace(/^[^/]+\//, "")}`;
    return label;
}
/** `by hand`, `by its schedule`, `by its watch`. */
function startedBy(trigger) {
    if (trigger === "manual")
        return "by hand";
    if (trigger === "schedule")
        return "by its schedule";
    if (trigger === "watch")
        return "by its watch";
    return `by ${trigger}`;
}
/** `this session` or `background · pid 4812`: where the run is happening. */
export function sourceText(view) {
    if (view.source === "attached")
        return "this session";
    return view.pid ? `background · pid ${view.pid}` : "background";
}
function finishedColor(view) {
    if (view.phase === "crashed")
        return "error";
    switch (view.record?.outcome) {
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
/** The title of one run's page. */
export function runTitle(view, _now, theme) {
    const t = theme ?? PLAIN_THEME;
    const name = strong(t, view.name);
    const sep = t.fg("muted", " · ");
    if (isRunning(view))
        return `${name}${sep}${t.fg("accent", "running")}`;
    if (view.phase === "crashed")
        return `${name}${sep}${t.fg("error", "stopped without a record")}`;
    const rec = view.record;
    return `${name}${sep}${t.fg(finishedColor(view), rec ? rec.outcome : "finished")}`;
}
/**
 * `3m in · usually 7m` while it runs, `took 5m` once it has finished: dim, on the title's right.
 */
export function runTitleRight(view, now, usual, theme) {
    const t = theme ?? PLAIN_THEME;
    if (isRunning(view))
        return t.fg("muted", `${spanWords(elapsedMs(view, now))} in${usual ? ` · usually ${spanWords(usual)}` : ""}`);
    const rec = view.record;
    const took = rec ? tookMs(rec) : undefined;
    return took !== undefined ? t.fg("muted", `took ${spanWords(took)}`) : undefined;
}
/** The sentence a run's page opens with, in its colour. */
export function runLead(view, now, usual) {
    if (isRunning(view))
        return { text: `${view.name} is running: ${runningWords(elapsedMs(view, now), usual, view.timeoutMs)}`, color: "accent" };
    if (view.phase === "crashed")
        return { text: `${view.name} stopped without a record: its process exited ${view.exitCode ?? "?"}.`, color: "error" };
    const rec = view.record;
    if (!rec)
        return { text: `${view.name} has finished.`, color: "success" };
    const took = tookMs(rec);
    const after = took !== undefined ? ` after ${spanLong(took)}` : "";
    const why = (rec.error?.message ?? rec.reason)?.replace(/\s+/g, " ").trim();
    switch (rec.outcome) {
        case "ok":
            return { text: `${view.name} finished ${agoLong(rec.endedAt ?? rec.recordedAt, now)}${took !== undefined ? `; it took ${spanLong(took)}` : ""}.`, color: "success" };
        case "failed":
            return { text: `${view.name} failed${after}${why ? `: ${why}` : ""}.`, color: "error" };
        case "aborted":
            return { text: `${view.name} was stopped${after}.`, color: "warning" };
        case "skipped":
            return { text: `${view.name} skipped this run${why ? `: ${why}` : ""}.`, color: "muted" };
        case "missed":
            return { text: `${view.name} missed this run${why ? `: ${why}` : ""}.`, color: "muted" };
    }
}
// A step's mark: never a spinner.
const PAGE_STEP = {
    done: { glyph: GLYPH.ok, color: "success" },
    active: { glyph: GLYPH.active, color: "accent" },
    pending: { glyph: GLYPH.todo, color: "muted" },
    failed: { glyph: GLYPH.failed, color: "error" },
    skipped: { glyph: GLYPH.late, color: "dim" },
};
/** A run's steps as a tree: the hooks and body, with chart nodes nested under the body. */
export function runStepTree(view, width, theme, indent = "  ") {
    const t = theme ?? PLAIN_THEME;
    // An observed run rebuilt from its chart marks every node as the chart's, so match ids too.
    const isOwn = (s) => !s.extra || /^(pre|post)\d+$|^body$/.test(s.id);
    const own = view.steps.filter(isOwn);
    const extras = view.steps.filter((s) => !isOwn(s));
    const bodyAt = own.findIndex((s) => s.id === "body");
    const ordered = bodyAt === -1 || extras.length === 0
        ? view.steps.map((step) => ({ step, depth: 0 }))
        : [
            ...own.slice(0, bodyAt + 1).map((step) => ({ step, depth: 0 })),
            ...extras.map((step) => ({ step, depth: 1 })),
            ...own.slice(bodyAt + 1).map((step) => ({ step, depth: 0 })),
        ];
    if (ordered.length === 0) {
        const charted = view.record?.steps ?? [];
        if (charted.length > 0)
            return buildStepListLines(charted, width - indent.length, t).map((l) => truncateToWidth(`${indent}${l}`, width));
        return isRunning(view) ? [truncateToWidth(`${indent}${t.fg("muted", "no step detail yet")}`, width)] : [];
    }
    const labels = ordered.map(({ step, depth }) => `${"    ".repeat(depth)}${stepWords(step.label)}`);
    const noteCol = Math.min(Math.floor(width * 0.5), Math.max(...labels.map((l) => visibleWidth(l))) + 5);
    const out = [];
    ordered.forEach(({ step, depth }) => {
        const mark = PAGE_STEP[step.state];
        const pad = "    ".repeat(depth);
        const label = stepWords(step.label);
        const lead = `${indent}${pad}${t.fg(mark.color, mark.glyph)} ${step.state === "pending" ? t.fg("muted", label) : label}`;
        const note = step.note?.replace(/\s+/g, " ").trim();
        const at = visibleWidth(indent) + 2 + noteCol;
        const room = width - at;
        const line = note && room > 8 ? `${padTo(lead, at)}${t.fg("muted", ellipsize(note, room))}` : lead;
        out.push(truncateToWidth(line, width));
        if (step.reason)
            out.push(truncateToWidth(`${indent}${pad}  ${t.fg("muted", `${GLYPH.reason} ${step.reason}`)}`, width));
    });
    return out;
}
/** One run's page: progress, steps, its message and notes and output, then the technical details. */
export function runPageLines(view, width, now, theme, _tick = 0, usual) {
    const t = theme ?? PLAIN_THEME;
    const out = [];
    const textW = Math.max(10, width - 4);
    const running = isRunning(view);
    const lead = runLead(view, now, usual);
    for (const l of wrapText(lead.text, textW))
        out.push(`  ${t.fg(lead.color, l)}`);
    const started = `Started ${startedBy(view.trigger)} at ${timeWords(view.startedAt)}.`;
    for (const l of wrapText(started, textW))
        out.push(`  ${t.fg("muted", l)}`);
    out.push("");
    const steps = runStepTree(view, width, t);
    if (steps.length > 0)
        out.push(...steps);
    if (running && usual) {
        const done = Date.parse(view.startedAt) + usual;
        const late = now.getTime() > done ? " · this one is taking longer" : "";
        out.push(truncateToWidth(`  ${t.fg("muted", `usually done around ${timeWords(new Date(done).toISOString())}${late}`)}`, width));
    }
    if (steps.length > 0 || (running && usual))
        out.push("");
    const problems = problemLines(view, width, t);
    if (problems.length > 0)
        out.push(...problems, "");
    const message = view.record?.message ?? view.message;
    if (message) {
        out.push(`  ${strong(t, running ? "Message so far" : "Message")}`);
        const text = messageText(message.text);
        for (const l of (text ? wrapText(text, textW) : []).slice(0, 6))
            out.push(`    ${t.fg("text", l)}`);
        for (const l of message.links)
            out.push(linkLine(l, width, "    ", t));
        out.push("");
    }
    const notes = view.record?.notes ?? view.notes ?? [];
    if (notes.length > 0) {
        out.push(`  ${strong(t, running ? "Notes so far" : "Notes")}`);
        out.push(...noteRows(notes, width, "    "));
        out.push("");
    }
    if (running) {
        const long = "Nothing needed from you. It moves back to Coming up when it finishes.";
        const short = "Nothing needed from you. It goes back to Coming up when done.";
        out.push(`  ${t.fg("muted", ellipsize(long.length + 2 <= width ? long : short, Math.max(1, width - 2)))}`);
        return out;
    }
    const rec = view.record;
    if (rec) {
        out.push(`  ${strong(t, "Answer")}`);
        const body = outputLines(rec, width - 4, DETAIL_OUTPUT_LINES);
        if (body.length > 0) {
            for (const l of body)
                out.push(truncateToWidth(`    ${l}`, width));
            if (rec.output?.truncated)
                out.push(t.fg("muted", "    … full text in the session file"));
        }
        else {
            out.push(truncateToWidth(`    ${t.fg(outcomeColor(rec.outcome), summaryLine(rec, width - 4))}`, width));
        }
        out.push("");
    }
    out.push(t.fg("muted", strong(t, "Details")));
    out.push(truncateToWidth(t.fg("muted", `${sourceText(view)}${view.runId ? ` · run ${view.runId}` : ""}${view.pid && view.source === "attached" ? ` · pid ${view.pid}` : ""}`), width));
    if (view.scheduledFor)
        out.push(truncateToWidth(t.fg("muted", `scheduled for ${timeWords(view.scheduledFor)}`), width));
    const hooks = rec?.hooks ?? [];
    if (hooks.length > 0) {
        out.push("");
        out.push(t.fg("muted", `${fitTo("HOOK", 6)}${fitTo("SOURCE", 24)}${fitTo("STATUS", 9)}${fitTo("EXIT", 6)}${fitTo("TIME", 8)}REASON`));
        for (const h of hooks) {
            const colour = h.status === "failed" ? "error" : h.status === "skipped" ? "dim" : "success";
            out.push(truncateToWidth(`${fitTo(`${h.phase}${h.index ? ` ${h.index + 1}` : ""}`, 6)}${fitTo(h.source, 24)}${t.fg(colour, fitTo(h.status, 9))}${fitTo(h.exit === undefined ? "" : String(h.exit), 6)}${fitTo(clock(h.durationMs), 8)}${h.reason ?? ""}`, width));
        }
    }
    if (rec?.session?.file) {
        out.push("");
        out.push(truncateToWidth(`${t.fg("muted", "session ")}${rec.session.file}`, width));
    }
    if (view.phase === "crashed" && view.stderrTail.length > 0) {
        out.push("");
        out.push(t.fg("muted", "stderr"));
        for (const l of view.stderrTail)
            out.push(...wrapHard(`  ${l}`, width).map((c) => t.fg("muted", c)));
    }
    if (rec) {
        out.push("");
        out.push(t.fg("muted", "record"));
        // Wrapped, never truncated: a cut JSON object still looks like JSON and is not.
        for (const l of JSON.stringify(rec, null, 2).split("\n"))
            out.push(...wrapHard(l, width));
    }
    return out;
}
/** Words to lines of at most `width`, at spaces. */
function wrapText(text, width) {
    const out = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
        if (line === "")
            line = word;
        else if (visibleWidth(line) + 1 + visibleWidth(word) <= width)
            line += ` ${word}`;
        else {
            out.push(line);
            line = word;
        }
    }
    if (line)
        out.push(line);
    return out.map((l) => ellipsize(l, width));
}
/** Provider problems, beside the outcome and attributed to the provider. */
export function problemLines(view, width, t) {
    const problems = view.problems ?? [];
    if (problems.length === 0)
        return [];
    // Bounded, so a repeatedly failing provider cannot push the run's steps off screen.
    const shown = problems.slice(0, PROBLEMS_SHOWN);
    const lines = shown.map((p) => truncateToWidth(`  ${t.fg("muted", `${GLYPH.reason} provider: ${p}`)}`, width));
    const hidden = problems.length - shown.length;
    if (hidden > 0) {
        lines.push(truncateToWidth(`  ${t.fg("muted", `${GLYPH.reason} and ${hidden} more`)}`, width));
    }
    return lines;
}
/** Enough to show a real fault and its cause, few enough not to bury the run. */
export const PROBLEMS_SHOWN = 3;
/** The plain-text answer for non-terminal modes: one line per running automation. */
export function renderRunningLines(views, now) {
    const running = views.filter(isRunning);
    if (running.length === 0)
        return ["nothing running"];
    return running.map((v) => {
        const step = activeStep(v);
        const where = sourceText(v);
        const detail = step ? ` · ${step.label}` : v.steps.length === 0 ? " · no step detail yet" : "";
        return `${GLYPH.running} ${v.name} · ${v.trigger} · ${clock(elapsedMs(v, now))}${detail} · ${where}`;
    });
}
/** The footer while runs are in flight, or undefined. */
export function runningFooter(views, now) {
    const running = views.filter(isRunning);
    if (running.length === 0)
        return undefined;
    if (running.length === 1) {
        const v = running[0];
        return `${GLYPH.running} ${v.name} running ${clock(elapsedMs(v, now))}`;
    }
    const parts = running.map((v) => `${v.name} ${clock(elapsedMs(v, now))}`);
    return `${GLYPH.running} ${running.length} running · ${parts.join(" · ")}`;
}
/** One compact line per running run, for the strip above the editor. */
export function widgetLines(views, now, tick) {
    return views.filter(isRunning).map((v) => {
        const step = activeStep(v);
        const mark = step ? spinnerFrame(tick) : GLYPH.running;
        const label = step ? ` · ${step.label}` : "";
        return `${mark} ${v.name}${label} · ${clock(elapsedMs(v, now))}`;
    });
}
//# sourceMappingURL=running.js.map