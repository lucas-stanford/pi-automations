// Every run this session knows: attached, observed (from locks and fire logs) and lingering. No
// timers: the caller polls.
import { isAlive, isRunLockStale, readRunLock } from "../locks.js";
import { ms } from "../config.js";
import { readFireLogTail } from "./firelog.js";
import { applyFireEvent, isRunning, markCrashed, mergeObservedReplay, mergeProgress, observedView, replayFireLog, startingView, } from "./run-view.js";
let counter = 0;
export class RunRegistry {
    deps;
    entries = new Map();
    listeners = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    /** Notified after every change. Returns an unsubscribe. */
    subscribe(fn) {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    }
    changed() {
        for (const fn of [...this.listeners]) {
            try {
                fn();
            }
            catch {
                // A listener that throws must not stop the others, and must never reach a run.
            }
        }
    }
    /** Register a run this process is about to start, with its full plan. */
    addAttached(args) {
        const id = `attached-${++counter}`;
        this.entries.set(id, {
            id,
            view: startingView({
                located: args.located,
                trigger: args.trigger,
                startedAt: this.deps.now().toISOString(),
                timeoutMs: args.timeoutMs,
                ...(args.pid !== undefined ? { pid: args.pid } : {}),
            }),
        });
        this.changed();
        return id;
    }
    /** Fold one parsed event into an attached run. Unknown ids are ignored, never created. */
    applyEvent(id, event) {
        const e = this.entries.get(id);
        if (!e)
            return;
        this.entries.set(id, { ...e, view: applyFireEvent(e.view, event) });
        this.changed();
    }
    /** The child closed without a record. */
    crash(id, exitCode, stderrTail) {
        const e = this.entries.get(id);
        if (!e)
            return;
        this.entries.set(id, { ...e, view: markCrashed(e.view, exitCode, stderrTail) });
        this.changed();
    }
    /** Attach a pid once the child exists, so the window can name the process. */
    setPid(id, pid) {
        const e = this.entries.get(id);
        if (!e)
            return;
        this.entries.set(id, { ...e, view: { ...e.view, pid } });
        this.changed();
    }
    // Rebuild observed runs from locks, checking liveness like the sweeper; skip attached keys.
    refreshObserved(keys) {
        const now = this.deps.now();
        const hookTimeoutMs = ms(this.deps.config, "hookTimeout");
        const attachedKeys = new Set([...this.entries.values()]
            .filter((e) => e.id.startsWith("attached-") && isRunning(e.view))
            .map((e) => e.view.key));
        const seen = new Set();
        let changed = false;
        for (const key of keys) {
            if (attachedKeys.has(key))
                continue;
            const lock = readRunLock(this.deps.stateDir, key);
            if (!lock)
                continue;
            if (!isAlive(lock.pid) || isRunLockStale(lock, hookTimeoutMs, now))
                continue;
            seen.add(key);
            const base = observedView(lock);
            const tail = readFireLogTail(this.deps.stateDir, key);
            const replayed = replayFireLog(base, tail, lock.runId);
            const view = mergeObservedReplay(base, replayed);
            const prev = this.entries.get(key);
            if (!prev || JSON.stringify(prev.view) !== JSON.stringify(view)) {
                this.entries.set(key, { id: key, view });
                changed = true;
            }
        }
        // An observed run whose lock is gone has ended elsewhere; its record is in `log`.
        for (const [id, e] of [...this.entries]) {
            if (e.view.source !== "observed")
                continue;
            if (seen.has(id))
                continue;
            this.entries.delete(id);
            changed = true;
        }
        if (changed)
            this.changed();
    }
    /** Read and merge the progress of every running run, on the same 1 s tick. */
    refreshFlow() {
        const ask = this.deps.progress;
        if (!ask)
            return;
        let changed = false;
        for (const [id, e] of [...this.entries]) {
            // Every run keeps notes, so one without a chart is asked too, by its own run id.
            const run = e.view.flow?.run ?? e.view.runId;
            if (!run || !isRunning(e.view))
                continue;
            let progress;
            try {
                progress = ask({ run });
            }
            catch {
                // A read that fails must never reach a run, and it must never reach the window either.
                continue;
            }
            if (!progress || (progress.nodes.length === 0 && (progress.notes ?? []).length === 0 && !progress.message))
                continue;
            const next = mergeProgress(e.view, progress);
            if (JSON.stringify(next) === JSON.stringify(e.view))
                continue;
            this.entries.set(id, { ...e, view: next });
            changed = true;
        }
        if (changed)
            this.changed();
    }
    /** Stop showing a finished run. Refuses while it is still going — that would hide live work. */
    dismiss(id) {
        const e = this.entries.get(id);
        if (!e || isRunning(e.view))
            return false;
        this.entries.delete(id);
        this.changed();
        return true;
    }
    /** Drop every finished run at once. */
    dismissFinished() {
        let changed = false;
        for (const [id, e] of [...this.entries]) {
            if (isRunning(e.view))
                continue;
            this.entries.delete(id);
            changed = true;
        }
        if (changed)
            this.changed();
    }
    /** Everything, running first, oldest first within each group. */
    all() {
        return [...this.entries.values()].sort((a, b) => {
            const ar = isRunning(a.view) ? 0 : 1;
            const br = isRunning(b.view) ? 0 : 1;
            if (ar !== br)
                return ar - br;
            return a.view.startedAt.localeCompare(b.view.startedAt);
        });
    }
    running() {
        return this.all().filter((e) => isRunning(e.view));
    }
    finished() {
        return this.all().filter((e) => !isRunning(e.view));
    }
    get size() {
        return this.entries.size;
    }
    // Drop everything. Used at session shutdown — the children keep running, we just stop watching.
    clear() {
        if (this.entries.size === 0)
            return;
        this.entries.clear();
        this.changed();
    }
}
//# sourceMappingURL=registry.js.map