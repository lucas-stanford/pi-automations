import { type ProgressSnapshot } from "../../progress.js";
import type { RenderChart } from "../../core/contracts.js";
import type { LineTheme } from "../../ui/theme.js";
import type { FlowPane } from "../../ui/window.js";
export type { FlowPane };
export interface FlowViewerOptions {
    /** How to draw a chart, or nothing: then every pane is the step list. */
    render?: RenderChart;
    /** The current theme, or nothing. The builders never need pi to draw. */
    theme?: () => LineTheme | undefined;
}
export interface FlowViewer {
    /** The pane for a run, or `undefined` when it is not tracked. */
    pane(snapshot: ProgressSnapshot | undefined, width: number): FlowPane | undefined;
    /** Plain uncoloured lines for a finished run, stored on a transcript entry. */
    lines(snapshot: ProgressSnapshot | undefined, width?: number): string[] | undefined;
    /** The last render problem, shown once rather than on every frame. */
    readonly problem: string | undefined;
    /** Forget everything cached. Reload and disposal call this. */
    clear(): void;
}
export declare function createFlowViewer(options?: FlowViewerOptions): FlowViewer;
