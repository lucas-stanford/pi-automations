export declare function paLauncherDir(stateDir: string): string;
/**
 * Write the launchers once per process; a failure leaves the run without `pa`, never without a run.
 */
export declare function ensurePaLauncher(stateDir: string, opts?: {
    node?: string;
    script?: string;
}): string | undefined;
/**
 * `{ PATH: <launchers>;<PATH> }` under the name this process already uses (Windows keeps `Path`).
 */
export declare function paPathOverlay(stateDir: string, env?: NodeJS.ProcessEnv): Record<string, string>;
