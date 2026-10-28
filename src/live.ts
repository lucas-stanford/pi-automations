// A live view of a run, written by the run itself in pi's session-entry shape, because pi writes
// its session file only per completed turn. Never throws or blocks.

import { appendFileSync, rmSync } from "node:fs";
import path from "node:path";

import { ensureDir, slug, statePaths } from "./paths.js";

/** Where a run's live view lives. Beside the locks, because it has the same lifetime. */
export function liveFile(dir: string, key: string): string {
  return path.join(statePaths(dir).locks, `${slug(key)}.live`);
}

/** How often streaming text is flushed: often enough to read as live, rarely enough to be free. */
export const PARTIAL_MS = 1000;

/** Bounded, so a very long reply cannot grow the file without limit. */
const MAX_PARTIAL_CHARS = 2000;

export class LiveWriter {
  private lastPartialAt = 0;
  private lastPartial = "";
  private closed = false;

  constructor(private readonly file: string) {
    try {
      ensureDir(path.dirname(file));
    } catch {
      // Then nothing can be written, and every method below does nothing.
    }
  }

  private write(obj: unknown): void {
    if (this.closed) return;
    try {
      appendFileSync(this.file, `${JSON.stringify(obj)}\n`);
    } catch {
      // A view that cannot be written is a view nobody sees. It is not a run that failed.
    }
  }

  /** Text still arriving: throttled, marked `partial`, and skipped when unchanged. */
  partial(text: string, now = Date.now()): void {
    if (text.trim() === "") return;
    if (text === this.lastPartial) return;
    if (now - this.lastPartialAt < PARTIAL_MS) return;
    this.lastPartialAt = now;
    this.lastPartial = text;
    this.write({ type: "partial", text: text.slice(-MAX_PARTIAL_CHARS), timestamp: now });
  }

  /** A tool call, as it starts — the most useful single signal that something is happening. */
  tool(name: string, args: unknown, now = Date.now()): void {
    this.write({
      type: "message",
      timestamp: now,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name, arguments: args }],
        timestamp: now,
      },
    });
  }

  /** Reasoning still arriving, so a thinking model does not look like an empty pane. */
  thinking(text: string, now = Date.now()): void {
    if (text.trim() === "") return;
    if (text === this.lastPartial) return;
    if (now - this.lastPartialAt < PARTIAL_MS) return;
    this.lastPartialAt = now;
    this.lastPartial = text;
    this.write({
      type: "partial",
      thinking: true,
      text: text.slice(-MAX_PARTIAL_CHARS),
      timestamp: now,
    });
  }

  /** A completed assistant message — the settled version of whatever the partials were drafting. */
  message(message: unknown, now = Date.now()): void {
    // A completed message supersedes the partials before it, so let the next one start fresh.
    this.lastPartialAt = 0;
    this.lastPartial = "";
    this.write({ type: "message", timestamp: now, message });
  }

  /** The run is over: remove the file so a finished run never looks live. */
  close(): void {
    this.closed = true;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // A leftover live file is ignored by readers once the lock is gone.
    }
  }
}
