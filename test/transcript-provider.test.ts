/** The transcript codec seam. */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/pi-module.js", () => ({
  PI_MODULE_ENV: "PI_AUTOMATIONS_PI_MODULE",
  findPiModule: () => undefined,
  importPi: async () => {
    throw new Error("the SDK must not be loaded to read a transcript");
  },
}));

import { parseSessionLines, } from "../src/providers/pi/transcript.js";
import {
  buildSessionLines,
  decodeTranscript,
  unsupportedFormatLines,
  type TranscriptReaders,
} from "../src/ui/session-view.js";
import { fire, type SessionHandle } from "../src/run.js";
import { readRecords } from "../src/records.js";
import { readRunLock } from "../src/locks.js";
import type { FireEvent } from "../src/types.js";
import type { AutomationRuntime, RuntimeModelRef } from "../src/core/contracts.js";
import { cleanupTempDirs } from "./helpers/temp.js";
import { HOST_NOW, isolatedAutomation, isolatedFireDeps } from "./helpers/isolated-host.js";

afterAll(cleanupTempDirs);

const LEGACY = readFileSync(
  path.join(import.meta.dirname, "compat-fixtures", "pi-session.jsonl"),
  "utf8",
);

const MANUAL = { trigger: "manual" as const, now: () => HOST_NOW };

// A different format entirely: one line of plain text per entry, with a `#` comment.
//
// Deliberately NOT JSON, so a decoder that fell back to the legacy reader would produce nothing and
// the test would notice.
function fixtureDecode(text: string) {
  return {
    lines: text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"))
      .map((l) => ({ kind: "text" as const, text: l })),
  };
}

const HOST_READERS: TranscriptReaders = {
  legacy: parseSessionLines,
  alternative: { format: "fixture/v1", decode: fixtureDecode },
};

