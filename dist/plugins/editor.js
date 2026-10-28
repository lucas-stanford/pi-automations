// Edit without a plugin: `$VISUAL`, `$EDITOR`, VS Code or the OS opener (no terminal editor in pi).
import { spawn } from "node:child_process";
import { whichSync } from "../interpreters.js";
import { openCommand } from "../report.js";
export function chooseEditor(args) {
    const env = args.env ?? process.env;
    const which = args.which ?? ((bin) => whichSync(bin));
    if (args.where === "cli") {
        for (const name of ["VISUAL", "EDITOR"]) {
            const command = env[name]?.trim();
            if (command)
                return { kind: "command", command };
        }
    }
    const code = which("code");
    if (code)
        return { kind: "code", bin: code };
    const opener = openCommand(args.file, args.platform);
    return { kind: "opener", file: opener.file, args: opener.args };
}
/** How the choice is said to the person: `opened daily in $EDITOR (vim)`. */
export function describeEditor(choice) {
    if (choice.kind === "command")
        return choice.command;
    if (choice.kind === "code")
        return "VS Code";
    return "the app your system opens .md files with";
}
function quoted(file, platform) {
    return platform === "win32" ? `"${file}"` : `'${file.replace(/'/g, `'\\''`)}'`;
}
/** Why `file` cannot go through cmd: `%NAME%` expands and `"` ends quoting. */
export function unsafeForShell(file, platform) {
    if (platform !== "win32")
        return undefined;
    return /[%"]/.test(file) ? `refusing to pass ${JSON.stringify(file)} through cmd: it contains % or "` : undefined;
}
/** Open `file`; a terminal editor is waited for. Resolves with a reason when it cannot. */
export function openInEditor(choice, file, platform = process.platform) {
    return new Promise((resolve) => {
        try {
            if (choice.kind === "command") {
                const unsafe = unsafeForShell(file, platform);
                if (unsafe)
                    return resolve(unsafe);
                const child = spawn(`${choice.command} ${quoted(file, platform)}`, { shell: true, stdio: "inherit" });
                child.once("error", (e) => resolve(`${choice.command}: ${e.message}`));
                child.once("close", (code) => resolve(code === 0 || code === null ? undefined : `${choice.command} exited with ${code}`));
                return;
            }
            // `code` is a .cmd on Windows, which node only starts through a shell.
            const viaShell = platform === "win32" && choice.kind === "code" && /\.(cmd|bat)$/i.test(choice.bin);
            const unsafe = viaShell ? unsafeForShell(file, platform) : undefined;
            if (unsafe)
                return resolve(unsafe);
            const [bin, args] = choice.kind === "code"
                ? viaShell
                    ? [`"${choice.bin}"`, [quoted(file, platform)]]
                    : [choice.bin, [file]]
                : [choice.file, choice.args];
            const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true, shell: viaShell });
            child.once("error", (e) => resolve(`${bin}: ${e.message}`));
            child.once("spawn", () => {
                child.unref();
                resolve(undefined);
            });
        }
        catch (e) {
            resolve(e?.message ?? String(e));
        }
    });
}
//# sourceMappingURL=editor.js.map