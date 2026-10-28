import type { AutomationState, Status } from "./types.js";
export interface ListingOptions {
    home: string;
    /** Repository roots, in the order their groups should appear. Empty means "not inside a repository". */
    projectRoots: string[];
    width?: number;
    now: Date;
    locale?: string;
}
/** The SCHEDULE column: the cron, the watch interval, or both. Exported for the report. */
export declare function scheduleText(s: Status): string;
/** One row of the listing, carrying its `Status` so an action never matches back by name. */
export interface Row {
    status: Status;
    name: string;
    state: AutomationState;
    schedule: string;
    next: string;
    hooks: string;
    reason?: string;
    /** Tracked on a flowchart — shown as a marker before the name. */
    flow?: boolean;
    /** Seven recent outcomes. Only surfaces that read records fill this in. */
    sparkline?: string;
    /** A short human summary of the same runs, for the detail line. */
    summary?: string;
}
/** One scope group. Grouping happens in the model so every surface agrees. */
export interface Group {
    kind: "user" | "project";
    /** `USER · ~/.agents/automations` */
    title: string;
    /** The root directory this group lists. */
    path: string;
    rows: Row[];
    /** Shown instead of rows when there are none. */
    empty?: string;
}
export interface ListingModel {
    groups: Group[];
    cols: Cols;
    /** True when a separator belongs between the user and repository groups. */
    separator: boolean;
}
/** The listing before rendering; `decorate` adds a sparkline without filesystem access here. */
export declare function listingModel(statuses: Status[], opts: ListingOptions & {
    decorate?: (row: Row) => void;
}): ListingModel;
export declare function renderListing(statuses: Status[], opts: ListingOptions): string[];
export interface Cols {
    name: number;
    state: number;
    schedule: number;
    next: number;
    sparkline: number;
    showSchedule: boolean;
    showHooks: boolean;
    showSparkline: boolean;
    /** Reserve two columns for the flowchart marker, only when something on screen is tracked. */
    showFlow: boolean;
}
/**
 * Decide the columns. Names are never cut: HOOKS, the sparkline, then SCHEDULE are dropped first.
 */
export declare function measure(rows: Row[], width: number): Cols;
export declare function tableWidth(cols: Cols): number;
export declare function header(cols: Cols): string;
/** The cells of one row, already padded. A surface that colours them joins them itself. */
export declare function rowCells(row: Row, cols: Cols): string[];
/** The one-line summary for `ctx.ui.setStatus`. */
export declare function statusLine(statuses: Status[], now: Date, locale?: string): string;
