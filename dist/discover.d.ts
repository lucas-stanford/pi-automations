import { type HostRoots } from "./paths.js";
import type { Discovered, Located, Root } from "./types.js";
export interface DiscoverOptions {
    /** Working directory used for repository-scope discovery. Omit for user scope only. */
    cwd?: string;
    /** Registered repository roots, used at tick time when there is no meaningful cwd. */
    extraRepoRoots?: string[];
    /** The user directories this host uses. Omitted means the ambient answer. */
    host?: HostRoots;
    /** Injected for tests. */
    roots?: Root[];
}
export declare function discover(opts?: DiscoverOptions): Discovered[];
/** Only the automations that parsed. */
export declare function located(found: Discovered[]): Located[];
/** Find one discovered automation by key. */
export declare function byKey(found: Discovered[], key: string): Discovered | undefined;
