import type { ModelResolver } from "../core/contracts.js";
import { type HostRoots } from "../paths.js";
import type { RunRecord } from "../types.js";
import type { HostServices, RunSummary } from "./types.js";
/** How many runs `history` answers by default, and at most. */
export declare const HISTORY_LIMIT = 200;
export declare const HISTORY_MAX = 1000;
export interface HostServicesOptions {
    stateDir: string;
    /** Where repository automations are discovered from. Read on every call: pi's cwd can change. */
    cwd: () => string;
    home?: string;
    host?: HostRoots;
    now?: () => Date;
    /** pi's model check and catalog. Absent: models are not checked and the catalog is empty. */
    models?: {
        resolver(): Promise<ModelResolver | undefined>;
        choices(cwd: string): Promise<{
            enabled: {
                value: string;
                name?: string;
            }[];
            available: {
                value: string;
                name?: string;
            }[];
        }>;
    };
}
export declare function createHostServices(opts: HostServicesOptions): HostServices;
export declare function runSummary(rec: RunRecord): RunSummary;
