// Edit without a plugin: `$VISUAL`, `$EDITOR`, VS Code or the OS opener (no terminal editor in pi).

import { spawn } from "node:child_process";

import { whichSync } from "../interpreters.js";
import { openCommand } from "../report.js";

export type EditorChoice =
  | { kind: "command"; command: string }
  | { kind: "code"; bin: string }
  | { kind: "opener"; file: string; args: string[] };

export function chooseEditor(args: {
  file: string;
  /** `cli`: `pa edit` in a shell. `host`: inside pi. */
  where: "cli" | "host";
  env?: NodeJS.ProcessEnv;
  which?: (bin: string) => string | undefined;
  platform?: NodeJS.Platform;
}): EditorChoice {
  const env = args.env ?? process.env;
  const which = args.which ?? ((bin: string) => whichSync(bin));
  if (args.where === "cli") {
    for (const name of ["VISUAL", "EDITOR"] as const) {
      const command = env[name]?.trim();
      if (command) return { kind: "command", command };
    }
  }
  const code = which("code");
  if (code) return { kind: "code", bin: code };
  const opener = openCommand(args.file, args.platform);
  return { kind: "opener", file: opener.file, args: opener.args };
}

/** How the choice is said to the person: `opened daily in $EDITOR (vim)`. */
export function describeEditor(choice: EditorChoice): string {
  if (choice.kind === "command") return choice.command;
  if (choice.kind === "code") return "VS Code";
  return "the app your system opens .md files with";
}

function quoted(file: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `"${file}"` : `'${file.replace(/'/g, `'\\''`)}'`;
}

/** Why `file` cannot go through cmd: `%NAME%` expands and `"` ends quoting. */
export function unsafeForShell(file: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return undefined;
  return /[%"]/.test(file) ? `refusing to pass ${JSON.stringify(file)} through cmd: it contains % or "` : undefined;
}

/** Open `file`; a terminal editor is waited for. Resolves with a reason when it cannot. */
export function openInEditor(choice: EditorChoice, file: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      if (choice.kind === "command") {
        const unsafe = unsafeForShell(file, platform);
        if (unsafe) return resolve(unsafe);
        const child = spawn(`${choice.command} ${quoted(file, platform)}`, { shell: true, stdio: "inherit" });
        child.once("error", (e) => resolve(`${choice.command}: ${e.message}`));
        child.once("close", (code) => resolve(code === 0 || code === null ? undefined : `${choice.command} exited with ${code}`));
        return;
      }
      // `code` is a .cmd on Windows, which node only starts through a shell.
      const viaShell = platform === "win32" && choice.kind === "code" && /\.(cmd|bat)$/i.test(choice.bin);
      const unsafe = viaShell ? unsafeForShell(file, platform) : undefined;
      if (unsafe) return resolve(unsafe);
      const [bin, args] =
        choice.kind === "code"
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
    } catch (e) {
      resolve((e as Error)?.message ?? String(e));
    }
  });
}
