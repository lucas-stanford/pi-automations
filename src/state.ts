// Tick bookkeeping in state.json. The tick owns `claimed`, `lastTickAt`, `lastTickBy` and
// `watches`; commands own the rest and write through `update`, so neither undoes the other.

import path from "node:path";

import { writeJsonAtomic, readJson } from "./jsonfile.js";
import { ensureDir, statePaths, stateDir } from "./paths.js";
import type { StateFile, TickSource, WatchState } from "./types.js";

export class State {
  private readonly file: string;
  lastTickAt?: string;
  lastTickBy?: TickSource;
  claimed: Record<string, string> = {};
  roots: string[] = [];
  watches: Record<string, WatchState> = {};
  /** key -> ISO of when a person paused that automation's watch. */
  pausedWatches: Record<string, string> = {};
  /** key -> run id of the failed run dismissed from the triage list. */
  dismissedRuns: Record<string, string> = {};
  /** The command-owned fields this copy has changed since it last loaded or saved. */
  private changedHere = new Set<"roots" | "pausedWatches" | "dismissedRuns">();

  constructor(dir: string = stateDir()) {
    ensureDir(dir);
    this.file = statePaths(dir).state;
    this.load();
  }

  load(): void {
    const raw = readJson<StateFile>(this.file);
    this.changedHere.clear();
    if (!raw || raw.version !== 1) {
      this.lastTickAt = undefined;
      this.lastTickBy = undefined;
      this.claimed = {};
      this.roots = [];
      this.watches = {};
      this.pausedWatches = {};
      this.dismissedRuns = {};
      return;
    }
    this.lastTickAt = typeof raw.lastTickAt === "string" ? raw.lastTickAt : undefined;
    this.lastTickBy = raw.lastTickBy === "job" || raw.lastTickBy === "serve" || raw.lastTickBy === "cli" ? raw.lastTickBy : undefined;
    this.claimed = raw.claimed && typeof raw.claimed === "object" ? { ...raw.claimed } : {};
    this.roots = readRoots(raw.roots);
    this.watches = readWatches(raw.watches);
    this.pausedWatches = readPaused(raw.pausedWatches);
    this.dismissedRuns = readDismissed(raw.dismissedRuns);
  }

  save(): void {
    // What a command changed since this copy was read wins over this copy's stale view of it.
    const disk = readJson<StateFile>(this.file);
    if (disk && disk.version === 1) {
      if (!this.changedHere.has("roots")) this.roots = readRoots(disk.roots);
      if (!this.changedHere.has("pausedWatches")) this.pausedWatches = readPaused(disk.pausedWatches);
      if (!this.changedHere.has("dismissedRuns")) this.dismissedRuns = readDismissed(disk.dismissedRuns);
    }
    const out: StateFile = { version: 1, claimed: this.claimed, roots: this.roots };
    if (this.lastTickAt) out.lastTickAt = this.lastTickAt;
    if (this.lastTickBy) out.lastTickBy = this.lastTickBy;
    if (Object.keys(this.watches).length > 0) out.watches = this.watches;
    if (Object.keys(this.pausedWatches).length > 0) out.pausedWatches = this.pausedWatches;
    if (Object.keys(this.dismissedRuns).length > 0) out.dismissedRuns = this.dismissedRuns;
    writeJsonAtomic(this.file, out);
    this.changedHere.clear();
  }

  // Claim a cron instant; false when already claimed (two ticks never start the same run).
  claim(key: string, iso: string): boolean {
    if (this.claimed[key] === iso) return false;
    this.claimed[key] = iso;
    return true;
  }

  claimOf(key: string): string | undefined {
    return this.claimed[key];
  }

  // Re-read, claim and persist, for a process racing the tick.
  claimPersisted(key: string, iso: string): boolean {
    this.load();
    const changed = this.claim(key, iso);
    if (changed) this.save();
    return changed;
  }

  // Re-read, change and persist, for a writer that held its copy a while.
  update(change: (state: State) => void): void {
    this.load();
    change(this);
    this.save();
  }

