import { type LineTheme, type UiColor } from "./theme.js";
/** The part of pi's TUI a page reads: the terminal's height, when there is one. */
export interface PageHost {
    terminal?: {
        readonly rows: number;
    };
}
/** A key hint. Lower `rank` is more important and stays longest as the terminal narrows. */
export interface Hint {
    text: string;
    rank: number;
}
export interface PageFrame {
    /** Already styled. */
    title: string;
    /** Already styled; drawn on the right of line 1 when it fits. */
    right?: string;
    body: string[];
    /** In display order. */
    hints: Hint[];
    /** Kept on the right of the hint line whatever the width, e.g. `? help · esc close`. */
    pinned?: string[];
    /** Replaces the hint line while it lasts. */
    flash?: {
        text: string;
        color: UiColor;
    };
}
/** Rows a page has, or `undefined` when the host does not know. */
export declare function pageRows(host: PageHost | undefined): number | undefined;
/** How many body lines fit between the title and the hints. */
export declare function bodyRows(rows: number | undefined, fallback?: number): number;
/**
 * The hint line: as many hints as fit, the least important leaving first, the pinned ones never.
 */
export declare function hintLine(hints: Hint[], pinned: string[], width: number, theme?: LineTheme): string;
/** `left` and `right` on one line, the right side dropped when they do not both fit. */
export declare function titleLine(left: string, right: string | undefined, width: number): string;
/**
 * The page, exactly `rows` lines when known: title, blank, body (cut to fit), padding, hint line.
 */
export declare function renderPage(frame: PageFrame, width: number, rows: number | undefined, theme?: LineTheme): string[];
/** A dim rule across the page. */
export declare function rule(width: number, theme?: LineTheme): string;
/** `room` lines of `lines` with `from`..`to` in view, marking what is hidden. */
export declare function windowBlock(lines: string[], from: number, to: number, room: number, theme?: LineTheme): string[];
