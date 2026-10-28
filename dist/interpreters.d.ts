export interface InterpreterOk {
    ok: true;
    /** Absolute path of the executable to spawn. */
    file: string;
    /** Arguments, already including the script path. */
    args: string[];
    /** What the consent preview shows, e.g. `/usr/bin/python3 scripts/post.py`. */
    display: string;
}
export interface InterpreterFail {
    ok: false;
    reason: string;
}
export type InterpreterResult = InterpreterOk | InterpreterFail;
export type WhichFn = (bin: string) => string | undefined;
/** Find an executable on PATH by reading PATH and PATHEXT, without spawning `which`/`where`. */
export declare function whichSync(bin: string, platform?: NodeJS.Platform): string | undefined;
/** True when the file carries any executable bit. POSIX only — Windows has no such concept. */
export declare function hasExecutableBit(p: string): boolean;
/** Decide how to run `absScript`. `relPath` is only for display. */
export declare function resolveInterpreter(absScript: string, platform?: NodeJS.Platform, which?: WhichFn, relPath?: string): InterpreterResult;
