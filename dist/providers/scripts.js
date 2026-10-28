// Running a process locally: spawn, time limit, output cap, tree kill.
import { spawn, execFile } from "node:child_process";
const STDERR_MAX = 64 * 1024;
/** Kill a process tree: a process group on POSIX, `taskkill /T` on Windows. */
export function killTree(child) {
    const pid = child.pid;
    if (!pid)
        return;
    if (process.platform === "win32") {
        try {
            execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {
                /* best effort */
            });
        }
        catch {
            /* fall through to the direct kill below */
        }
        try {
            child.kill();
        }
        catch {
            /* already gone */
        }
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    }
    catch {
        try {
            child.kill("SIGKILL");
        }
        catch {
            /* already gone */
        }
    }
}
/** A null close code means the child was signalled; read as 0, as hooks always have. */
export function exitCodeForClose(code) {
    return code ?? 0;
}
/** The local executor: an ordinary child process on this machine. */
export const runLocalScript = (command) => new Promise((resolve) => {
    // The output of a child that never ran.
    const noOutput = () => ({
        stdout: "",
        stderr: "",
        outputBytes: 0,
        truncated: false,
    });
    let child;
    try {
        child = spawn(command.file, [...command.args], {
            cwd: command.cwd,
            // The complete environment, exactly as given; nothing is inherited.
            env: { ...command.env },
            windowsHide: true,
            // A process group on POSIX, so killTree can take the whole tree down.
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
        });
    }
    catch (e) {
        resolve({ ...noOutput(), end: "start-failed", message: e.message });
        return;
    }
    let out = "";
    let outBytes = 0;
    let truncated = false;
    let err = "";
    let settled = false;
    const finish = (r) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        command.signal?.removeEventListener("abort", onAbort);
        resolve(r);
    };
    const stop = (end) => {
        killTree(child);
        finish({ end, stdout: out, stderr: err, outputBytes: outBytes, truncated });
    };
    const timer = setTimeout(() => stop("timeout"), command.timeoutMs);
    const onAbort = () => stop("cancelled");
    if (command.signal) {
        if (command.signal.aborted) {
            // Already cancelled: still kill the tree that was just spawned.
            stop("cancelled");
            return;
        }
        command.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk) => {
        outBytes += chunk.length;
        if (out.length < command.maxOutputBytes) {
            out += chunk.toString("utf8");
            if (out.length > command.maxOutputBytes) {
                out = out.slice(0, command.maxOutputBytes);
                truncated = true;
            }
        }
        else {
            truncated = true;
        }
    });
    child.stderr?.on("data", (chunk) => {
        if (err.length < STDERR_MAX)
            err += chunk.toString("utf8");
    });
    child.on("error", (e) => {
        finish({ ...noOutput(), end: "start-failed", message: e.message });
    });
    child.on("close", (code, signal) => {
        finish({
            end: "exit",
            // See `exitCodeForClose`: a null code is a signalled child, not a missing observation.
            exit: exitCodeForClose(code),
            ...(code === null && signal ? { signal } : {}),
            stdout: out,
            stderr: err,
            outputBytes: outBytes,
            truncated,
        });
    });
    if (child.stdin) {
        child.stdin.on("error", () => {
            // A child that never reads stdin makes the write fail with EPIPE. That is not an error.
        });
        if (command.stdin !== undefined)
            child.stdin.write(command.stdin);
        child.stdin.end();
    }
});
//# sourceMappingURL=scripts.js.map