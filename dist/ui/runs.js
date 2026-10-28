// The runs page: last runs newest first, the selected one opened in place.
import { runSays } from "./details.js";
import { GLYPH } from "./glyphs.js";
import { linkLine, noteRows } from "./graph.js";
import { messageText } from "./message.js";
import { bodyRows, pageRows, renderPage, windowBlock } from "./page.js";
import { PLAIN_THEME, strong } from "./theme.js";
import { ellipsize, padLeft, padTo, truncateToWidth, visibleWidth } from "./width.js";
import { momentWords, spanWords, tookMs } from "./words.js";
const KEY = {
    up: ["\u001b[A", "\u001bOA"],
    down: ["\u001b[B", "\u001bOB"],
    pageUp: ["\u001b[5~"],
    pageDown: ["\u001b[6~"],
    home: ["\u001b[H", "\u001b[1~"],
    end: ["\u001b[F", "\u001b[4~"],
    esc: ["\u001b"],
};
/** Only the glyph carries colour, and only where it means something: ✓ green, ✗ red. */
const OUTCOME_COLOR = {
    ok: "success",
    failed: "error",
    skipped: "muted",
    missed: "muted",
    aborted: "warning",
};
const GLYPH_OF = {
    ok: GLYPH.ok,
    failed: GLYPH.failed,
    skipped: GLYPH.late,
    missed: GLYPH.missed,
    aborted: GLYPH.aborted,
};
function took(rec) {
    const ms = tookMs(rec);
    return ms === undefined || rec.outcome === "skipped" || rec.outcome === "missed" ? "" : spanWords(ms);
}
function when(rec) {
    return rec.startedAt ?? rec.recordedAt;
}
/** What a run said, on one line: its summary, its error, or `skipped: weekend`. */
function says(rec) {
    const reason = rec.reason?.replace(/\s+/g, " ").trim();
    if (rec.outcome === "skipped")
        return reason ? `skipped: ${reason}` : "skipped";
    if (rec.outcome === "aborted")
        return reason ? `aborted: ${reason}` : "aborted";
    // A run that said nothing gets no words: an empty cell reads quieter than "no output".
    if (rec.outcome === "ok" && !rec.output?.text?.trim())
        return "";
    return runSays(rec).replace(/\s+/g, " ").trim();
}
/** Words to lines of at most `width`, at spaces; a word wider than the line is cut. */
function wrap(text, width) {
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
function runBlocks(runs, width, now, t, selected) {
    const newest = runs.slice().reverse();
    const atW = Math.max(5, ...newest.map((r) => visibleWidth(momentWords(when(r.record), now)))) + 1;
    const tookW = Math.max(2, ...newest.map((r) => visibleWidth(took(r.record))));
    return newest.map((r, i) => {
        const rec = r.record;
        const on = i === selected;
        const cursor = on ? strong(t, GLYPH.cursor) : " ";
        const mark = t.fg(OUTCOME_COLOR[rec.outcome], GLYPH_OF[rec.outcome]);
        const at = padTo(momentWords(when(rec), now), atW);
        const lead = `  ${cursor} ${mark} ${on ? strong(t, at) : at}${padLeft(took(rec), tookW)}   `;
        const col = visibleWidth(lead);
        const room = Math.max(8, width - col);
        // A run's own message leads; what it answered follows, dim, once it is opened.
        const message = rec.message ? messageText(rec.message.text) : "";
        const reply = says(rec);
        const text = message || reply;
        const quiet = rec.outcome === "skipped" || rec.outcome === "missed";
        const paint = (s) => (quiet ? t.fg("muted", s) : s);
        if (!on)
            return { lines: [truncateToWidth(text ? `${lead}${paint(ellipsize(text, room))}` : lead.trimEnd(), width)] };
        const pad = " ".repeat(col);
        const said = wrap(text, room);
        const lines = [truncateToWidth(said[0] ? `${lead}${paint(said[0])}` : lead.trimEnd(), width)];
        for (const l of said.slice(1, 6))
            lines.push(truncateToWidth(`${pad}${paint(l)}`, width));
        if (said.length > 6)
            lines.push(`${pad}${t.fg("muted", "…")}`);
        for (const l of rec.message?.links ?? [])
            lines.push(linkLine(l, width, pad, t));
        if (message && reply) {
            const answered = wrap(reply, room);
            for (const l of answered.slice(0, 3))
                lines.push(truncateToWidth(`${pad}${t.fg("muted", l)}`, width));
            if (answered.length > 3)
                lines.push(`${pad}${t.fg("muted", "…")}`);
        }
        for (const l of noteRows(rec.notes ?? [], width - col))
            lines.push(truncateToWidth(`${pad}${l}`, width));
        const problems = [...(r.problems ?? []), ...(rec.pluginProblems ?? [])];
        for (const p of problems.slice(0, 3))
            lines.push(truncateToWidth(`${pad}${t.fg("muted", ellipsize(`provider: ${p}`, room))}`, width));
        return { lines };
    });
}
export function createRunsPage(host) {
    const theme = host.theme ?? PLAIN_THEME;
    let selected = 0;
    let disposed = false;
    function requestRender() {
        if (disposed)
            return;
        try {
            host.tui.requestRender();
        }
        catch {
            disposed = true;
        }
    }
    function move(delta) {
        const n = host.runs.length;
        if (n === 0)
            return;
        const next = Math.min(n - 1, Math.max(0, selected + delta));
        if (next === selected)
            return;
        selected = next;
        requestRender();
    }
    return {
        render(width) {
            const w = Math.max(1, width);
            const now = host.now?.() ?? new Date();
            const rows = pageRows(host.tui);
            const title = `${strong(theme, host.name)}${theme.fg("muted", " · runs")}`;
            if (host.runs.length === 0) {
                return renderPage({ title, body: [theme.fg("muted", `  ${host.name} has not run yet`)], hints: [], pinned: ["esc back"] }, w, rows, theme);
            }
            const blocks = runBlocks(host.runs, w, now, theme, selected);
            const lines = blocks.flatMap((b) => b.lines);
            const from = blocks.slice(0, selected).reduce((n, b) => n + b.lines.length, 0);
            const to = from + (blocks[selected]?.lines.length ?? 1) - 1;
            const room = rows === undefined ? lines.length : bodyRows(rows);
            return renderPage({ title, body: windowBlock(lines, from, to, room, theme), hints: [{ text: "↑↓ choose a run", rank: 1 }], pinned: ["esc back"] }, w, rows, theme);
        },
        handleInput(data) {
            if (KEY.esc.includes(data) || data === "q")
                return host.close();
            if (KEY.up.includes(data))
                return move(-1);
            if (KEY.down.includes(data))
                return move(1);
            if (KEY.pageUp.includes(data))
                return move(-10);
            if (KEY.pageDown.includes(data))
                return move(10);
            if (KEY.home.includes(data))
                return move(-host.runs.length);
            if (KEY.end.includes(data))
                return move(host.runs.length);
        },
        invalidate() {
            requestRender();
        },
        dispose() {
            disposed = true;
        },
    };
}
//# sourceMappingURL=runs.js.map