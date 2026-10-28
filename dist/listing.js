// The plain-text listing, grouped by scope. The fallback for every richer surface.
import path from "node:path";
import { clockIn, describeNext } from "./cron.js";
import { formatDuration } from "./duration.js";
import { tildify } from "./paths.js";
import { GLYPH } from "./ui/glyphs.js";
/** armed first, then off, disabled and invalid; alphabetical within each. */
const STATE_ORDER = {
    armed: 0,
    off: 1,
    disabled: 2,
    invalid: 3,
};
function sortRows(a, b) {
    const d = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    return d !== 0 ? d : a.name.localeCompare(b.name);
}
function hooksText(s) {
    const pre = s.automation?.hooks.pre.length ?? 0;
    const post = s.automation?.hooks.post.length ?? 0;
    const parts = [];
    if (pre)
        parts.push(`pre ${pre}`);
    if (post)
        parts.push(`post ${post}`);
    return parts.length ? parts.join(" · ") : "—";
}
/** The SCHEDULE column: the cron, the watch interval, or both. Exported for the report. */
export function scheduleText(s) {
    const on = s.automation?.on;
    const parts = [];
    if (on?.schedule)
        parts.push(on.schedule.cron);
    if (on?.watch)
        parts.push(`watch ${on.watch.every}`);
    return parts.length ? parts.join(" + ") : "—";
}
function nextText(s, now, locale) {
    if (s.running) {
        const started = new Date(s.running.startedAt);
        const elapsed = formatDuration(Math.max(0, now.getTime() - started.getTime()));
        return `${GLYPH.running} running ${elapsed}`;
    }
    if (s.state !== "armed")
        return "—";
    const schedule = s.automation?.on.schedule;
    if (schedule)
        return describeNextClock(schedule, now, s.staggerSec, locale);
    // A watch says when it will next LOOK, which is not a run: hence the word.
    if (s.nextCheck)
        return `check ${checkClock(s.nextCheck, now, locale)}`;
    return "—";
}
/** `12:10`, or `now` for a check that is due at the next tick. */
function checkClock(iso, now, locale) {
    const at = new Date(iso);
    if (at.getTime() <= now.getTime())
        return "now";
    return clockIn(at, undefined, locale);
}
/** `07:00 +0:47` — the clock and the offset, without the relative suffix the overlay shows. */
function describeNextClock(schedule, now, staggerSec, locale) {
    const full = describeNext(schedule, now, staggerSec, locale);
    if (full === "—")
        return full;
    // describeNext appends a relative phrase ("tomorrow", "in 41m"); the table has no room for it.
    const parts = full.split(" ");
    return staggerSec > 0 ? parts.slice(0, 2).join(" ") : parts[0];
}
function toRow(s, now, locale) {
    const row = {
        status: s,
        name: s.name,
        state: s.state,
        schedule: scheduleText(s),
        next: nextText(s, now, locale),
        hooks: hooksText(s),
    };
    if (s.flow)
        row.flow = true;
    // Only invalid and off get a reason line; those are the ones a person must act on.
    if ((s.state === "invalid" || s.state === "off") && s.reason)
        row.reason = s.reason;
    return row;
}
const INDENT = "  ";
const GAP = 2;
const MIN = { name: 16, state: 8, schedule: 18, next: 13, hooks: 5, sparkline: 7 };
/** The listing before rendering; `decorate` adds a sparkline without filesystem access here. */
export function listingModel(statuses, opts) {
    const width = opts.width ?? 100;
    const locale = opts.locale ?? "en";
    const userStatuses = statuses.filter((s) => s.scope === "user");
    const projectStatuses = statuses.filter((s) => s.scope === "repository");
    const roots = uniquePaths(userStatuses.map((s) => s.root.path));
    const rowsFor = (list) => {
        const rows = list
            .slice()
            .sort(sortRows)
            .map((s) => toRow(s, opts.now, locale));
        if (opts.decorate)
            for (const r of rows)
                opts.decorate(r);
        return rows;
    };
    const groups = [];
    if (roots.length === 0) {
        groups.push({
            kind: "user",
            title: `USER · ${tildify(path.join(opts.home, ".agents", "automations"), opts.home)}`,
            path: path.join(opts.home, ".agents", "automations"),
            rows: [],
            empty: "none",
        });
    }
    else {
        for (const root of roots) {
            groups.push({
                kind: "user",
                title: `USER · ${tildify(root, opts.home)}`,
                path: root,
                rows: rowsFor(userStatuses.filter((s) => s.root.path === root)),
            });
        }
    }
    // Outside a repository there is no REPOSITORY section at all.
    for (const repoRoot of opts.projectRoots) {
        const mine = projectStatuses.filter((s) => isUnder(s.root.path, repoRoot));
        const projectRootPaths = uniquePaths(mine.map((s) => s.root.path));
        if (projectRootPaths.length === 0) {
            groups.push({
                kind: "project",
                title: `REPOSITORY · ${tildify(path.join(repoRoot, ".agents", "automations"), opts.home)}`,
                path: path.join(repoRoot, ".agents", "automations"),
                rows: [],
                empty: "none — add .agents/automations/<name>/AUTOMATION.md",
            });
            continue;
        }
        for (const root of projectRootPaths) {
            groups.push({
                kind: "project",
                title: `REPOSITORY · ${tildify(root, opts.home)}`,
                path: root,
                rows: rowsFor(mine.filter((s) => s.root.path === root)),
            });
        }
    }
    // Column widths come from every row on screen, so the columns line up across groups.
    const cols = measure(groups.flatMap((g) => g.rows), width);
    return { groups, cols, separator: opts.projectRoots.length > 0 };
}
export function renderListing(statuses, opts) {
    const width = opts.width ?? 100;
    const model = listingModel(statuses, opts);
    const { cols } = model;
    const out = [];
    out.push(INDENT + header(cols));
    let separatorPending = model.separator;
    for (const group of model.groups) {
        if (separatorPending && group.kind === "project") {
            out.push(INDENT + "─".repeat(Math.max(10, Math.min(width - INDENT.length, tableWidth(cols)))));
            separatorPending = false;
        }
        out.push(INDENT + group.title);
        if (group.rows.length === 0) {
            if (group.empty)
                out.push(INDENT + group.empty);
            continue;
        }
        for (const row of group.rows)
            pushRow(out, row, cols);
    }
    return out;
}
/**
 * Decide the columns. Names are never cut: HOOKS, the sparkline, then SCHEDULE are dropped first.
 */
