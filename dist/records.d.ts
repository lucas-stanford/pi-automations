import type { Config, FireEvent, RunRecord } from "./types.js";
/** `20260917-140047-3fa2` — sortable, readable, and unique enough within a second. */
export declare function newRunId(now?: Date): string;
export declare function recordsFile(dir: string, key: string): string;
/** Append one record (repairing a torn last line first), then rotate if needed. */
export declare function appendRecord(dir: string, rec: RunRecord, retention?: Config["retention"]): void;
/** Append one event to an automation's fire log, with the same torn-line repair. Throws. */
export declare function appendFireEvent(dir: string, key: string, event: FireEvent): void;
/** The last `n` records, oldest first. Unparsable lines are skipped. */
export declare function readRecords(dir: string, key: string, n?: number): RunRecord[];
export declare function lastRecord(dir: string, key: string): RunRecord | undefined;
/** Trim a log that has grown past `maxLinesPerAutomation` down to `keepLines`, atomically. */
export declare function rotateIfNeeded(dir: string, key: string, retention: Config["retention"]): void;
