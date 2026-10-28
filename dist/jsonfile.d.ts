import { ensureDir } from "./paths.js";
/** Read and parse, or `undefined` when the file is absent or unreadable. */
export declare function readJson<T>(file: string): T | undefined;
/**
 * Write via a temporary sibling and rename, so a reader never sees a partial file. The temporary
 * name is this writer's own: two processes writing the same file must not share one.
 */
export declare function writeJsonAtomic(file: string, value: unknown): void;
/** Create a directory tree, ignoring "already there". */
export { ensureDir };
