import type { RunLink, RunRecord } from "../types.js";
import { type LineTheme } from "./theme.js";
export interface ShownMessage {
    /** Where it came from: the run's own message, its notes, or its final reply. */
    from: "message" | "notes" | "reply";
    text: string;
    links: RunLink[];
}
/** What a run left for its reader, by the fallback every surface shares. */
export declare function shownMessage(rec: RunRecord | undefined): ShownMessage | undefined;
/**
 * Message text on one line, as a reader sees it: Markdown emphasis, code ticks and link targets
 * dropped (links show as their own rows), and nothing in it a terminal would act on.
 */
export declare function messageText(text: string): string;
export interface MessageAreaOptions {
    name: string;
    /** `today 08:01`: when the run ended, in the page's words. */
    when: string;
    shown: ShownMessage;
    width: number;
    /** Rows it may take, its blank separator and heading included. Unbounded when absent. */
    room?: number;
    theme?: LineTheme;
}
/**
 * The area under the list: a blank line, `── Last message · name · when ───`, the text, then each
 * link on its own row. Short of room, text is trimmed before any link; under three rows, nothing.
 */
export declare function messageAreaLines(opts: MessageAreaOptions): string[];
