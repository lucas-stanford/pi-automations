// Telling plugins about a run from its worker, by following the run's progress file. Bounded.
import { progressOf, readProgress } from "../progress.js";
/** How often a running run's progress is read for its observers. */
export const OBSERVE_POLL_MS = 500;
export class RunReporter {
    observers;
    run;
    stateDir;
    pending = [];
    problems = [];
    seen = new Map();
    notesSeen = 0;
    messageSeen;
    constructor(observers, run, stateDir) {
        this.observers = observers;
        this.run = run;
        this.stateDir = stateDir;
        this.problems.push(...observers.problems);
    }
    send(promise) {
        this.pending.push(promise.then((p) => void this.problems.push(...p), () => undefined));
    }
    start(startedAt) {
        if (!this.observers.observing)
            return;
        this.send(this.observers.emit("run-start", { run: this.run, startedAt }));
    }
    /** Pass on what moved since the last look. */
    poll() {
        if (!this.observers.observing)
            return;
        const snap = readProgress(this.stateDir, this.run.runId);
        if (snap)
            this.diff(progressOf(snap));
    }
    /** The progress as it was folded into the record: the last word on every node, note and message. */
    finish(progress) {
        if (!this.observers.observing || !progress)
            return;
        this.diff(progress);
    }
    diff(progress) {
        for (const step of progress.steps) {
            const sig = `${step.status}\u0000${step.text ?? ""}`;
            const before = this.seen.get(step.id) ?? `pending\u0000`;
            if (sig === before)
                continue;
            this.seen.set(step.id, sig);
            this.send(this.observers.emit("step", { run: this.run, step: { ...step } }));
        }
        for (const note of progress.notes.slice(this.notesSeen)) {
            this.send(this.observers.emit("note", { run: this.run, note: { ...note, links: note.links.map((l) => ({ ...l })) } }));
        }
        this.notesSeen = Math.max(this.notesSeen, progress.notes.length);
        const m = progress.message;
        if (m) {
            const sig = JSON.stringify([m.ts, m.text, m.links]);
            if (sig !== this.messageSeen) {
                this.messageSeen = sig;
                this.send(this.observers.emit("message", { run: this.run, message: { ...m, links: m.links.map((l) => ({ ...l })) } }));
            }
        }
    }
    problemsSoFar() {
        return [...this.problems];
    }
    /** Wait for what was sent, and hand back what went wrong — for the record. */
    async settle() {
        await Promise.all(this.pending);
        return [...this.problems];
    }
    /** The record is written; tell them. Returns what went wrong, which can only be logged now. */
    async end(record) {
        if (!this.observers.observing)
            return [];
        return this.observers.emit("run-end", { run: this.run, record });
    }
}
//# sourceMappingURL=lifecycle.js.map