describe("the package index still exports one working decoder", () => {
  // Two star exports offering the same name from different bindings would silently drop it.

  it("resolves parseSessionLines through the star exports, unambiguously", async () => {
    const index = await import("../src/index.js");
    expect(typeof index.parseSessionLines).toBe("function");
    expect(index.parseSessionLines).toBe(parseSessionLines);
    expect(index.piTranscriptReaders.legacy).toBe(parseSessionLines);
  });

  it("still exports the rest of the surface the extension calls", async () => {
    const index = await import("../src/index.js");
    for (const name of [
      "parseSessionLines",
      "collapseSessionLines",
      "flattenText",
      "toolSubject",
      "decodeTranscript",
      "buildSessionLines",
      "unsupportedFormatLines",
    ]) {
      expect(typeof (index as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

describe("a legacy pi transcript reads with pi unreachable", () => {
  it("decodes a recorded session file", () => {
    const parsed = parseSessionLines(LEGACY);
    expect(parsed.lines.length).toBeGreaterThan(0);
    expect(parsed.id).toBeTruthy();
    // The shapes the pane distinguishes are all present, so this is a real transcript and not one
    // line that happened to parse.
    const kinds = new Set(parsed.lines.map((l) => l.kind));
    expect(kinds.has("user")).toBe(true);
    expect(kinds.has("text")).toBe(true);
  });

  it("renders through the ordinary viewer", () => {
    const parsed = parseSessionLines(LEGACY);
    const rendered = buildSessionLines(parsed.lines, { width: 80 });
    expect(rendered.length).toBeGreaterThan(0);
    for (const line of rendered) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("proves the mock is real, so the claim above is falsifiable", async () => {
    const { importPi } = await import("../src/pi-module.js");
    await expect(importPi()).rejects.toThrow("must not be loaded");
  });

  it("never throws on a torn last line", () => {
    const torn = `${LEGACY.trimEnd()}\n{"type":"message","id":"x","mess`;
    expect(() => parseSessionLines(torn)).not.toThrow();
  });
});

describe("a host composes its alternative alongside the legacy reader", () => {
  it("reads the legacy history it inherited", () => {
    const read = decodeTranscript(LEGACY, { file: "/s.jsonl", id: "s" }, HOST_READERS);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.parsed.lines.length).toBeGreaterThan(0);
  });

  it("reads its own format, which is not JSON at all", () => {
    const text = "# a comment\nthe first thing\nthe second thing\n";
    const read = decodeTranscript(text, { file: "/s.txt", id: "s", format: "fixture/v1" }, HOST_READERS);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.parsed.lines.map((l) => l.text)).toEqual(["the first thing", "the second thing"]);
    // Same viewer, same widths, no special case.
    expect(buildSessionLines(read.parsed.lines, { width: 80 })).toEqual([
      "  the first thing",
      "  the second thing",
    ]);
  });

  it("refuses to guess at a third format", () => {
    const read = decodeTranscript("anything at all", { file: "/s", id: "s", format: "other/v3" }, HOST_READERS);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(unsupportedFormatLines(read.unsupported, 80)).toEqual([
      'unsupported transcript format "other/v3"',
      'use a host with a decoder for "other/v3"',
    ]);
  });
});

// ------------------------------------------------------------------- what a run writes

/** A runtime whose session declares a transcript format. */
function taggedRuntime(format?: string): AutomationRuntime {
  return {
    resolveModel: async () =>
      Object.freeze({
        provider: "fixture",
        id: "deterministic",
        display: "fixture/deterministic",
      }) as RuntimeModelRef,
    startSession: async (): Promise<SessionHandle> => ({
      file: "/sessions/tagged.log",
      id: "tagged-1",
      ...(format ? { format } : {}),
      prompt: async () => "done",
      dispose: () => {},
    }),
  };
}

describe("the reference a run writes", () => {
  it("carries the format when the runtime named one", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "tagged-run" });
    const seen: FireEvent[] = [];

    const rec = await fire(
      a.located,
      { ...MANUAL, emit: (e) => seen.push(e) },
      isolatedFireDeps(a.stateDir, { runtime: taggedRuntime("fixture/v1") }),
    );

    expect(rec.session).toEqual({
      file: "/sessions/tagged.log",
      id: "tagged-1",
      format: "fixture/v1",
    });

    // The same three keys on the event a window is watching…
    const event = seen.find((e) => e.event === "session");
    expect(event).toEqual({
      event: "session",
      file: "/sessions/tagged.log",
      id: "tagged-1",
      format: "fixture/v1",
    });

    // …and in the history that outlives the run.
    const records = readRecords(a.stateDir, a.located.key);
    expect(records[0]?.session?.format).toBe("fixture/v1");
  });

  it("omits it entirely when the runtime did not, so a pi record is unchanged", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "plain-run" });
    const seen: FireEvent[] = [];

    const rec = await fire(
      a.located,
      { ...MANUAL, emit: (e) => seen.push(e) },
      isolatedFireDeps(a.stateDir, { runtime: taggedRuntime() }),
    );

    expect(Object.keys(rec.session ?? {}).sort()).toEqual(["file", "id"]);
    expect(seen.find((e) => e.event === "session")).toEqual({
      event: "session",
      file: "/sessions/tagged.log",
      id: "tagged-1",
    });
    // Absent, not empty: an empty tag would be a third key in every pi record ever written.
    expect(JSON.stringify(rec.session)).not.toContain("format");
  });

  it("publishes the format on the run lock too, for a window opened later", async () => {
    const a = isolatedAutomation({ frontmatter: "on:\n  manual: true\n", name: "locked-run" });
    let lockedFormat: string | undefined;

    await fire(
      a.located,
      {
        ...MANUAL,
        emit: (e) => {
          // Read the lock once the body has run: the session is published to the lock right after
          // the event, and the lock is released when the run ends.
          if (e.event === "body-end") {
            lockedFormat = readRunLock(a.stateDir, a.located.key)?.session?.format;
          }
        },
      },
      isolatedFireDeps(a.stateDir, { runtime: taggedRuntime("fixture/v1") }),
    );

    expect(lockedFormat).toBe("fixture/v1");
  });
});
