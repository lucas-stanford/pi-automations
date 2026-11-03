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
/**
 * The local files the scripts import, directly or through each other: what `import … from`,
 * `import(…)`, `export … from` and `require(…)` name with a `./` or `../` path in a `.mjs`, `.js`
 * or `.cjs` file. Relative paths written with `/`, never a script itself, in the order aat hashes
 * them. A package (`node:fs`, `yaml`), a file outside the automation directory and a file that does
 * not exist are left out.
 */
export declare function moduleFiles(l: Located): string[];
/**
 * The `./` and `../` paths a JavaScript source imports. Comments are skipped, a string ends on its
 * own line, and it counts only right after `from`, `import`, `import(` or `require(`.
 */
export declare function localSpecifiers(source: string): string[];
/**
 * `"sha256:<hex>"` over AUTOMATION.md plus every script it can run, in order, then every module
 * those scripts import. Without imports it is the digest it always was.
 */
export declare function digestOf(l: Located): string;
/** Per-file hashes, so a mismatch can name the file. A missing file is `null`. */
export declare function fileHashesOf(l: Located): Record<string, string | null>;
