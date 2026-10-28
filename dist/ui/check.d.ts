import type { Config, RunRecord, Status } from "../types.js";
import { type WatcherFacts } from "./details.js";
import { type LineTheme } from "./theme.js";
export interface CheckFacts {
    status: Status;
    now: Date;
    home: string;
    config: Config;
    /** Recent records, oldest first. */
    records?: RunRecord[];
    /** Script → the command that runs it on this machine. */
    interpreters?: Record<string, string>;
    digest?: string;
    /** The next cron instants, ISO. */
    nextRuns?: string[];
    watcher?: WatcherFacts;
}
export declare function checkPageLines(f: CheckFacts, theme?: LineTheme): string[];
