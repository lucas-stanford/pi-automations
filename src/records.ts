// Run history: one JSON line per terminal outcome. Torn lines are skipped on read.

import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { ensureDir, fireLogPath, slug, statePaths } from "./paths.js";
import type { Config, FireEvent, RunRecord } from "./types.js";

/** `20260917-140047-3fa2` — sortable, readable, and unique enough within a second. */
export function newRunId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function recordsFile(dir: string, key: string): string {
  return path.join(statePaths(dir).runs, `${slug(key)}.jsonl`);
}

/** Append one record (repairing a torn last line first), then rotate if needed. */
export function appendRecord(dir: string, rec: RunRecord, retention?: Config["retention"]): void {
  const file = recordsFile(dir, rec.key);
  appendJsonLine(file, rec);
  if (retention) rotateIfNeeded(dir, rec.key, retention);
}

/** Append one event to an automation's fire log, with the same torn-line repair. Throws. */
export function appendFireEvent(dir: string, key: string, event: FireEvent): void {
  appendJsonLine(fireLogPath(dir, key), event);
}

function appendJsonLine(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const prefix = endsWithoutNewline(file) ? "\n" : "";
  appendFileSync(file, `${prefix}${JSON.stringify(value)}\n`);
}

/** True when the file exists, is non-empty, and its last byte is not a newline. */
function endsWithoutNewline(file: string): boolean {
  let fd: number | undefined;
  try {
    const { size } = statSync(file);
    if (size === 0) return false;
    fd = openSync(file, "r");
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

/** The last `n` records, oldest first. Unparsable lines are skipped. */
export function readRecords(dir: string, key: string, n = 50): RunRecord[] {
  const lines = readLines(recordsFile(dir, key));
  const out: RunRecord[] = [];
  for (const line of lines.slice(-Math.max(0, n))) {
    try {
      out.push(JSON.parse(line) as RunRecord);
    } catch {
      // Torn line — skip it.
    }
  }
  return out;
}

export function lastRecord(dir: string, key: string): RunRecord | undefined {
  const recent = readRecords(dir, key, 1);
  return recent[recent.length - 1];
}

/** Trim a log that has grown past `maxLinesPerAutomation` down to `keepLines`, atomically. */
export function rotateIfNeeded(dir: string, key: string, retention: Config["retention"]): void {
  const file = recordsFile(dir, key);
  const lines = readLines(file);
  if (lines.length <= retention.maxLinesPerAutomation) return;

  const keep = lines.slice(-retention.keepLines);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, keep.length ? `${keep.join("\n")}\n` : "");
  renameSync(tmp, file);
}
