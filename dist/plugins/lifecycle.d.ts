import type { RunProgress, RunRecord } from "../types.js";
import type { RunObservers } from "./loader.js";
import type { PluginRun } from "./types.js";
/** How often a running run's progress is read for its observers. */
export declare const OBSERVE_POLL_MS = 500;
export declare class RunReporter {
    private readonly observers;
    private readonly run;
    private readonly stateDir;
    private readonly pending;
    private readonly problems;
    private readonly seen;
    private notesSeen;
    private messageSeen;
    constructor(observers: RunObservers, run: PluginRun, stateDir: string);
    private send;
    start(startedAt: string): void;
    /** Pass on what moved since the last look. */
    poll(): void;
    /** The progress as it was folded into the record: the last word on every node, note and message. */
    finish(progress: RunProgress | undefined): void;
    private diff;
    problemsSoFar(): string[];
    /** Wait for what was sent, and hand back what went wrong — for the record. */
    settle(): Promise<string[]>;
    /** The record is written; tell them. Returns what went wrong, which can only be logged now. */
    end(record: RunRecord): Promise<string[]>;
}
