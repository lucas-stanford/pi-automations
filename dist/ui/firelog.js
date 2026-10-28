// Reading the bounded tail of a fire log, where most lines are not JSON.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { fireLogPath } from "../paths.js";
import { foldRunProblems } from "./run-view.js";
/** How much of the tail to read. Large enough for a long run's events, small enough to be free. */
export const FIRE_LOG_TAIL_BYTES = 256 * 1024;
/**
 * The last `maxBytes` of a fire log as lines; `[]` when missing. A partial first line is dropped.
 */
export function readFireLogTail(stateDir, key, maxBytes = FIRE_LOG_TAIL_BYTES) {
    const file = fireLogPath(stateDir, key);
    let fd;
    try {
        fd = openSync(file, "r");
    }
    catch {
        return [];
    }
    try {
        const size = fstatSync(fd).size;
        if (size === 0)
            return [];
        const take = Math.min(size, maxBytes);
        const buf = Buffer.allocUnsafe(take);
        const read = readSync(fd, buf, 0, take, size - take);
        const text = buf.subarray(0, read).toString("utf8");
        const lines = text.split(/\r?\n/);
        // Dropped only when we actually started mid-file; a whole file's first line is real.
        if (take < size)
            lines.shift();
        return lines;
    }
    catch {
        return [];
    }
    finally {
        try {
            closeSync(fd);
        }
        catch {
            /* nothing useful to do */
        }
    }
}
/** Diagnostics one run left behind. The fold lives in `run-view` so the replay can share it. */
export { foldRunProblems } from "./run-view.js";
/** The same, read from the automation's log tail. */
export function readRunProblems(stateDir, key, runId) {
    return foldRunProblems(readFireLogTail(stateDir, key), runId);
}
//# sourceMappingURL=firelog.js.map