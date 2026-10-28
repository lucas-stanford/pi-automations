import { type WhichFn } from "./interpreters.js";
import type { ModelResolver } from "./core/contracts.js";
import type { Trust } from "./trust.js";
import type { AutomationState, Config, Discovered, Located, Status } from "./types.js";
export interface StatusDeps {
    trust: Trust;
    config: Config;
    stateDir: string;
    now: Date;
    resolveModel?: ModelResolver;
    platform?: NodeJS.Platform;
    which?: WhichFn;
    /** Injected for tests. */
    locale?: string;
}
/** The part of the decision that needs only the file and the consent record. Pure. */
export declare function decideState(d: Discovered, armedByTrust: boolean, offReason?: string): {
    state: AutomationState;
    reason?: string;
};
export declare function computeStatuses(found: Discovered[], deps: StatusDeps): Promise<Status[]>;
/** The interpreter display commands, recorded at arm time. */
export declare function interpreterMap(l: Located, platform?: NodeJS.Platform, which?: WhichFn): Record<string, string>;
/** `20m` / `10m (host default)` for the consent preview and `check`. */
export declare function timeoutText(s: Status, config: Config): string;
