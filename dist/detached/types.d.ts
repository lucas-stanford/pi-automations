/** The shape every OS backend implements, so `index.ts` only picks one. */
import type { EnvSnapshot } from "./env.js";
export interface JobPaths {
    /** The plist / unit / XML this back-end writes. */
    jobFile: string;
    /** Windows only: the wscript launcher that keeps the console window hidden. */
    shimPath?: string;
    nodePath: string;
    packageDir: string;
    tickPath: string;
    env: EnvSnapshot;
    /** Linux only: the companion timer unit. */
    timerFile?: string;
    logFile?: string;
}
export interface Command {
    file: string;
    args: string[];
}
export interface PlatformBackend {
    method: "schtasks" | "launchd" | "systemd" | "crontab";
    jobName: string;
    files(paths: JobPaths): Array<{
        path: string;
        kind: "job" | "shim" | "timer";
    }>;
    write(paths: JobPaths): void;
    installCommand(paths: JobPaths): Command;
    uninstallCommand(paths: JobPaths): Command;
    queryCommand(paths: JobPaths): Command;
    testCommand(paths: JobPaths): Command;
    defaultPaths(stateDir: string, nodePath: string, packageDir: string): JobPaths;
}
