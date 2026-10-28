// Which command runs a hook script, resolved at arm time (a scheduled job has no shell PATH).
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
/** Find an executable on PATH by reading PATH and PATHEXT, without spawning `which`/`where`. */
export function whichSync(bin, platform = process.platform) {
    const isWindows = platform === "win32";
    if (bin.includes("/") || bin.includes("\\")) {
        return isExecutableFile(bin, isWindows) ? path.resolve(bin) : undefined;
    }
    const pathVar = process.env.PATH ?? process.env.Path ?? "";
    const sep = isWindows ? ";" : ":";
    const dirs = pathVar.split(sep).filter(Boolean);
    const exts = isWindows
        ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
        : [""];
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = path.join(dir.replace(/^"|"$/g, ""), bin + ext);
            if (isExecutableFile(candidate, isWindows))
                return candidate;
        }
    }
    return undefined;
}
function isExecutableFile(p, isWindows) {
    try {
        if (!statSync(p).isFile())
            return false;
    }
    catch {
        return false;
    }
    if (isWindows)
        return true;
    try {
        accessSync(p, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** True when the file carries any executable bit. POSIX only — Windows has no such concept. */
export function hasExecutableBit(p) {
    try {
        return (statSync(p).mode & 0o111) !== 0;
    }
    catch {
        return false;
    }
}
function firstOf(which, ...bins) {
    for (const b of bins) {
        const found = which(b);
        if (found)
            return found;
    }
    return undefined;
}
/** Decide how to run `absScript`. `relPath` is only for display. */
export function resolveInterpreter(absScript, platform = process.platform, which = (b) => whichSync(b, platform), relPath = path.basename(absScript)) {
    const isWindows = platform === "win32";
    const ext = path.extname(absScript).toLowerCase();
    const ok = (file, ...leading) => ({
        ok: true,
        file,
        args: [...leading, absScript],
        display: [file, ...leading, relPath].join(" "),
    });
    switch (ext) {
        case ".js":
        case ".mjs":
        case ".cjs":
            // Hooks get the node running the tick.
            return ok(process.execPath);
        case ".py": {
            const py = isWindows
                ? firstOf(which, "py", "python3", "python")
                : firstOf(which, "python3", "python");
            if (!py) {
                return {
                    ok: false,
                    reason: "cannot run here — needs python3 on this OS",
                };
            }
            // `py` is the Windows launcher; `-3` picks Python 3 rather than whatever is first.
            if (isWindows && path.basename(py).toLowerCase().startsWith("py."))
                return ok(py, "-3");
            return ok(py);
        }
        case ".sh": {
            const sh = isWindows ? firstOf(which, "bash") : firstOf(which, "bash", "sh");
            if (!sh) {
                return {
                    ok: false,
                    reason: isWindows
                        ? 'cannot run here — needs bash on this OS, so install Git Bash or use a .ps1 or .cmd script'
                        : "cannot run here — needs bash or sh on this OS",
                };
            }
            return ok(sh);
        }
        case ".ps1": {
            const pwsh = firstOf(which, "pwsh");
            if (pwsh)
                return ok(pwsh, "-NoProfile", "-File");
            if (isWindows) {
                const ps = firstOf(which, "powershell");
                if (ps)
                    return ok(ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File");
            }
            return { ok: false, reason: "cannot run here — needs pwsh (PowerShell 7) on this OS" };
        }
        case ".cmd":
        case ".bat": {
            if (!isWindows) {
                return { ok: false, reason: "cannot run here — .cmd and .bat need Windows" };
            }
            const cmd = firstOf(which, "cmd") ?? process.env.ComSpec;
            if (!cmd)
                return { ok: false, reason: "cannot run here — cmd.exe was not found" };
            return ok(cmd, "/c");
        }
        case "": {
            if (isWindows) {
                return {
                    ok: false,
                    reason: "cannot run here — Windows needs a file extension to know how to run a script",
                };
            }
            if (!existsSync(absScript)) {
                return { ok: false, reason: "cannot run here — the file is missing" };
            }
            if (!hasExecutableBit(absScript)) {
                return {
                    ok: false,
                    reason: "cannot run here — it has no extension and is not executable, so chmod +x it",
                };
            }
            return { ok: true, file: absScript, args: [], display: relPath };
        }
        default:
            return { ok: false, reason: `cannot run here — no interpreter for "${ext}" on this OS` };
    }
}
//# sourceMappingURL=interpreters.js.map