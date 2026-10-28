/** The session pane's tails. */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createSessionViewer } from "../src/hosts/pi/session-viewer.js";
import { parseSessionLines, piTranscriptReaders } from "../src/providers/pi/transcript.js";
import type { TranscriptReaders } from "../src/ui/session-view.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const message = (text: string) =>
  JSON.stringify({
    type: "message",
    id: "m",
    timestamp: 1,
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 },
  });

const partial = (text: string) => JSON.stringify({ type: "partial", text, timestamp: 1 });

function transcript(lines: string[]): string {
  const file = path.join(tempDir("pi-sv-"), "session.jsonl");
  writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  return file;
}

describe("a format nobody here can read is said out loud", () => {
  const viewer = () => createSessionViewer({ readers: piTranscriptReaders });

  it("says so before the file is opened, so an EMPTY one still reports", () => {
    const file = transcript([]);
    const lines = viewer().pane({
      source: { session: { file, id: "s", format: "mystery/v9" } },
      width: 80,
    });
    expect(lines).toEqual([
      'unsupported transcript format "mystery/v9"',
      'use a host with a decoder for "mystery/v9"',
    ]);
  });

  it("says so when the file is not there at all", () => {
    const lines = viewer().pane({
      source: { session: { file: path.join(tempDir("pi-sv-"), "never.jsonl"), id: "s", format: "mystery/v9" } },
      width: 80,
    });
    expect(lines?.[0]).toContain("mystery/v9");
  });

  it("reads the legacy shape when there is no tag", () => {
    const file = transcript([message("hello")]);
    const lines = viewer().pane({ source: { session: { file, id: "s" } }, width: 80 });
    expect(lines?.join("\n")).toContain("hello");
  });

  it("uses the host's OWN alternative decoder, not the active runtime's", () => {
    const readers: TranscriptReaders = {
      legacy: parseSessionLines,
      alternative: {
        format: "fixture/v1",
        decode: (text) => ({
          lines: text
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => ({ kind: "text" as const, text: l.trim() })),
        }),
      },
    };
    const file = transcript(["plain one", "plain two"]);
    const lines = createSessionViewer({ readers }).pane({
      source: { session: { file, id: "s", format: "fixture/v1" } },
      width: 80,
    });
    expect(lines).toEqual(["  plain one", "  plain two"]);
  });

  it("never selects on the LIVE file, which is core's own shape whatever ran", () => {
    const file = transcript([message("from the live file")]);
    // A live file plus a tagged session reference: the live file wins and is read as legacy,
    // because the run writes it in core's shape regardless of which runtime produced the run.
    const lines = viewer().pane({
      source: { live: file, session: { file: "/elsewhere", id: "s", format: "mystery/v9" } },
      width: 80,
    });
    expect(lines?.join("\n")).toContain("from the live file");
  });
});

describe("following a file that is still being written", () => {
  it("keeps its offset between reads, and only reads what is new", () => {
    const file = transcript([message("first")]);
    const v = createSessionViewer({ readers: piTranscriptReaders });

    const one = v.pane({ source: { live: file }, width: 80 });
    expect(one?.join("\n")).toContain("first");

    appendFileSync(file, `${message("second")}\n`, "utf8");
    const two = v.pane({ source: { live: file }, width: 80 });
    expect(two?.join("\n")).toContain("first");
    expect(two?.join("\n")).toContain("second");
  });

  it("collapses a draft and its settled form ACROSS the seam", () => {
    const file = transcript([partial("I'll write an")]);
    const v = createSessionViewer({ readers: piTranscriptReaders });

    v.pane({ source: { live: file }, width: 80 });
    appendFileSync(file, `${message("I'll write an essay")}\n`, "utf8");
    const lines = v.pane({ source: { live: file }, width: 80 });

    // One line, not two.
    expect(lines).toHaveLength(1);
    expect(lines?.[0]).toContain("I'll write an essay");
  });

  it("starts over when the file is replaced under it", () => {
    const file = transcript([message("a long first run with plenty of text in it")]);
    const v = createSessionViewer({ readers: piTranscriptReaders });
    v.pane({ source: { live: file }, width: 80 });

    // SHORTER, which is what a replacement actually looks like: a new run's transcript starts near
    // empty. `readTail` detects a restart by the file shrinking, so an equal-length rewrite is
    // indistinguishable from no change — and correctly reads as nothing new.
    writeFileSync(file, `${message("new")}\n`, "utf8");
    const lines = v.pane({ source: { live: file }, width: 80 });
    expect(lines?.join("\n")).toContain("new");
    expect(lines?.join("\n")).not.toContain("long first run");
  });

  it("keeps one tail per FILE, so a re-run does not inherit an offset", () => {
    const a = transcript([message("run a")]);
    const b = transcript([message("run b")]);
    const v = createSessionViewer({ readers: piTranscriptReaders });

    v.pane({ source: { live: a }, width: 80 });
    v.pane({ source: { live: b }, width: 80 });
    expect(v.following).toBe(2);

    const second = v.pane({ source: { live: b }, width: 80 });
    expect(second?.join("\n")).toContain("run b");
    expect(second?.join("\n")).not.toContain("run a");
  });

  it("bounds what it keeps", () => {
    const file = transcript([]);
    const v = createSessionViewer({ readers: piTranscriptReaders, linesKept: 5 });
    for (let i = 0; i < 40; i++) appendFileSync(file, `${message(`line ${i}`)}\n`, "utf8");

    const lines = v.pane({ source: { live: file }, width: 80 });
    expect(lines).toHaveLength(5);
    // The NEWEST, because what a watcher wants is what is happening now.
    expect(lines?.[4]).toContain("line 39");
  });

  it("shows nothing, and breaks nothing, when there is no file to read", () => {
    const v = createSessionViewer({ readers: piTranscriptReaders });
    expect(v.pane({ source: {}, width: 80 })).toBeUndefined();
    expect(v.following).toBe(0);
  });

  it("survives a file it cannot read", () => {
    const v = createSessionViewer({ readers: piTranscriptReaders });
    // A directory where a transcript should be: reading a view must never break the window.
    const dir = tempDir("pi-sv-dir-");
    expect(() => v.pane({ source: { live: dir }, width: 80 })).not.toThrow();
  });
});

describe("disposal drops what is being read, and nothing else", () => {
  it("forgets every tail", () => {
    const file = transcript([message("hello")]);
    const v = createSessionViewer({ readers: piTranscriptReaders });
    v.pane({ source: { live: file }, width: 80 });
    expect(v.following).toBe(1);

    v.dispose();
    expect(v.following).toBe(0);
  });

  it("stops rendering rather than resurrecting itself", () => {
    const file = transcript([message("hello")]);
    const v = createSessionViewer({ readers: piTranscriptReaders });
    v.dispose();

    expect(v.pane({ source: { live: file }, width: 80 })).toBeUndefined();
    expect(v.following).toBe(0);
  });

  it("leaves the transcript on disk exactly as it was", () => {
    const file = transcript([message("hello")]);
    const v = createSessionViewer({ readers: piTranscriptReaders });
    v.pane({ source: { live: file }, width: 80 });

    const before = readFileSync(file, "utf8");
    v.dispose();
    // The run owns this file and is probably still appending to it. A reader that truncated,
    // deleted or rewrote it on the way out would corrupt a run it was only ever watching.
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