  registerRoot(repoRoot: string): void {
    const resolved = path.resolve(repoRoot);
    if (!this.roots.includes(resolved)) {
      this.roots.push(resolved);
      this.roots.sort();
      this.changedHere.add("roots");
    }
  }

  unregisterRoot(repoRoot: string): void {
    const resolved = path.resolve(repoRoot);
    if (!this.roots.includes(resolved)) return;
    this.roots = this.roots.filter((r) => r !== resolved);
    this.changedHere.add("roots");
  }

  // Forget claims and checks for automations that no longer exist.
  pruneClaims(liveKeys: Iterable<string>): string[] {
    const live = new Set(liveKeys);
    const dropped: string[] = [];
    for (const key of Object.keys(this.claimed)) {
      if (!live.has(key)) {
        delete this.claimed[key];
        dropped.push(key);
      }
    }
    for (const key of Object.keys(this.watches)) {
      if (!live.has(key)) delete this.watches[key];
    }
    return dropped;
  }

  watchOf(key: string): WatchState | undefined {
    return this.watches[key];
  }

  recordWatch(key: string, check: WatchState): void {
    this.watches[key] = check;
  }

  /** ISO of when this automation's watch was paused, or undefined while it is running. */
  watchPausedAt(key: string): string | undefined {
    return this.pausedWatches[key];
  }

  // Pause this watch; false when already paused.
  pauseWatch(key: string, at: Date): boolean {
    if (this.pausedWatches[key]) return false;
    this.pausedWatches = { ...this.pausedWatches, [key]: at.toISOString() };
    this.changedHere.add("pausedWatches");
    return true;
  }

  /** Run this automation's watch again from the next tick. Returns false when it was not paused. */
  resumeWatch(key: string): boolean {
    if (!this.pausedWatches[key]) return false;
    const { [key]: _resumed, ...rest } = this.pausedWatches;
    this.pausedWatches = rest;
    this.changedHere.add("pausedWatches");
    return true;
  }

  dismissedRunOf(key: string): string | undefined {
    return this.dismissedRuns[key];
  }

  dismissRun(key: string, runId: string): boolean {
    if (this.dismissedRuns[key] === runId) return false;
    this.dismissedRuns = { ...this.dismissedRuns, [key]: runId };
    this.changedHere.add("dismissedRuns");
    return true;
  }
}

function readRoots(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string") : [];
}

function readPaused(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === "string" && !Number.isNaN(Date.parse(at))) out[key] = at;
  }
  return out;
}

function readDismissed(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, runId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof runId === "string" && runId.length > 0) out[key] = runId;
  }
  return out;
}

/** The watch map from disk, keeping only entries that have the one field everything else needs. */
function readWatches(raw: unknown): Record<string, WatchState> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, WatchState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const w = value as Partial<WatchState>;
    if (typeof w.checkedAt !== "string") continue;
    out[key] = { ...w, checkedAt: w.checkedAt, durationMs: typeof w.durationMs === "number" ? w.durationMs : 0 };
  }
  return out;
}

/** The last check of one automation's watch, read without taking any lock. */
export function readWatchState(dir: string, key: string): WatchState | undefined {
  return readWatches(readJson<StateFile>(statePaths(dir).state)?.watches)[key];
}

/** Every automation's last watch check, read once for a whole listing. */
export function readWatchStates(dir: string): Record<string, WatchState> {
  return readWatches(readJson<StateFile>(statePaths(dir).state)?.watches);
}

/** Every paused watch, key -> since when, read without taking any lock. */
export function readPausedWatches(dir: string): Record<string, string> {
  return readPaused(readJson<StateFile>(statePaths(dir).state)?.pausedWatches);
}

/** Every dismissed failed run, key -> run id, read without taking any lock. */
export function readDismissedRuns(dir: string): Record<string, string> {
  return readDismissed(readJson<StateFile>(statePaths(dir).state)?.dismissedRuns);
}
