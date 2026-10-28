import type { Root, Scope } from "./types.js";
/** Called by the extension with pi's own `getAgentDir()` so both processes agree. */
export declare function setAgentDir(dir: string | undefined): void;
/** pi's agent directory, e.g. `~/.pi/agent`. */
export declare function agentDir(): string;
/** All plugin state: mode 0700, never inside a repository. */
export declare function stateDir(): string;
/** mkdir -p with 0700, tolerating an existing directory. */
export declare function ensureDir(dir: string): void;
/**
 * The directories a host decides, so a non-pi host or a test needs no particular home directory.
 */
export interface HostRoots {
    /** The user's home directory. `~/.agents/automations` is built from this. */
    readonly home: string;
    /** pi's agent directory, or whatever a non-pi host uses in its place. */
    readonly agentDir: string;
}
/** The ambient answer: the environment and the documented defaults. */
export declare function ambientHostRoots(): HostRoots;
/** User-scope roots, nearest first. The order and `kind` labels are part of the state keys. */
export declare function userRootsFor(host: HostRoots): Root[];
/** User-scope roots for this process. */
export declare function userRoots(): Root[];
/** Walk up from `cwd` to the first directory with a `.git` entry (clone or worktree). */
export declare function findRepoRoot(cwd: string): string | undefined;
/** Repository-scope roots from `cwd` up to the git root, nearest first, existing only. */
export declare function repoRoots(cwd: string): {
    repoRoot?: string;
    roots: Root[];
};
/** The roots contributed by an explicitly registered repository root (used at tick time). */
export declare function rootsForRegistered(repoRoot: string): Root[];
/**
 * Stable identity built from `path.resolve`, so different spellings of a directory give one key.
 */
export declare function key(scope: Scope, rootPath: string, name: string): string;
/** Filesystem-safe, collision-resistant name for per-automation files. */
export declare function slug(k: string): string;
/** The installed package root — `dist/..`, which is also `src/..` when running from source. */
export declare function packageDir(): string;
/** Sub-paths under the state directory. Kept here so nothing else spells them. */
export declare function statePaths(dir?: string): {
    dir: string;
    config: string;
    trust: string;
    state: string;
    detached: string;
    runs: string;
    locks: string;
    logs: string;
    reports: string;
    /** One small events file per tracked run while it is going. See `src/progress.ts`. */
    progress: string;
    tickLock: string;
    /** Held for each read-change-write of trust.json. See `src/trust.ts`. */
    trustLock: string;
};
/** One automation's run log: a background run's stdout and stderr. Always build the path here. */
export declare function fireLogPath(stateDir: string, key: string): string;
/** Replace the home directory prefix with `~` for display. Never used to build a real path. */
export declare function tildify(p: string, home?: string): string;
