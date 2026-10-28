// A run in flight, from its event stream or its lock and fire log. Pure. Step ids are flow node
// ids.
import { hookLabel, hookLabelFor, nodeIdFor } from "../nodes.js";
import { stripControls } from "./width.js";
export const STDERR_TAIL_MAX = 50;
export function nameFromKey(key) {
    const i = key.lastIndexOf(":");
    return i === -1 ? key : key.slice(i + 1);
}
/** The full plan, every step pending, so the window shows it from frame one. */
export function planFor(located) {
    const a = located.automation;
    const steps = [];
    a.hooks.pre.forEach((h, i) => {
        steps.push({ id: nodeIdFor("pre", i), label: hookLabel(h, "pre", i), state: "pending" });
    });
    steps.push({ id: nodeIdFor("body"), label: "body", state: "pending" });
    a.hooks.post.forEach((h, i) => {
        steps.push({ id: nodeIdFor("post", i), label: hookLabel(h, "post", i), state: "pending" });
    });
    return steps;
}
export function startingView(args) {
    return {
        key: args.located.key,
        name: args.located.automation.name,
        trigger: args.trigger,
        source: args.source ?? "attached",
        ...(args.pid !== undefined ? { pid: args.pid } : {}),
        startedAt: args.startedAt,
        timeoutMs: args.timeoutMs,
        steps: planFor(args.located),
        phase: "starting",
        stderrTail: [],
    };
}
export function observedView(lock) {
    return {
        key: lock.key,
        name: nameFromKey(lock.key),
        trigger: lock.trigger,
        source: "observed",
        pid: lock.pid,
        runId: lock.runId,
        startedAt: lock.startedAt,
        timeoutMs: lock.timeoutMs,
        ...(lock.scheduledFor ? { scheduledFor: lock.scheduledFor } : {}),
        // A run fired while pi was closed is found through its lock.
        ...(lock.session ? { session: lock.session } : {}),
        steps: [],
        phase: "running",
        stderrTail: [],
    };
}
export function mergeObservedReplay(base, replayed) {
    if (replayed && isRunning(replayed))
        return replayed;
    const problems = replayed?.problems ?? [];
    return problems.length > 0 ? { ...base, problems } : base;
}
function stateFor(status) {
    if (status === "ok")
        return "done";
    if (status === "skipped")
        return "skipped";
    return "failed";
}
function replace(steps, id, patch, label) {
    const i = steps.findIndex((s) => s.id === id);
    if (i === -1) {
        return [...steps, { id, label: label ?? id, state: "pending", ...patch }];
    }
    const existing = steps[i];
    const next = { ...existing, ...patch, ...(label ? { label } : {}) };
    const out = steps.slice();
    out[i] = next;
    return out;
}
// Settle steps against the record: no event means "did not run", not "pending".
function settle(view, record) {
    const results = record.hooks ?? [];
    return view.steps.map((step) => {
        if (step.id === "body") {
            if (step.state === "done" || step.state === "failed")
                return step;
            if (step.state === "active") {
                return {
                    ...step,
                    state: "failed",
                    ...(record.error?.message ? { reason: record.error.message } : {}),
                };
            }
            return { ...step, state: "skipped", reason: step.reason ?? "did not run" };
        }
        const m = /^(pre|post)(\d+)$/.exec(step.id);
        if (!m)
            return step;
        const phase = m[1];
        const index = Number(m[2]);
        const r = results.find((h) => h.phase === phase && h.index === index);
        if (r) {
            return {
                ...step,
                state: stateFor(r.status),
                durationMs: r.durationMs,
                ...(r.reason ? { reason: r.reason } : {}),
            };
        }
        if (step.state === "done" || step.state === "failed" || step.state === "skipped")
            return step;
        return { ...step, state: "skipped", reason: "did not run" };
    });
}
/** Fold one event into the view. Pure. Events for a different `runId` are ignored. */
export function applyFireEvent(view, event) {
    switch (event.event) {
        case "start": {
            if (view.runId && view.runId !== event.runId)
                return view;
            return {
                ...view,
                runId: event.runId,
                key: event.key,
                name: view.name || nameFromKey(event.key),
                trigger: event.trigger,
                late: event.late,
                ...(event.scheduledFor ? { scheduledFor: event.scheduledFor } : {}),
                phase: "running",
            };
        }
        case "flow": {
            return {
                ...view,
                flow: { run: event.run },
            };
        }
        case "session": {
            return {
                ...view,
                session: {
                    file: event.file,
                    id: event.id,
                    ...(event.format ? { format: event.format } : {}),
                },
            };
        }
        case "hook-start": {
            const id = nodeIdFor(event.phase, event.index);
            return {
                ...view,
                phase: view.phase === "starting" ? "running" : view.phase,
                steps: replace(view.steps, id, { state: "active" }, hookLabelFor(event.phase, event.index, event.source)),
            };
        }
        case "hook-end": {
            const r = event.result;
            const id = nodeIdFor(r.phase, r.index);
            return {
                ...view,
                steps: replace(view.steps, id, {
                    state: stateFor(r.status),
                    durationMs: r.durationMs,
                    ...(r.reason ? { reason: r.reason } : {}),
                }),
            };
        }
        case "body-start": {
            return {
                ...view,
                phase: view.phase === "starting" ? "running" : view.phase,
                steps: replace(view.steps, nodeIdFor("body"), { state: "active" }, `body  ${event.model}`),
            };
        }
        case "body-end": {
            return { ...view, steps: replace(view.steps, nodeIdFor("body"), { state: "done" }) };
        }
        case "record": {
            const rec = event.record;
            const withRecord = {
                ...view,
                record: rec,
                phase: "finished",
                // A finished run's progress comes from its record.
                ...(rec.steps ? { flow: { run: rec.id } } : {}),
                ...(rec.notes && rec.notes.length > 0 ? { notes: rec.notes } : {}),
                ...(rec.message ? { message: rec.message } : {}),
            };
            return { ...withRecord, steps: settle(withRecord, rec) };
        }
        case "problem": {
            // Kept, not a step; it may follow `record`, and duplicates collapse.
            if (event.runId && view.runId && event.runId !== view.runId)
                return view;
            const seen = view.problems ?? [];
            if (seen.includes(event.message))
                return view;
            return { ...view, problems: [...seen, event.message] };
        }
    }
}
/** The child closed without a `record`; the stderr tail is the only evidence. */
export function markCrashed(view, exitCode, stderrTail) {
    if (view.phase === "finished")
        return view;
    return {
        ...view,
        phase: "crashed",
        exitCode,
        stderrTail: stderrTail.slice(-STDERR_TAIL_MAX),
        steps: view.steps.map((s) => s.state === "active" ? { ...s, state: "failed", reason: s.reason ?? "process exited" } : s),
    };
}
/** One stdout line from `bin/fire.js`, or undefined. Most fire-log lines are interleaved stderr. */
export function parseFireLine(line) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.endsWith("}"))
        return undefined;
    let v;
    try {
        v = JSON.parse(t);
    }
    catch {
        return undefined;
    }
    if (typeof v !== "object" || v === null)
        return undefined;
    const e = v;
    switch (e.event) {
        case "start":
        case "flow":
        case "session":
        case "hook-start":
        case "hook-end":
        case "body-start":
        case "body-end":
        case "record":
        case "problem":
            return v;
        default:
            return undefined;
    }
}
/** Diagnostics for one run: tagged ones by tag, untagged ones by window. Duplicates collapse. */
export function foldRunProblems(lines, runId) {
    let from = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        const e = parseFireLine(lines[i]);
        if (e?.event === "start" && e.runId === runId) {
            from = i;
            break;
        }
    }
    let to = lines.length;
    if (from !== -1) {
        for (let i = from + 1; i < lines.length; i++) {
            const e = parseFireLine(lines[i]);
            if (!e)
                continue;
            if ((e.event === "start" && e.runId !== runId) || (e.event === "record" && e.record.id !== runId)) {
                to = i;
                break;
            }
        }
    }
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const e = parseFireLine(lines[i]);
        if (e?.event !== "problem")
            continue;
        const mine = e.runId ? e.runId === runId : from !== -1 && i >= from && i < to;
        if (!mine)
            continue;
        if (!out.includes(e.message))
            out.push(e.message);
    }
    return out;
}
/** Replay after the last matching start, stopping at the next run; undefined if nothing matches. */
export function replayFireLog(base, lines, runId) {
    const problems = foldRunProblems(lines, runId);
    let startIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        const e = parseFireLine(lines[i]);
        if (e?.event === "start" && e.runId === runId) {
            startIndex = i;
            break;
        }
    }
    if (startIndex === -1)
        return problems.length > 0 ? { ...base, runId, problems } : undefined;
    let view = { ...base, runId, steps: base.steps.slice() };
    for (let i = startIndex; i < lines.length; i++) {
        const e = parseFireLine(lines[i]);
        if (!e)
            continue;
        if (e.event === "start" && e.runId !== runId)
            break;
        if (e.event === "record" && e.record.id !== runId)
            break;
        // Problems are folded after the loop, from the whole tail.
        if (e.event === "problem")
            continue;
        view = applyFireEvent(view, e);
        // Not stopping at `record`: cleanup and notification diagnostics arrive after it.
    }
    return problems.length > 0 ? { ...view, problems } : view;
}
export function activeStep(view) {
    return view.steps.find((s) => s.state === "active");
}
export function isRunning(view) {
    return view.phase === "starting" || view.phase === "running";
}
export function elapsedMs(view, now) {
    const started = Date.parse(view.startedAt);
    if (Number.isNaN(started))
        return 0;
    return Math.max(0, now.getTime() - started);
}
/** The chart's node states mapped onto step states, for nodes only the chart has. */
function stateFromFlow(status) {
    switch (status) {
        case "done":
            return "done";
        case "failed":
        case "interrupted":
            return "failed";
        case "skipped":
            return "skipped";
        case "active":
        case "waiting":
            return "active";
        default:
            return "pending";
    }
}
function pathFrom(raw) {
    if (raw.length === 0)
        return undefined;
    const nodes = raw.map((n) => ({ ...n, label: stripControls(n.label) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const current = nodes.find((n) => n.status === "active" || n.status === "waiting");
    const done = nodes
        .filter((n) => n.status === "done" || n.status === "skipped" || n.status === "failed")
        .map((n) => n.label);
    const next = (current?.successors ?? [])
        .map((id) => byId.get(id)?.label ?? id)
        .filter((l) => l !== "");
    if (!current && done.length === 0)
        return undefined;
    return {
        done,
        ...(current ? { current: { label: current.label, status: current.status } } : {}),
        next,
    };
}
/**
 * Merge store progress: own events stay authoritative; the store adds labels, text and extra nodes.
 */
export function mergeFlowNodes(view, raw) {
    if (raw.length === 0)
        return view;
    // Labels and messages are drawn in a terminal: strip control characters.
    const nodes = raw.map((n) => ({
        ...n,
        label: stripControls(n.label),
        text: n.text === null ? null : stripControls(n.text, true),
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const seen = new Set();
    const merged = view.steps.map((step) => {
        const n = byId.get(step.id);
        if (!n)
            return step;
        seen.add(step.id);
        const label = n.label.trim();
        const note = (n.text ?? "").trim();
        const next = { ...step };
        // Extra nodes stay store-owned after the first poll; only host steps keep pi authority.
        if (step.extra)
            next.state = stateFromFlow(n.status);
        // Only take a real label; a label-less node reads as its id.
        if (label !== "" && label !== n.id)
            next.label = label;
        if (note !== "")
            next.note = note;
        else
            delete next.note;
        return next;
    });
    for (const n of nodes) {
        if (seen.has(n.id))
            continue;
        const label = n.label.trim();
        const note = (n.text ?? "").trim();
        merged.push({
            id: n.id,
            label: label === "" ? n.id : label,
            state: stateFromFlow(n.status),
            extra: true,
            ...(note !== "" ? { note } : {}),
        });
    }
    const path = pathFrom(nodes);
    return { ...view, steps: merged, ...(path ? { flowPath: path } : {}) };
}
export function mergeProgress(view, progress) {
    const merged = mergeFlowNodes(view, progress.nodes);
    const notes = progress.notes ?? [];
    return { ...merged, ...(notes.length > 0 ? { notes } : {}), ...(progress.message ? { message: progress.message } : {}) };
}
//# sourceMappingURL=run-view.js.map