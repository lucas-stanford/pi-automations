// Launching a worker locally. It never parses output, restarts or kills workers.
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
/** The stdio triple for one output choice. */
function stdioFor(output) {
    switch (output.kind) {
        case "inherit":
            return ["inherit", "inherit", "inherit"];
        case "file":
            // stdin stays closed: a worker nobody is typing at must never block waiting for input.
            return ["ignore", output.fd, output.fd];
        case "pipe":
            return ["ignore", "pipe", "pipe"];
        default:
            return ["ignore", "ignore", "ignore"];
    }
}
/** Node's `close` as a union; neither code nor signal is an abnormal end. */
export function completionFor(code, signal) {
    if (code !== null)
        return { end: "exit", exit: code };
    if (signal !== null)
        return { end: "signal", signal };
    return { end: "signal", signal: "SIGKILL" };
}
/** Exit code for an ended worker: a signal is 0, an unreadable completion is not. */
export function exitCodeForCompletion(c) {
    return c.end === "exit" ? c.exit : 0;
}
// Every Node signal name, so a POSIX completion stays valid when read on Windows.
const KNOWN_SIGNALS = new Set([
    ...Object.keys(osConstants.signals),
    "SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP",
    "SIGILL", "SIGINFO", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGLOST", "SIGPIPE",
    "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS",
    "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG", "SIGUSR1",
    "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ",
]);
/** Read an untyped completion, or undefined. Contradictory results are refused. */
export function readCompletion(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const v = value;
    if (v.end === "exit") {
        // Mentioning the other ending at all, even as null, is a contradiction.
        if ("signal" in v)
            return undefined;
        return typeof v.exit === "number" && Number.isInteger(v.exit)
            ? { end: "exit", exit: v.exit }
            : undefined;
    }
    if (v.end === "signal") {
        if ("exit" in v)
            return undefined;
        return typeof v.signal === "string" && KNOWN_SIGNALS.has(v.signal)
            ? { end: "signal", signal: v.signal }
            : undefined;
    }
    return undefined;
}
/** The local transport. `completion` always has a handler. */
export const launchLocalWorker = (launch) => {
    let child;
    let settle = () => { };
    let fail = () => { };
    let acknowledge = () => { };
    const completion = new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });
    // Nobody is required to await this. A tick fires and forgets.
    completion.catch(() => { });
    /** Resolved by node's `spawn` event. Never rejects and settles exactly once. */
    let acknowledged = false;
    const started = new Promise((resolve) => {
        acknowledge = (s) => {
            if (acknowledged)
                return;
            acknowledged = true;
            resolve(s);
        };
    });
    try {
        child = spawn(launch.entry, [...launch.args], {
            detached: launch.detached,
            windowsHide: true,
            stdio: stdioFor(launch.output),
            ...(launch.env ? { env: { ...launch.env } } : {}),
        });
    }
    catch (e) {
        acknowledge({ ok: false, reason: e.message });
        fail(e);
        return {
            started,
            completion,
            release: () => { },
        };
    }
    // `error` covers ENOENT and EACCES, which arrive after the child object is returned.
    child.on("spawn", () => acknowledge({ ok: true, pid: child.pid ?? 0 }));
    child.on("error", (e) => {
        acknowledge({ ok: false, reason: e.message });
        fail(e);
    });
    // Reaching `close` without either event means it started and ended.
    child.on("close", (code, signal) => {
        acknowledge({ ok: true, pid: child.pid ?? 0 });
        settle(completionFor(code, signal));
    });
    return {
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...(child.stdout ? { stdout: child.stdout } : {}),
        ...(child.stderr ? { stderr: child.stderr } : {}),
        started,
        completion,
        // Stop waiting but let the worker run: `unref` and drain its pipes; never signal it.
        release: () => {
            for (const stream of [child.stdout, child.stderr]) {
                if (!stream)
                    continue;
                try {
                    stream.on("error", () => { });
                    stream.resume();
                }
                catch {
                    /* already gone */
                }
            }
            try {
                child.unref();
            }
            catch {
                /* already gone */
            }
        },
    };
};
//# sourceMappingURL=worker.js.map