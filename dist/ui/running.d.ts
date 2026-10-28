import { type RunView } from "./run-view.js";
import { type LineTheme, type UiColor } from "./theme.js";
/** `m:ss`, or `h:mm:ss` past an hour: a stable width for a counter that ticks every second. */
export declare function clock(msValue: number): string;
/** How many wrapped lines of the run's own output a run page shows. */
export declare const DETAIL_OUTPUT_LINES = 12;
/** A step's name as a person says it. */
export declare function stepWords(label: string): string;
/** `this session` or `background · pid 4812`: where the run is happening. */
export declare function sourceText(view: RunView): string;
/** The title of one run's page. */
export declare function runTitle(view: RunView, _now?: Date, theme?: LineTheme): string;
/**
 * `3m in · usually 7m` while it runs, `took 5m` once it has finished: dim, on the title's right.
 */
export declare function runTitleRight(view: RunView, now: Date, usual?: number, theme?: LineTheme): string | undefined;
/** The sentence a run's page opens with, in its colour. */
export declare function runLead(view: RunView, now: Date, usual?: number): {
    text: string;
    color: UiColor;
};
/** A run's steps as a tree: the hooks and body, with chart nodes nested under the body. */
export declare function runStepTree(view: RunView, width: number, theme?: LineTheme, indent?: string): string[];
/** One run's page: progress, steps, its message and notes and output, then the technical details. */
export declare function runPageLines(view: RunView, width: number, now: Date, theme?: LineTheme, _tick?: number, usual?: number): string[];
/** Provider problems, beside the outcome and attributed to the provider. */
export declare function problemLines(view: RunView, width: number, t: LineTheme): string[];
/** Enough to show a real fault and its cause, few enough not to bury the run. */
export declare const PROBLEMS_SHOWN = 3;
/** The plain-text answer for non-terminal modes: one line per running automation. */
export declare function renderRunningLines(views: RunView[], now: Date): string[];
/** The footer while runs are in flight, or undefined. */
export declare function runningFooter(views: RunView[], now: Date): string | undefined;
/** One compact line per running run, for the strip above the editor. */
export declare function widgetLines(views: RunView[], now: Date, tick: number): string[];
