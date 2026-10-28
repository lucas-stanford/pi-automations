/** Reading a session while it is being written. */

import { describe, expect, it } from "vitest";

import { buildSessionLines, decodeTranscript, unsupportedFormatLines } from "../src/ui/session-view.js";
import { parseSessionLines, piTranscriptReaders, toolSubject } from "../src/providers/pi/transcript.js";
import { collapseSessionLines, flattenText } from "../src/transcript-lines.js";
import type { LineTheme } from "../src/ui/theme.js";

const SESSION = {
  header: `{"type":"session","version":1,"id":"01a0b206-02b4-7447-a2eb-3b980579045e","timestamp":1789693133493,"cwd":"C:\\\\Users"}`,
  user: `{"type":"message","id":"a","parentId":null,"timestamp":1789693160078,"message":{"role":"user","content":[{"type":"text","text":"install this extension"}],"timestamp":1789693160078}}`,
  assistantText: `{"type":"message","id":"b","parentId":"a","timestamp":1789693161000,"message":{"role":"assistant","content":[{"type":"text","text":"I'll read the docs\\nfirst."}],"timestamp":1789693161000}}`,
  thinking: `{"type":"message","id":"c","parentId":"b","timestamp":1789693162000,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me consider the options"}],"timestamp":1789693162000}}`,
  toolCall: `{"type":"message","id":"d","parentId":"c","timestamp":1789693163000,"message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"C:\\\\docs\\\\extensions.md","offset":1,"limit":400}}],"timestamp":1789693163000}}`,
  toolResult: `{"type":"message","id":"e","parentId":"d","timestamp":1789693164000,"message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"0123456789"}],"timestamp":1789693164000}}`,
  modelChange: `{"type":"model_change","id":"f","parentId":"e","timestamp":1789693165000,"provider":"github-copilot","modelId":"claude-haiku-4.5"}`,
  thinkingLevel: `{"type":"thinking_level_change","id":"g","parentId":"f","timestamp":1789693166000,"thinkingLevel":"low"}`,
  custom: `{"type":"custom","customType":"whatever","data":{"x":1},"id":"h","parentId":"g","timestamp":1789693167000}`,
};

const all = Object.values(SESSION).join("\n");

describe("decodeTranscript — the format decides the reader, not the runtime", () => {
  const legacy = (text: string) => parseSessionLines(text);
  const alternative = {
    format: "fixture/v1",
    decode: (text: string) => ({
      lines: text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => ({ kind: "text" as const, text: l.trim() })),
    }),
  };
  const readers = { legacy, alternative };

  it("reads a reference with no format as legacy", () => {
    const read = decodeTranscript(SESSION.assistantText, { file: "/s.jsonl", id: "s" }, readers);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.parsed.lines[0]?.kind).toBe("text");
  });

  it("reads an EMPTY format as legacy too, because that is what old records carry", () => {
    const read = decodeTranscript(SESSION.assistantText, { file: "/s.jsonl", id: "s", format: "" }, readers);
    expect(read.ok).toBe(true);
  });

  it("reads no reference at all as legacy — the live sidecar has none", () => {
    const read = decodeTranscript(SESSION.assistantText, undefined, readers);
    expect(read.ok).toBe(true);
  });

  it("reads the one alternative a host composed", () => {
    const read = decodeTranscript("one\ntwo\n", { file: "/s.txt", id: "s", format: "fixture/v1" }, readers);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.parsed.lines.map((l) => l.text)).toEqual(["one", "two"]);
  });

  it("reports an unknown tag instead of guessing at pi", () => {
    const read = decodeTranscript(SESSION.assistantText, { file: "/s", id: "s", format: "mystery/v9" }, readers);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.unsupported).toBe("mystery/v9");
  });

  it("reports it on an EMPTY transcript, where an empty pane would look like nothing happened", () => {
    const read = decodeTranscript("", { file: "/s", id: "s", format: "mystery/v9" }, readers);
    expect(read.ok).toBe(false);
  });

  it("decides from the reference BEFORE reading anything", () => {
    // Both decoders explode. The choice is made from the tag alone, so neither is called.
    const explosive = {
      legacy: () => {
        throw new Error("the legacy decoder must not be reached");
      },
      alternative: {
        format: "fixture/v1",
        decode: () => {
          throw new Error("the alternative must not be reached");
        },
      },
    };
    expect(() =>
      decodeTranscript("anything", { file: "/s", id: "s", format: "mystery/v9" }, explosive),
    ).not.toThrow();
  });

  it("has no alternative in the pi host's own table, so a tag is unsupported there", () => {
    const read = decodeTranscript("", { file: "/s", id: "s", format: "fixture/v1" }, piTranscriptReaders);
    expect(read.ok).toBe(false);
  });
});

