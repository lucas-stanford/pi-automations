import type { DetachedFile } from "../types.js";
import type { Command, PlatformBackend } from "./types.js";
export { snapshotEnv, SECRET_NAME } from "./env.js";
export { taskXml, tickVbs } from "./windows.js";
export { plist } from "./macos.js";
export { serviceUnit, timerUnit, crontabLine } from "./linux.js";
export { serve } from "./serve.js";
export type { JobPaths, PlatformBackend } from "./types.js";
export declare function backendFor(platform?: NodeJS.Platform): PlatformBackend | undefined;
export declare function installed(dir?: string): boolean;
/** What the installed job was registered against, or undefined when there is none. */
export declare function installedPaths(dir?: string): DetachedFile | undefined;
export interface InstallResult {
    ok: boolean;
    lines: string[];
    method?: DetachedFile["method"];
}
export declare function install(options: {
    dir?: string;
    platform?: NodeJS.Platform;
    now?: Date;
    /** Injected in tests so nothing is registered and nothing is waited for. */
    exec?: (cmd: Command) => Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    verifySeconds?: number;
    /** Which scheduler registers the job; omitted uses this platform's. */
    backend?: PlatformBackend;
}): Promise<InstallResult>;
export declare function uninstall(options: {
    dir?: string;
    platform?: NodeJS.Platform;
    purge?: boolean;
    exec?: (cmd: Command) => Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    backend?: PlatformBackend;
}): Promise<InstallResult>;
export interface DetachedStatus {
    installed: boolean;
    lines: string[];
    stale: boolean;
}
export declare function status(options: {
    dir?: string;
    platform?: NodeJS.Platform;
    now?: Date;
    exec?: (cmd: Command) => Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    backend?: PlatformBackend;
}): Promise<DetachedStatus>;
/** Should the tick remove its own job? Returns the reason, or undefined when the job is valid. */
export declare function selfUnregisterReason(record: DetachedFile | undefined, exists?: (p: string) => boolean): string | undefined;
/** Remove a job whose package is gone (after `pi remove`). Called by `bin/tick.js`. */
export declare function selfUnregister(reason: string, options?: {
    dir?: string;
    exec?: (cmd: Command) => Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    log?: (line: string) => void;
}): Promise<boolean>;
/** `pa watcher <verb>` (and its old name, `pa detached <verb>`). */
export declare function detachedCli(argv: string[], options: {
    stateDir: string;
    json?: boolean;
    /** The scheduler this host composed; omitted uses this platform's. */
    backend?: PlatformBackend;
}): Promise<{
    lines: string[];
    exitCode: number;
}>;
