import { type LineTheme } from "./theme.js";
import type { RenderHost, WindowComponent } from "./window.js";
export interface PagerKey {
    /** Matched against the raw key data. */
    keys: string[];
    /** Shown in the footer. */
    hint: string;
    /** What the pager resolves with. */
    value?: boolean;
    /** Called instead of resolving. */
    run?: () => void;
}
export interface PagerHost {
    tui: RenderHost;
    theme?: LineTheme;
    title: string;
    /** Already styled; shown on the right of line 1. */
    right?: string;
    lines: string[];
    /** Footer hints and the keys that produce a result. */
    actions: PagerKey[];
    otherwise: "ignore" | "reject";
    resolve(value: boolean): void;
    /** Visible rows for the body when the terminal's height is unknown. Defaults to 20. */
    pageSize?: number;
}
/** A scrollable page that wraps rather than truncates: a cut command is a different command. */
export declare function createPager(host: PagerHost): WindowComponent;
/** The consent overlay's keys: `y` arms; every other key keeps it off. */
export declare function consentActions(): PagerKey[];
/** Read-only pages only ever close. */
export declare function readerActions(onEnter?: () => void): PagerKey[];
