import type { Located, TrustRecord } from "./types.js";
export declare class Trust {
    private readonly file;
    private readonly lockFile;
    private data;
    /** Sightings not written yet, key -> ISO: merged into whatever is on disk when saved. */
    private seen;
    constructor(dir?: string);
    load(): void;
    /**
     * Write the sightings `touch` noted. They only move `lastSeenAt` forward on records still on
     * disk: a sighting never brings back a record someone disarmed, nor replaces one re-armed since.
     * Best effort: a sighting can wait for the next save, so a busy lock skips it.
     */
    save(): void;
    record(l: Located): TrustRecord | undefined;
    /** All records, for `pa watcher status` and the sweep. */
    all(): TrustRecord[];
    isArmed(l: Located, now: Date): boolean;
    /** Why an automation is not armed: never armed, changed (naming files) or, in a repository, expired. */
    offReason(l: Located, now: Date): string | undefined;
    /** What changed since consent, by file, using the per-file hashes stored at arm time. */
    changedSinceArmed(l: Located): {
        changed: boolean;
        files: string[];
    };
    /** Record consent. `digest` and `interpreters` are what the person was actually shown. */
    arm(l: Located, digest: string, interpreters: Record<string, string>, now: Date, 
    /** Repository consent only; user consent lasts until the bytes change or it is disarmed. */
    expiryMs: number): void;
    /** Withdraw consent. The automation drops to `off`; nothing else about it changes. */
    disarm(l: Located | {
        key: string;
    }): void;
    /** Keep consent across a one-line `enabled:` edit made by `enable`/`disable`; nothing else. */
    repin(l: Located): void;
    /** Note that the directory still exists, so the sweep does not reclaim a live consent. */
    touch(l: Located, now: Date): void;
    /** Drop consent for automations whose directory is gone and has not been seen for a while. */
    sweep(now: Date, unseenForMs: number): string[];
    /**
     * Re-read trust.json under its lock, apply this copy's pending sightings and then `edit`, write
     * it, and keep the result as this copy. The only way anything here writes.
     */
    private change;
}
