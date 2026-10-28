import type { JobPaths, PlatformBackend } from "./types.js";
export declare const UNIT = "pi-automations-tick";
export declare function serviceUnit(paths: JobPaths): string;
export declare function timerUnit(): string;
/** The crontab line used when there is no systemd. */
export declare function crontabLine(paths: JobPaths): string;
export declare const linuxBackend: PlatformBackend;
