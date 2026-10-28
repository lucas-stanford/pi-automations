/** The live view a run writes about itself. */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { liveFile, LiveWriter, PARTIAL_MS } from "../src/live.js";
import { parseSessionLines } from "../src/providers/pi/transcript.js";
import { tempDir } from "./helpers/temp.js";

function tempFile(): string {
  return path.join(tempDir("pa-live-"), "run.live");
}

function entries(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);
}

describe("liveFile", () => {
  it("sits beside the lock, because it has the same lifetime", () => {
    const f = liveFile("/state", "user:/r:daily-briefing");
    expect(f).toContain("locks");
    expect(f.endsWith(".live")).toBe(true);
  });
});

describe("LiveWriter — streaming text", () => {
  it("writes the first partial immediately, so the pane is not blank while waiting", () => {
    const f = tempFile();
    new LiveWriter(f).partial("Hello", 1000);
    expect(entries(f)).toHaveLength(1);
  });

  it("throttles, because message_update fires many times a second", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    w.partial("a", 1000);
    w.partial("ab", 1100);
    w.partial("abc", 1500);
    expect(entries(f)).toHaveLength(1);
    w.partial("abcd", 1000 + PARTIAL_MS);
    expect(entries(f)).toHaveLength(2);
  });

  it("says nothing when there is nothing new to say", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    const same = "I'll write a comprehensive essay";
    for (let i = 0; i < 23; i++) w.partial(same, 1000 + i * PARTIAL_MS * 2);
    expect(entries(f)).toHaveLength(1);
  });

  it("resumes when the text changes again", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    w.partial("one", 1000);
    w.partial("one", 1000 + PARTIAL_MS * 2);
    w.partial("one two", 1000 + PARTIAL_MS * 4);
    expect(entries(f)).toHaveLength(2);
  });

  it("ignores empty and whitespace-only text", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    w.partial("", 1000);
    w.partial("   \n ", 2000);
    expect(entries(f)).toEqual([]);
  });

  it("bounds what it keeps, so a very long reply cannot grow the file without limit", () => {
    const f = tempFile();
    new LiveWriter(f).partial("x".repeat(50_000), 1000);
    const e = entries(f)[0] as { text: string };
    expect(e.text.length).toBeLessThanOrEqual(2000);
  });
});

describe("LiveWriter — reasoning", () => {
  it("streams thinking, because a model can reason for 24 seconds before its first character", () => {
    const f = tempFile();
    new LiveWriter(f).thinking("Let me consider the structure", 1000);
    const e = entries(f)[0] as { type: string; thinking: boolean };
    expect(e.type).toBe("partial");
    expect(e.thinking).toBe(true);
  });

  it("is deduplicated and throttled the same way", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    for (let i = 0; i < 10; i++) w.thinking("same", 1000 + i * PARTIAL_MS * 2);
    expect(entries(f)).toHaveLength(1);
  });
});

describe("LiveWriter — tools and completed messages", () => {
  it("writes a tool call in pi's own shape, so one parser reads both files", () => {
    const f = tempFile();
    new LiveWriter(f).tool("write", { path: "essay.md" }, 1000);
    const { lines } = parseSessionLines(readFileSync(f, "utf8"));
    expect(lines).toEqual([{ kind: "tool", text: "write essay.md", at: 1000 }]);
  });

  it("writes a completed message through the same parser", () => {
    const f = tempFile();
    new LiveWriter(f).message(
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      1000,
    );
    const { lines } = parseSessionLines(readFileSync(f, "utf8"));
    expect(lines[0]).toMatchObject({ kind: "text", text: "done" });
  });

  it("lets the next partial through after a completed message supersedes it", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    w.partial("draft", 1000);
    w.message({ role: "assistant", content: [{ type: "text", text: "final" }] }, 1010);
    // Without resetting, this would be swallowed by the throttle and by the dedupe.
    w.partial("draft", 1020);
    expect(entries(f)).toHaveLength(3);
  });
});

describe("LiveWriter — ending", () => {
  it("removes the file, because it describes a run in progress", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    w.partial("something", 1000);
    expect(existsSync(f)).toBe(true);
    w.close();
    expect(existsSync(f)).toBe(false);
  });

  it("writes nothing more once closed", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    w.close();
    w.partial("late", 1000);
    w.tool("write", {}, 2000);
    expect(existsSync(f)).toBe(false);
  });
});

describe("LiveWriter — it is a view, and a view cannot break a run", () => {
  it("never throws when the path is unwritable", () => {
    // A directory where a file should be.
    const dir = tempDir("pa-live-bad-");
    const w = new LiveWriter(dir);
    expect(() => {
      w.partial("x", 1000);
      w.thinking("y", 3000);
      w.tool("t", {}, 4000);
      w.message({ role: "assistant", content: [] }, 5000);
      w.close();
    }).not.toThrow();
  });

  it("never throws on values that will not serialise", () => {
    const f = tempFile();
    const w = new LiveWriter(f);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => w.tool("t", cyclic, 1000)).not.toThrow();
  });
});
