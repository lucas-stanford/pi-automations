// Telling plugins about a run from its worker, by following the run's progress file. Bounded.

import { progressOf, readProgress } from "../progress.js";
import type { RunProgress, RunRecord, RunStep } from "../types.js";
import type { RunObservers } from "./loader.js";
import type { PluginRun } from "./types.js";

/** How often a running run's progress is read for its observers. */
export const OBSERVE_POLL_MS = 500;

export class RunReporter {
  private readonly pending: Promise<void>[] = [];
  private readonly problems: string[] = [];
  private readonly seen = new Map<string, string>();
  private notesSeen = 0;
  private messageSeen: string | undefined;

  constructor(
    private readonly observers: RunObservers,
    private readonly run: PluginRun,
    private readonly stateDir: string,
  ) {
    this.problems.push(...observers.problems);
  }

  private send(promise: Promise<string[]>): void {
    this.pending.push(promise.then((p) => void this.problems.push(...p), () => undefined));
  }

  start(startedAt: string): void {
    if (!this.observers.observing) return;
    this.send(this.observers.emit("run-start", { run: this.run, startedAt }));
  }

  /** Pass on what moved since the last look. */
  poll(): void {
    if (!this.observers.observing) return;
    const snap = readProgress(this.stateDir, this.run.runId);
    if (snap) this.diff(progressOf(snap));
  }

  /** The progress as it was folded into the record: the last word on every node, note and message. */
  finish(progress: RunProgress | undefined): void {
    if (!this.observers.observing || !progress) return;
    this.diff(progress);
  }

  private diff(progress: RunProgress): void {
    for (const step of progress.steps) {
      const sig = `${step.status}\u0000${step.text ?? ""}`;
      const before = this.seen.get(step.id) ?? `pending\u0000`;
      if (sig === before) continue;
      this.seen.set(step.id, sig);
      this.send(this.observers.emit("step", { run: this.run, step: { ...step } as RunStep }));
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

  problemsSoFar(): string[] {
    return [...this.problems];
  }

  /** Wait for what was sent, and hand back what went wrong — for the record. */
  async settle(): Promise<string[]> {
    await Promise.all(this.pending);
    return [...this.problems];
  }

  /** The record is written; tell them. Returns what went wrong, which can only be logged now. */
  async end(record: RunRecord): Promise<string[]> {
    if (!this.observers.observing) return [];
    return this.observers.emit("run-end", { run: this.run, record });
  }
}