describe("the unsupported-format diagnostic", () => {
  const EXPECTED = [
    'unsupported transcript format "mystery/v9"',
    'use a host with a decoder for "mystery/v9"',
  ];

  it("says the same two lines at 80 columns", () => {
    expect(unsupportedFormatLines("mystery/v9", 80)).toEqual(EXPECTED);
  });

  it("says the same two lines at 120 columns", () => {
    expect(unsupportedFormatLines("mystery/v9", 120)).toEqual(EXPECTED);
  });

  it("names the tag it actually saw", () => {
    expect(unsupportedFormatLines("other/v2", 80)[0]).toBe(
      'unsupported transcript format "other/v2"',
    );
  });

  it("truncates rather than overflowing a narrow pane", () => {
    for (const line of unsupportedFormatLines("mystery/v9", 20)) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it("draws nothing at all when there is no room", () => {
    expect(unsupportedFormatLines("mystery/v9", 0)).toEqual([]);
  });
});

describe("parseSessionLines — the measured format", () => {
  it("reads the session id from the header", () => {
    expect(parseSessionLines(SESSION.header).id).toBe("01a0b206-02b4-7447-a2eb-3b980579045e");
  });

  it("keeps assistant text, flattened to one line", () => {
    const { lines } = parseSessionLines(SESSION.assistantText);
    expect(lines).toEqual([
      { kind: "text", text: "I'll read the docs first.", at: 1789693161000 },
    ]);
  });

  it("names a tool call and what it acted on", () => {
    const { lines } = parseSessionLines(SESSION.toolCall);
    expect(lines[0]?.kind).toBe("tool");
    expect(lines[0]?.text).toBe("read C:\\docs\\extensions.md");
  });

  it("summarises a tool result rather than pasting it", () => {
    const { lines } = parseSessionLines(SESSION.toolResult);
    expect(lines[0]).toMatchObject({ kind: "result", text: "read · 10 chars" });
  });

  it("keeps the order of blocks inside one assistant message", () => {
    // The order is the story: think, say, call.
    const mixed = `{"type":"message","id":"x","timestamp":1,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"ok"},{"type":"toolCall","id":"c","name":"bash","arguments":{"command":"ls"}}]}}`;
    const { lines } = parseSessionLines(mixed);
    expect(lines.map((l) => l.kind)).toEqual(["thinking", "text", "tool"]);
  });

  it("notes a model change, because it explains a change in behaviour", () => {
    const { lines } = parseSessionLines(SESSION.modelChange);
    expect(lines[0]).toMatchObject({ kind: "note", text: "model github-copilot/claude-haiku-4.5" });
  });

  it("ignores entry types it has no opinion about", () => {
    expect(parseSessionLines(SESSION.thinkingLevel).lines).toEqual([]);
    expect(parseSessionLines(SESSION.custom).lines).toEqual([]);
  });

  it("reads a whole real-shaped file in order", () => {
    const { lines, id } = parseSessionLines(all);
    expect(id).toBeDefined();
    expect(lines.map((l) => l.kind)).toEqual([
      "user",
      "text",
      "thinking",
      "tool",
      "result",
      "note",
    ]);
  });
});

describe("parseSessionLines — it is reading a file that is still being written", () => {
  it("skips a torn final line instead of throwing", () => {
    // This is the NORMAL case mid-run: the writer is mid-append when we read.
    const torn = `${SESSION.assistantText}\n{"type":"message","id":"z","message":{"role":"assist`;
    const { lines } = parseSessionLines(torn);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe("text");
  });

  it("survives an empty file, blank lines and trailing newlines", () => {
    expect(parseSessionLines("").lines).toEqual([]);
    expect(parseSessionLines("\n\n  \n").lines).toEqual([]);
    expect(parseSessionLines(`${SESSION.assistantText}\n\n`).lines).toHaveLength(1);
  });

  it("survives lines that are valid JSON but not objects", () => {
    expect(parseSessionLines('"a string"\n42\nnull\n[1,2]').lines).toEqual([]);
  });

  it("survives a message with no content, or content that is not an array", () => {
    const a = `{"type":"message","id":"1","message":{"role":"assistant"}}`;
    const b = `{"type":"message","id":"2","message":{"role":"assistant","content":"nope"}}`;
    const c = `{"type":"message","id":"3"}`;
    expect(parseSessionLines([a, b, c].join("\n")).lines).toEqual([]);
  });

  it("never throws, whatever the bytes are", () => {
    const nasty = ['{"type":"message"', "{]", "\u0000\u0001", "{}", '{"type":42}'].join("\n");
    expect(() => parseSessionLines(nasty)).not.toThrow();
  });
});

describe("toolSubject — show what it acted on, not the whole argument blob", () => {
  it("prefers the identifying key", () => {
    expect(toolSubject({ path: "a.ts", offset: 1, limit: 400 })).toBe("a.ts");
    expect(toolSubject({ command: "ls -la" })).toBe("ls -la");
    expect(toolSubject({ url: "https://x" })).toBe("https://x");
  });

  it("falls back to the first short string", () => {
    expect(toolSubject({ weird: "hello" })).toBe("hello");
  });

  it("does not paste a whole file body", () => {
    // `write` carries the entire content; that must never become the subject.
    const huge = "x".repeat(5000);
    expect(toolSubject({ content: huge })).toBe("");
    // ...but the path beside it is exactly what we want.
    expect(toolSubject({ content: huge, path: "out.ts" })).toBe("out.ts");
  });

  it("says nothing rather than guessing", () => {
    expect(toolSubject(undefined)).toBe("");
    expect(toolSubject(null)).toBe("");
    expect(toolSubject("string")).toBe("");
    expect(toolSubject({ n: 1 })).toBe("");
  });
});

describe("flattenText", () => {
  it("flattens and collapses, so one entry is one row", () => {
    expect(flattenText("a\n\n  b\tc  ")).toBe("a b c");
  });
});

describe("buildSessionLines", () => {
  const { lines } = parseSessionLines(all);

  it("gives one rendered row per source row, so the pane does not reflow as it grows", () => {
    const out = buildSessionLines(lines, { width: 40 });
    // Thinking is hidden by default, so it is the only one dropped.
    expect(out).toHaveLength(lines.length - 1);
  });

  it("hides the model's private reasoning unless asked", () => {
    expect(buildSessionLines(lines, { width: 40 }).join("\n")).not.toContain("consider");
    expect(buildSessionLines(lines, { width: 40, showThinking: true }).join("\n")).toContain(
      "consider",
    );
  });

  it("never exceeds the width it was given", () => {
    for (const w of [12, 20, 40, 80]) {
      for (const l of buildSessionLines(lines, { width: w, showThinking: true })) {
        expect(l.length).toBeLessThanOrEqual(w);
      }
    }
  });

  it("marks a tool call so it stands out from narration", () => {
    const out = buildSessionLines(lines, { width: 60 });
    expect(out.some((l) => l.startsWith("▸ read"))).toBe(true);
  });

  it("colours by kind", () => {
    const theme: LineTheme = { fg: (c, t) => `<${c}>${t}` };
    const out = buildSessionLines(lines, { width: 60, theme });
    expect(out.some((l) => l.startsWith("<accent>▸ read"))).toBe(true);
    expect(out.some((l) => l.startsWith("<dim>  ↳ read"))).toBe(true);
  });

  it("refuses to render into no room rather than emitting a broken row", () => {
    expect(buildSessionLines(lines, { width: 1 })).toEqual([]);
  });
});

describe("a completed message supersedes the partials that were drafting it", () => {
  const partial = (text: string) => `{"type":"partial","text":${JSON.stringify(text)},"timestamp":1}`;
  const message = (text: string) =>
    `{"type":"message","timestamp":2,"message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;

  it("replaces an identical partial rather than repeating it", () => {
    const { lines } = parseSessionLines(`${partial("I'll write an essay")}\n${message("I'll write an essay")}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "text", text: "I'll write an essay" });
  });

  it("replaces a partial the finished text continues", () => {
    const { lines } = parseSessionLines(`${partial("I'll write")}\n${message("I'll write an essay about presses")}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("I'll write an essay about presses");
  });

  it("keeps an unrelated message, because it is genuinely a second thing", () => {
    const { lines } = parseSessionLines(`${partial("thinking about it")}\n${message("Here is the answer")}`);
    expect(lines).toHaveLength(2);
  });

  it("does not swallow a real earlier line", () => {
    const { lines } = parseSessionLines(`${message("first")}\n${message("second")}`);
    expect(lines.map((l) => l.text)).toEqual(["first", "second"]);
  });
});

describe("reasoning drafts too, so it supersedes the same way", () => {
  const thinkPartial = (t: string) =>
    `{"type":"partial","thinking":true,"text":${JSON.stringify(t)},"timestamp":1}`;
  const thinkMessage = (t: string) =>
    `{"type":"message","timestamp":2,"message":{"role":"assistant","content":[{"type":"thinking","thinking":${JSON.stringify(t)}}]}}`;

  it("replaces the draft it continues", () => {
    const { lines } = parseSessionLines(
      `${thinkPartial("The user wants")}\n${thinkMessage("The user wants me to write an essay")}`,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "thinking", text: "The user wants me to write an essay" });
  });

  it("keeps a genuinely different thought", () => {
    const { lines } = parseSessionLines(
      `${thinkPartial("Considering structure")}\n${thinkMessage("Now checking the sources")}`,
    );
    expect(lines).toHaveLength(2);
  });

  it("does not let reasoning swallow the text that follows it", () => {
    const { lines } = parseSessionLines(
      `${thinkPartial("Thinking")}\n${thinkMessage("Thinking hard")}\n{"type":"message","timestamp":3,"message":{"role":"assistant","content":[{"type":"text","text":"Thinking hard is done"}]}}`,
    );
    expect(lines.map((l) => l.kind)).toEqual(["thinking", "text"]);
  });
});

describe("the seam between reads", () => {
  // The window tails the file once a second and accumulates what it parses.
  it("collapses drafts that span two reads", () => {
    const first = parseSessionLines(`{"type":"partial","text":"I'll","timestamp":1}`).lines;
    const second = parseSessionLines(
      `{"type":"partial","text":"I'll write an essay","timestamp":2}`,
    ).lines;
    expect(collapseSessionLines([...first, ...second])).toEqual([
      { kind: "partial", text: "I'll write an essay", at: 2 },
    ]);
  });

  it("collapses reasoning across two reads", () => {
    const a = parseSessionLines(`{"type":"partial","thinking":true,"text":"The user","timestamp":1}`).lines;
    const b = parseSessionLines(
      `{"type":"message","timestamp":2,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants an essay"}]}}`,
    ).lines;
    expect(collapseSessionLines([...a, ...b])).toHaveLength(1);
  });

  it("is idempotent, because it runs on every read", () => {
    const once = collapseSessionLines(parseSessionLines(all).lines);
    expect(collapseSessionLines(once)).toEqual(once);
  });

  it("keeps genuinely distinct lines", () => {
    const lines = parseSessionLines(all).lines;
    expect(collapseSessionLines(lines).length).toBeGreaterThan(1);
  });
});
