import { type LineTheme } from "./theme.js";
import type { RunView } from "./run-view.js";
import type { RunRecord } from "../types.js";
/** What is stored on the entry: the record plus how the child exited and its stderr tail. */
export interface RunEntryData {
    record?: RunRecord;
    /** Present when the child closed without a record. */
    exitCode?: number;
    stderrTail?: string[];
    /** Name to show when there is no record to take one from. */
    name: string;
    /** The step list, rendered when the run ended. Plain text; the renderer applies its theme. */
    flowLines?: string[];
    /** Which run this receipt is for, also for a run that died without a record. */
    key?: string;
    runId?: string;
    /** Provider faults already known when the receipt is created. Hosts may add later log faults. */
    problems?: string[];
}
export declare const RUN_ENTRY_TYPE = "pi-automations/run";
export declare function entryDataFor(view: RunView, flowLines?: string[]): RunEntryData;
/** The collapsed line: `▇ flow-example ok · 1:12 · 2 hooks`. */
export declare function collapsedEntryLine(data: RunEntryData, width: number, theme?: LineTheme): string;
/** Everything the record knows. The session file is printed as a plain path, not a command. */
export declare function expandedEntryLines(data: RunEntryData, width: number, theme?: LineTheme): string[];
/** The part of pi-tui's `Component` an entry needs, declared here so `src/ui` stays free of pi. */
export interface EntryComponent {
    render(width: number): string[];
    invalidate(): void;
}
/** Laid out for the drawn width (pi stops drawing on an overlong line); cached per width. */
export declare function runEntryComponent(data: RunEntryData, expanded: boolean, theme?: LineTheme): EntryComponent;
