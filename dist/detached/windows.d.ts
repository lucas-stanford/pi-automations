import type { JobPaths, PlatformBackend } from "./types.js";
export declare const TASK_NAME = "pi-automations\\tick";
export declare function taskXml(paths: JobPaths): string;
/** The hidden launcher. `0` is the window style and `False` means do not wait. */
export declare function tickVbs(paths: JobPaths): string;
export declare const windowsBackend: PlatformBackend;
