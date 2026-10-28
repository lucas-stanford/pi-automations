import { type ChildProcess } from "node:child_process";
import type { RunScript } from "../core/contracts.js";
/** Kill a process tree: a process group on POSIX, `taskkill /T` on Windows. */
export declare function killTree(child: ChildProcess): void;
/** A null close code means the child was signalled; read as 0, as hooks always have. */
export declare function exitCodeForClose(code: number | null): number;
/** The local executor: an ordinary child process on this machine. */
export declare const runLocalScript: RunScript;