export function measure(rows, width) {
    const w = (get, min) => Math.max(min, ...rows.map((r) => get(r).length), 0);
    const anyFlow = rows.some((r) => r.flow === true);
    // The marker rides in the NAME column.
    const flowPad = anyFlow ? 2 : 0;
    const name = w((r) => r.name, MIN.name) + flowPad;
    const state = w((r) => r.state, MIN.state);
    const schedule = w((r) => r.schedule, MIN.schedule);
    const next = w((r) => r.next, MIN.next);
    const hooks = w((r) => r.hooks, MIN.hooks);
    const anySparkline = rows.some((r) => (r.sparkline ?? "") !== "");
    const sparkline = anySparkline ? w((r) => r.sparkline ?? "", MIN.sparkline) : 0;
    const avail = width - INDENT.length;
    const base = name + state + schedule + next + GAP * 3;
    const withSpark = anySparkline ? sparkline + GAP : 0;
    const cols = (over) => ({
        name,
        state,
        schedule,
        next,
        sparkline,
        showSchedule: true,
        showHooks: false,
        showSparkline: anySparkline,
        showFlow: anyFlow,
        ...over,
    });
    if (base + withSpark + hooks + GAP <= avail)
        return cols({ showHooks: true });
    if (base + withSpark <= avail)
        return cols({});
    if (base <= avail)
        return cols({ showSparkline: false });
    return cols({ showSparkline: false, showSchedule: false });
}
export function tableWidth(cols) {
    let n = cols.name + cols.state + GAP;
    if (cols.showSchedule)
        n += cols.schedule + GAP;
    n += cols.next + GAP;
    if (cols.showSparkline)
        n += cols.sparkline + GAP;
    return n;
}
export function header(cols) {
    // The flow marker's two columns sit under the NAME header, indented to match the rows.
    const nameHeader = cols.showFlow ? "  NAME" : "NAME";
    const cells = [pad(nameHeader, cols.name), pad("STATE", cols.state)];
    if (cols.showSchedule)
        cells.push(pad("SCHEDULE", cols.schedule));
    cells.push(pad("NEXT", cols.next));
    if (cols.showSparkline)
        cells.push(pad("RUNS", cols.sparkline));
    if (cols.showHooks)
        cells.push("HOOKS");
    return cells.join(" ".repeat(GAP)).trimEnd();
}
/** The cells of one row, already padded. A surface that colours them joins them itself. */
export function rowCells(row, cols) {
    // The marker sits inside the NAME cell, so the names still line up under one header.
    const name = cols.showFlow ? `${row.flow ? GLYPH.flow : " "} ${row.name}` : row.name;
    const cells = [pad(name, cols.name), pad(row.state, cols.state)];
    if (cols.showSchedule)
        cells.push(pad(row.schedule, cols.schedule));
    cells.push(pad(row.next, cols.next));
    if (cols.showSparkline)
        cells.push(pad(row.sparkline ?? "", cols.sparkline));
    if (cols.showHooks)
        cells.push(row.hooks);
    return cells;
}
function pushRow(out, row, cols) {
    out.push(INDENT + rowCells(row, cols).join(" ".repeat(GAP)).trimEnd());
    if (row.reason)
        out.push(`${INDENT}  ${GLYPH.reason} ${row.reason}`);
}
function pad(s, n) {
    return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function uniquePaths(list) {
    const seen = new Set();
    const out = [];
    for (const p of list) {
        if (seen.has(p))
            continue;
        seen.add(p);
        out.push(p);
    }
    return out.sort();
}
function isUnder(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
/** The one-line summary for `ctx.ui.setStatus`. */
export function statusLine(statuses, now, locale = "en") {
    const armed = statuses.filter((s) => s.state === "armed");
    const off = statuses.filter((s) => s.state === "off").length;
    const invalid = statuses.filter((s) => s.state === "invalid").length;
    const running = statuses.find((s) => s.running);
    if (running) {
        const elapsed = formatDuration(Math.max(0, now.getTime() - Date.parse(running.running?.startedAt ?? "")));
        return `${GLYPH.running} ${running.name} running ${elapsed}`;
    }
    const parts = [`automations · ${armed.length} armed`];
    const upcoming = armed
        .filter((s) => s.nextFire)
        .sort((a, b) => Date.parse(a.nextFire) - Date.parse(b.nextFire))[0];
    if (upcoming?.automation?.on.schedule) {
        const clock = describeNextClock(upcoming.automation.on.schedule, now, upcoming.staggerSec, locale).split(" ")[0];
        parts.push(`next ${clock} ${upcoming.name}`);
    }
    const trailing = [];
    if (off)
        trailing.push(`${off} off`);
    if (invalid)
        trailing.push(`${invalid} invalid`);
    const head = parts.join(" · ");
    return trailing.length ? `${head} · ${trailing.join(" · ")} — /automations` : head;
}
//# sourceMappingURL=listing.js.map