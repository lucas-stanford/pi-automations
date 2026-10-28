import type { HookResult, Located } from "./types.js";
import type { RunInfo } from "./hooks.js";
export interface InputItem {
    index: number;
    source: string;
    status: HookResult["status"];
    output: string;
    truncated?: boolean;
}
/** The `<run .../>` element that opens the input block. */
export declare function runHeader(l: Located, run: RunInfo, now: Date): string;
/** Neutralise only this format's two delimiters. */
export declare function escapeOutput(s: string): string;
export declare function inputBlock(header: string, items: InputItem[], lateLine?: string): string;
/** The full prompt: the body, how to report when the run is tracked, then the delimited input. */
export declare function bodyPrompt(body: string, header: string, items: InputItem[], lateLine?: string, guide?: string): string;
/** The sentence that tells a late run it is late, so the body can decide what to do about it. */
export declare function lateLine(run: RunInfo, now: Date, timezone?: string): string | undefined;
