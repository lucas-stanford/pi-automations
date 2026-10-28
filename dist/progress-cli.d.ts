import { type ProgressSnapshot } from "./progress.js";
export declare const IN_RUN_VERBS: ReadonlySet<string>;
export declare const PA_EXIT: {
    readonly ok: 0;
    readonly usage: 1;
    readonly refused: 2;
};
export interface CliOutput {
    code: number;
    stdout: string;
    stderr: string;
}
/**
 * `pa status` for a person. Nothing a chart or an agent wrote reaches the terminal as a control.
 */
export declare function statusLines(s: ProgressSnapshot): string[];
/** Run one in-run command. Never throws; never exits the process. */
export declare function progressCli(argv: readonly string[], env?: NodeJS.ProcessEnv, opts?: {
    stateDir?: string;
    now?: Date;
}): CliOutput;
/** The in-run half of `pa help`. */
export declare function inRunHelpLines(): string[];
