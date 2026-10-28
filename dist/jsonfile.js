// JSON helpers for trust/state/detached files. Writes are atomic (temp file plus rename).
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { ensureDir } from "./paths.js";
/** Read and parse, or `undefined` when the file is absent or unreadable. */
export function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
/**
 * Write via a temporary sibling and rename, so a reader never sees a partial file. The temporary
 * name is this writer's own: two processes writing the same file must not share one.
 */
export function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, file);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
/** Create a directory tree, ignoring "already there". */
export { ensureDir };
//# sourceMappingURL=jsonfile.js.map