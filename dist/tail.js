// Following a growing file: only new complete lines; survives torn, replaced or missing files.
import { openSync, readSync, closeSync, statSync } from "node:fs";
/** How much to read in one go. A run's whole session is usually well under this. */
const CHUNK = 256 * 1024;
export function newTail() {
    return { offset: 0, partial: "", size: 0 };
}
/** Read whatever is new, as complete lines. Never throws. */
export function readTail(file, state) {
    let size;
    try {
        size = statSync(file).size;
    }
    catch {
        return { text: "", restarted: false, present: false };
    }
    let restarted = false;
    if (size < state.size) {
        // Smaller than last time: a different file. Start over.
        state.offset = 0;
        state.partial = "";
        restarted = true;
    }
    state.size = size;
    if (size <= state.offset)
        return { text: "", restarted, present: size > 0 };
    const want = Math.min(CHUNK, size - state.offset);
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    let fd;
    try {
        fd = openSync(file, "r");
        read = readSync(fd, buf, 0, want, state.offset);
    }
    catch {
        return { text: "", restarted, present: true };
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                /* nothing useful to do */
            }
        }
    }
    if (read <= 0)
        return { text: "", restarted, present: true };
    state.offset += read;
    const combined = state.partial + buf.subarray(0, read).toString("utf8");
    const lastNewline = combined.lastIndexOf("\n");
    if (lastNewline === -1) {
        // Not one whole line yet. Hold it all and wait.
        state.partial = combined;
        return { text: "", restarted, present: true };
    }
    state.partial = combined.slice(lastNewline + 1);
    return { text: combined.slice(0, lastNewline), restarted, present: true };
}
//# sourceMappingURL=tail.js.map