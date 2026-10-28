// The Running page: a view over the run registry with one spinner timer. No pi import.
import { elapsedMs, isRunning } from "./run-view.js";
import { GLYPH } from "./glyphs.js";
import { bodyRows, pageRows, renderPage, windowBlock } from "./page.js";
import { runLead, runPageLines, runTitle, runTitleRight, stepWords } from "./running.js";
import { summaryLine } from "../summary.js";
import { ellipsize, truncateToWidth } from "./width.js";
import { spanWords, timeWords, triggerWord } from "./words.js";
import { PLAIN_THEME, sectionHeading, strong } from "./theme.js";
/** Keys the window understands, in both CSI and SS3 arrow encodings (terminals disagree). */
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
export function createStatusWindow(host) {
    const theme = host.theme ?? PLAIN_THEME;
    let selected = 0;
    let tick = 0;
    /** The registry id whose page is open, or `undefined` for the list of runs. */
    let detail;
    /** Which pane the run's page shows. */
    let pane = "steps";
    // First visible row of the run's page. Steps with their record, charts and sessions are all tall.
    let offset = 0;
    /** Follow the newest line as a session grows, until the reader scrolls away. */
    let followSession = true;
    let spin;
    let disposed = false;
    const rows = () => host.registry.all();
    function requestRender() {
        if (disposed)
            return;
        try {
            host.tui.requestRender();
        }
        catch {
            // The TUI belongs to a session that has gone; there is nothing left to draw on.
            disposed = true;
            stopSpinner();
        }
    }
    function stopSpinner() {
        if (!spin)
            return;
        clearInterval(spin);
        spin = undefined;
    }
    /** The spinner runs only while a step is active, so an idle terminal stays idle. */
    function syncSpinner() {
        if (disposed)
            return stopSpinner();
        const anyActive = rows().some((e) => e.view.steps.some((s) => s.state === "active"));
        if (anyActive && !spin) {
            spin = setInterval(() => {
                tick++;
                requestRender();
            }, host.spinnerMs ?? 80);
            // Never hold the process open for a spinner.
            spin.unref?.();
        }
        else if (!anyActive) {
            stopSpinner();
        }
    }
    const unsubscribe = host.registry.subscribe(() => {
        const n = rows().length;
        if (selected >= n)
            selected = Math.max(0, n - 1);
        // A run that ended while its page was open keeps it open — the record is the point.
        syncSpinner();
        requestRender();
    });
    syncSpinner();
    /** Resolved once at construction, so `esc` out of it is not undone by the next render. */
    const openFor = host.openGraphFor ?? host.openRunFor;
    /** Opened for one run: `esc` from its page goes back to where the person came from. */
    let direct = false;
    if (openFor) {
        const entry = rows().find((e) => e.view.key === openFor);
        if (entry) {
            selected = rows().indexOf(entry);
            detail = entry.id;
            pane = host.openGraphFor ? "graph" : "steps";
            direct = true;
        }
    }
    function move(delta) {
        const n = rows().length;
        if (n === 0)
            return;
        selected = Math.min(n - 1, Math.max(0, selected + delta));
        requestRender();
    }
    /** How many body rows the page has: the terminal's height less the title and the hint line. */
    const paneRows = () => bodyRows(pageRows(host.tui));
    /** The visible slice of a tall page, and where it is, for the hint line. */
    function windowOf(lines) {
        const room = paneRows();
        if (lines.length <= room) {
            offset = 0;
            return { body: lines };
        }
        const max = lines.length - room;
        offset = Math.min(max, Math.max(0, offset));
        const slice = lines.slice(offset, offset + room);
        return { body: slice, where: `rows ${offset + 1}-${offset + slice.length} of ${lines.length}` };
    }
    function scroll(delta) {
        offset = Math.max(0, offset + delta);
        // Scrolling unpins the session pane; reaching the bottom (End) pins it again.
        if (pane === "session")
            followSession = delta >= 1e9;
        requestRender();
    }
    // The keys live on this run's page: `g`, `s` and `x` depend on the run.
    function keysFor(view, where) {
        const out = [];
        if (isRunning(view))
            out.push({ text: "x stop it", rank: 1 });
        if (host.onEditAutomation)
            out.push({ text: "e edit", rank: 2 });
        if (view.flow)
            out.push({ text: "g flowchart", rank: 4 });
        if (view.session || isRunning(view))
            out.push({ text: "s session", rank: 5 });
        if (where)
            out.push({ text: `↑↓ scroll · ${where}`, rank: 3 });
        return out;
    }
    function page(title, body, hints, width, right) {
        return renderPage({ title, ...(right ? { right } : {}), body, hints, pinned: ["esc back"] }, width, pageRows(host.tui), theme);
    }
    /** The runs as cards, like Running now on the list, then the finished ones until dismissed. */
    function runCards(views, width, now, selected) {
        const lines = [];
        const spans = [];
        const pad = "      ";
        const room = Math.max(1, width - pad.length);
        const going = views.filter(isRunning);
        views.forEach((view, i) => {
            const running = isRunning(view);
            if (i === 0 || (!running && i === going.length)) {
                if (lines.length > 0)
                    lines.push("");
                lines.push(`  ${running ? sectionHeading(theme, "running", "Running now") : strong(theme, "Finished")}`);
            }
            else {
                lines.push("");
            }
            const from = lines.length;
            const cursor = i === selected ? strong(theme, GLYPH.cursor) : " ";
            const name = strong(theme, view.name);
            if (running) {
                const usual = host.usual?.(view.key);
                const step = view.steps.filter((s) => s.state === "active").at(-1);
                lines.push(ellipsize(`  ${cursor} ${theme.fg("accent", GLYPH.active)} ${name} is running · ${spanWords(elapsedMs(view, now))} in${usual ? `, usually takes ${spanWords(usual)}` : ""}`, width));
                const note = step?.note?.replace(/\s+/g, " ").trim();
                const why = step ? `now: ${stepWords(step.label)}${note ? ` · ${note}` : ""}` : `started ${triggerWord(view.trigger)} at ${timeWords(view.startedAt)}`;
                lines.push(`${pad}${ellipsize(why, room)}`);
                lines.push(`${pad}${strong(theme, "enter")}  show it`);
            }
            else {
                const rec = view.record;
                const lead = runLead(view, now);
                const glyph = view.phase === "crashed" || rec?.outcome === "failed" ? GLYPH.failed : rec?.outcome === "skipped" ? GLYPH.late : rec?.outcome === "aborted" ? GLYPH.aborted : GLYPH.ok;
                const rest = lead.text.startsWith(view.name) ? lead.text.slice(view.name.length).replace(/\.$/, "") : ` ${lead.text}`;
                lines.push(ellipsize(`  ${cursor} ${theme.fg(lead.color, glyph)} ${name}${rest}`, width));
                // A failure's reason is already in its first line; anything else says what it said.
                const said = rec ? (rec.outcome === "failed" ? undefined : summaryLine(rec, room)) : view.stderrTail.at(-1);
                if (said)
                    lines.push(`${pad}${ellipsize(said.replace(/\s+/g, " ").trim(), room)}`);
                lines.push(`${pad}${strong(theme, "d")}  dismiss it`);
            }
            spans.push([from, lines.length - 1]);
        });
        return { lines: lines.map((l) => truncateToWidth(l, width)), spans };
    }
    return {
        render(width) {
            const w = Math.max(20, width);
            const now = host.now();
            const entries = rows();
            const views = entries.map((e) => e.view);
            if (detail) {
                const entry = entries.find((e) => e.id === detail);
                if (!entry) {
                    // The run was dismissed from elsewhere while its page was open.
                    detail = undefined;
                    pane = "steps";
                }
                else if (pane === "graph") {
                    const flowPane = host.flowView?.(entry.view, w);
                    const body = flowPane
                        ? flowPane.lines
                        : [
                            theme.fg("muted", entry.view.flow
                                ? "its progress cannot be read right now"
                                : "this run is not tracked on a flowchart — add a ```mermaid flowchart to its AUTOMATION.md"),
                        ];
                    const shown = windowOf(body);
                    return page(`${strong(theme, entry.view.name)}${theme.fg("muted", ` · ${flowPane?.kind === "graph" ? "flowchart" : "steps"}`)}`, shown.body, shown.where ? [{ text: `↑↓ scroll · ${shown.where}`, rank: 1 }] : [], w);
                }
                else if (pane === "session") {
                    const lines = host.sessionView?.(entry.view, w);
                    // Three situations: no session yet, never a session, and a host with no viewer.
                    const body = lines && lines.length > 0
                        ? lines
                        : [
                            theme.fg("muted", entry.view.session
                                ? "the session is open but has not said anything yet"
                                : isRunning(entry.view)
                                    ? "waiting for the body to open its session"
                                    : "this run never opened a session"),
                        ];
                    // Following pins the view to the newest line; scrolling away unpins it.
                    if (followSession)
                        offset = Math.max(0, body.length - paneRows());
                    const shown = windowOf(body);
                    return page(`${strong(theme, entry.view.name)}${theme.fg("muted", " · session")}`, shown.body, shown.where ? [{ text: `↑↓ scroll · ${shown.where}`, rank: 1 }] : [], w);
                }
                else {
                    const usual = host.usual?.(entry.view.key);
                    const shown = windowOf(runPageLines(entry.view, w, now, theme, tick, usual));
                    return page(runTitle(entry.view, now, theme), shown.body, keysFor(entry.view, shown.where), w, runTitleRight(entry.view, now, usual, theme));
                }
            }
            const hint = host.nextHint?.();
            const { lines, spans } = runCards(views, w, now, selected);
            const running = views.filter(isRunning).length;
            const chosen = entries[selected]?.view;
            // Only keys the selected card does not print: its own key is on it, once.
            const hints = chosen
                ? [
                    { text: "↑↓ move", rank: 4 },
                    ...(isRunning(chosen) ? [{ text: "x stop it", rank: 1 }] : [{ text: "enter open", rank: 1 }]),
                    { text: "l runs", rank: 3 },
                ]
                : [];
            const span = spans[selected] ?? [0, 0];
            const body = views.length === 0
                ? [`  ${theme.fg("success", GLYPH.ok)} Nothing running.`, ...(hint ? ["", theme.fg("muted", `  ${hint}`)] : [])]
                : windowBlock(lines, span[0], span[1], paneRows(), theme);
            return page(strong(theme, "Running"), body, hints, w, theme.fg("muted", running > 0 ? `${running} running` : "nothing running"));
        },
        handleInput(data) {
            if (KEY.esc.includes(data) || (data === "q" && !detail)) {
                // One level at a time: the graph is inside the run's page, which is inside the list.
                if (pane !== "steps") {
                    pane = "steps";
                    offset = 0;
                    requestRender();
                    return;
                }
                if (detail && !direct) {
                    detail = undefined;
                    offset = 0;
                    requestRender();
                    return;
                }
                host.close();
                return;
            }
            // On a run's page the arrows scroll it; there is no row cursor there to move.
            if (detail) {
                if (KEY.up.includes(data))
                    return scroll(-1);
                if (KEY.down.includes(data))
                    return scroll(1);
                if (KEY.pageUp.includes(data))
                    return scroll(-paneRows());
                if (KEY.pageDown.includes(data))
                    return scroll(paneRows());
                if (KEY.home.includes(data))
                    return scroll(-1e9);
                if (KEY.end.includes(data))
                    return scroll(1e9);
            }
            if (KEY.up.includes(data))
                return move(-1);
            if (KEY.down.includes(data))
                return move(1);
            if (KEY.pageUp.includes(data))
                return move(-10);
            if (KEY.pageDown.includes(data))
                return move(10);
            if (KEY.home.includes(data))
                return move(-rows().length);
            if (KEY.end.includes(data))
                return move(rows().length);
            const entry = rows()[selected];
            if (KEY.enter.includes(data)) {
                if (!entry)
                    return;
                detail = detail ? undefined : entry.id;
                pane = "steps";
                offset = 0;
                requestRender();
                return;
            }
            if (data === "g") {
                // The chart belongs to one run, so it is only reachable from that run's page.
                if (!detail) {
                    if (!entry)
                        return;
                    detail = entry.id;
                }
                pane = pane === "graph" ? "steps" : "graph";
                offset = 0;
                requestRender();
                return;
            }
            if (data === "s") {
                // Same shape as `g`: the session belongs to one run.
                if (!detail) {
                    if (!entry)
                        return;
                    detail = entry.id;
                }
                pane = pane === "session" ? "steps" : "session";
                offset = 0;
                // Opening the pane means "show me what is happening", so start at the newest line.
                followSession = true;
                requestRender();
                return;
            }
            if (data === "x") {
                const target = detail ? rows().find((e) => e.id === detail)?.view : entry?.view;
                // Only a running run can be stopped; asking a finished one could reach the next run.
                if (target && isRunning(target))
                    host.onStop?.(target);
                return;
            }
            if (data === "e") {
                const target = detail ? rows().find((e) => e.id === detail)?.view : entry?.view;
                if (target)
                    host.onEditAutomation?.(target);
                return;
            }
            if (data === "d") {
                // Only a finished run can be dismissed; the registry refuses the rest.
                if (entry)
                    host.registry.dismiss(entry.id);
                return;
            }
            if (data === "l") {
                const target = detail ? rows().find((e) => e.id === detail)?.view : entry?.view;
                if (target)
                    host.onLog?.(target);
                return;
            }
            if (data === "R") {
                host.registry.refreshObserved(rows().map((e) => e.view.key));
                requestRender();
                return;
            }
        },
        invalidate() {
            // Every line is rebuilt from the registry on each render, so theme changes apply next frame.
            requestRender();
        },
        dispose() {
            disposed = true;
            unsubscribe();
            stopSpinner();
        },
    };
}
//# sourceMappingURL=window.js.map