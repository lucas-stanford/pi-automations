import type { RunRecord } from "../types.js";
import { type LineTheme } from "./theme.js";
import type { RenderHost, WindowComponent } from "./window.js";
export interface RunsPageRun {
    record: RunRecord;
    /** What a provider reported about this run after it ended. */
    problems?: string[];
}
export interface RunsPageHost {
    tui: RenderHost;
    theme?: LineTheme;
    name: string;
    /** Oldest first, as the records are read. */
    runs: RunsPageRun[];
    now?: () => Date;
    close(): void;
}
export declare function createRunsPage(host: RunsPageHost): WindowComponent;
