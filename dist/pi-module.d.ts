/** The one package name this module will ever load. */
export declare const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** Env var carrying an exact path from a parent that already knows where pi is. */
export declare const PI_MODULE_ENV = "PI_AUTOMATIONS_PI_MODULE";
export type PiLocation = {
    /** Directory of the pi package — the one containing its `package.json`. */
    dir: string;
    /** How it was found; recorded so a run can explain itself. */
    via: "env" | "config" | "resolve" | "path" | "npm-root";
};
export type FindPiOptions = {
    env?: NodeJS.ProcessEnv;
    /** `piModule` from config, when the operator set one. */
    configured?: string | undefined;
    /** Injected for tests; defaults to running `npm root -g`. */
    npmRoot?: () => string | undefined;
    /** Injected for tests; defaults to looking up `pi` on PATH. */
    which?: (cmd: string) => string | undefined;
};
/** Is this directory really the pi package? Checked against `package.json`, never the path. */
export declare function isPiPackage(dir: string): boolean;
/** Where is pi? `undefined` when no copy can be proven. */
export declare function findPiModule(opts?: FindPiOptions): PiLocation | undefined;
/** What a person sees when pi cannot be found: what is wrong, then the fix. */
export declare const PI_MISSING_MESSAGE: string;
/** Import pi from wherever it is, cached per resolved directory. */
export declare function importPi(opts?: FindPiOptions): Promise<Record<string, unknown>>;
/** `22.19.0` from an `engines.node` of `>=22.19.0`; undefined for any other form. */
export declare function minimumNode(range: unknown): string | undefined;
/** True when version `have` is below `need`. Both are `major.minor.patch`. */
export declare function olderThan(have: string, need: string): boolean;
/** Test seam — forget the cached module. */
export declare function resetPiCache(): void;
