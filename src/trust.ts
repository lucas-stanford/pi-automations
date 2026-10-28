// Consent: every automation, user or repository, needs explicit consent for its exact bytes.
//
// Several processes share trust.json: the tick, every pi session, `pa` commands and runs. Each
// keeps a copy, and a copy can be seconds old by the time it writes. So nothing ever writes a
// whole copy back: every change re-reads the file under a lock and applies only its own change.
// Otherwise a tick that loaded before `pa arm` would put the old record back, and the arm would be
// lost without a word.

import { existsSync } from "node:fs";
import path from "node:path";

import { digestOf, fileHashesOf } from "./digest.js";
import { writeJsonAtomic, readJson } from "./jsonfile.js";
import { LockTimeoutError, withFileLock } from "./locks.js";
import { ensureDir, statePaths, stateDir } from "./paths.js";
import type { Located, TrustFile, TrustRecord } from "./types.js";

const EMPTY: TrustFile = { version: 1, records: {} };

export class Trust {
  private readonly file: string;
  private readonly lockFile: string;
  private data: TrustFile = { version: 1, records: {} };
  /** Sightings not written yet, key -> ISO: merged into whatever is on disk when saved. */
  private seen = new Map<string, string>();

  constructor(dir: string = stateDir()) {
    ensureDir(dir);
    this.file = statePaths(dir).trust;
    this.lockFile = statePaths(dir).trustLock;
    this.load();
  }

  load(): void {
    this.data = readTrust(this.file);
  }

  /**
   * Write the sightings `touch` noted. They only move `lastSeenAt` forward on records still on
   * disk: a sighting never brings back a record someone disarmed, nor replaces one re-armed since.
   * Best effort: a sighting can wait for the next save, so a busy lock skips it.
   */
  save(): void {
    if (this.seen.size === 0) return;
    try {
      this.change(() => {});
    } catch (e) {
      if (!(e instanceof LockTimeoutError)) throw e;
    }
  }

  record(l: Located): TrustRecord | undefined {
    return this.data.records[l.key];
  }

  /** All records, for `pa watcher status` and the sweep. */
  all(): TrustRecord[] {
    return Object.values(this.data.records);
  }

  // Consented right now? Anything else is `off`.
  isArmed(l: Located, now: Date): boolean {
    return this.offReason(l, now) === undefined;
  }

  /** Why an automation is not armed: never armed, changed (naming files) or, in a repository, expired. */
  offReason(l: Located, now: Date): string | undefined {
    const rec = this.data.records[l.key];
    if (!rec) return `not armed — /automations arm ${l.automation.name}`;

    // User consent never expires, even on a record written with an expiry.
    if (l.root.scope === "repository" && rec.expiresAt && Date.parse(rec.expiresAt) <= now.getTime()) {
      return `consent expired — /automations arm ${l.automation.name}`;
    }

    const { changed, files } = this.changedSinceArmed(l);
    if (changed) {
      return `changed since armed: ${files.join(", ")} — /automations arm ${l.automation.name}`;
    }

    return undefined;
  }

  /** What changed since consent, by file, using the per-file hashes stored at arm time. */
  changedSinceArmed(l: Located): { changed: boolean; files: string[] } {
    const rec = this.data.records[l.key];
    if (!rec) return { changed: true, files: [] };

    const now = fileHashesOf(l);

    if (rec.files) {
      const files: string[] = [];
      for (const [rel, hash] of Object.entries(rec.files)) {
        if (now[rel] !== hash) files.push(rel);
      }
      for (const rel of Object.keys(now)) {
        if (!(rel in rec.files)) files.push(rel);
      }
      files.sort();
      return { changed: files.length > 0, files };
    }

    // Older records without per-file hashes can only say "changed".
    let current: string;
    try {
      current = digestOf(l);
    } catch {
      return { changed: true, files: ["AUTOMATION.md"] };
    }
    return current === rec.digest
      ? { changed: false, files: [] }
      : { changed: true, files: ["AUTOMATION.md or a hook script"] };
  }

  /** Record consent. `digest` and `interpreters` are what the person was actually shown. */
  arm(
    l: Located,
    digest: string,
    interpreters: Record<string, string>,
    now: Date,
    /** Repository consent only; user consent lasts until the bytes change or it is disarmed. */
    expiryMs: number,
  ): void {
    const iso = now.toISOString();
    const rec: TrustRecord = {
      key: l.key,
      dir: l.dir,
      repoRoot: l.repoRoot ?? "",
      digest,
      armedAt: iso,
      lastSeenAt: iso,
      interpreters,
      files: fileHashesOf(l),
    };
    if (expiryMs > 0 && l.root.scope === "repository") {
      rec.expiresAt = new Date(now.getTime() + expiryMs).toISOString();
    }
    this.change((records) => {
      records[l.key] = rec;
    });
  }

  /** Withdraw consent. The automation drops to `off`; nothing else about it changes. */
  disarm(l: Located | { key: string }): void {
    this.change((records) => {
      delete records[l.key];
    });
  }

  /** Keep consent across a one-line `enabled:` edit made by `enable`/`disable`; nothing else. */
  repin(l: Located): void {
    if (!this.data.records[l.key]) return;
    const digest = digestOf(l);
    const files = fileHashesOf(l);
    this.change((records) => {
      const rec = records[l.key];
      if (!rec) return;
      rec.digest = digest;
      rec.files = files;
    });
  }

  /** Note that the directory still exists, so the sweep does not reclaim a live consent. */
  touch(l: Located, now: Date): void {
    const rec = this.data.records[l.key];
    if (!rec) return;
    rec.lastSeenAt = now.toISOString();
    this.seen.set(l.key, rec.lastSeenAt);
  }

  /** Drop consent for automations whose directory is gone and has not been seen for a while. */
  sweep(now: Date, unseenForMs: number): string[] {
    const reclaimable = (rec: TrustRecord): boolean => {
      if (existsSync(path.join(rec.dir, "AUTOMATION.md"))) return false;
      const lastSeen = Date.parse(rec.lastSeenAt);
      return !Number.isNaN(lastSeen) && now.getTime() - lastSeen >= unseenForMs;
    };
    if (!Object.values(this.data.records).some(reclaimable)) return [];
    const dropped: string[] = [];
    // Decided again on what is on disk now: another process may have seen or re-armed it since.
    this.change((records) => {
      for (const [key, rec] of Object.entries(records)) {
        if (!reclaimable(rec)) continue;
        delete records[key];
        dropped.push(key);
      }
    });
    return dropped;
  }

  /**
   * Re-read trust.json under its lock, apply this copy's pending sightings and then `edit`, write
   * it, and keep the result as this copy. The only way anything here writes.
   */
  private change(edit: (records: Record<string, TrustRecord>) => void): void {
    withFileLock(this.lockFile, () => {
      const disk = readTrust(this.file);
      for (const [key, iso] of this.seen) {
        const rec = disk.records[key];
        if (rec && !(Date.parse(rec.lastSeenAt) >= Date.parse(iso))) rec.lastSeenAt = iso;
      }
      edit(disk.records);
      writeJsonAtomic(this.file, disk);
      this.data = disk;
      this.seen.clear();
    });
  }
}

function readTrust(file: string): TrustFile {
  const raw = readJson<TrustFile>(file);
  if (!raw || typeof raw !== "object" || raw.version !== 1 || typeof raw.records !== "object" || raw.records === null) {
    return { ...EMPTY, records: {} };
  }
  return { version: 1, records: { ...raw.records } };
}
