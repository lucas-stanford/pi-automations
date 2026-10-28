import type { Located } from "./types.js";
/** Every script hook, in the order the run will execute them. */
export declare function scriptHooks(l: Located): Array<{
    phase: "pre" | "post";
    index: number;
    script: string;
}>;
/** Every script this automation can run: the watch script first, then hooks in run order. */
export declare function scriptFiles(l: Located): Array<{
    field: string;
    script: string;
}>;
/** `"sha256:<hex>"` over AUTOMATION.md plus every script it can run, in order. */
export declare function digestOf(l: Located): string;
/** Per-file hashes, so a mismatch can name the file. A missing file is `null`. */
export declare function fileHashesOf(l: Located): Record<string, string | null>;
