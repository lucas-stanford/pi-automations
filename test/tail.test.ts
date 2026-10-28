/** Following a file that is still being written. */

import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { newTail, readTail } from "../src/tail.js";
import { tempDir } from "./helpers/temp.js";

function tempFile(name = "s.jsonl"): string {
  return path.join(tempDir("pa-tail-"), name);
}

describe("readTail", () => {
  it("says nothing is there when the file does not exist yet", () => {
    const r = readTail(path.join(tempFile(), "nope.jsonl"), newTail());
    expect(r).toEqual({ text: "", restarted: false, present: false });
  });

  it("reads complete lines", () => {
    const f = tempFile();
    writeFileSync(f, "one\ntwo\n");
    const s = newTail();
    expect(readTail(f, s).text).toBe("one\ntwo");
  });

  it("returns only what is NEW on the next read", () => {
    const f = tempFile();
    writeFileSync(f, "one\n");
    const s = newTail();
    expect(readTail(f, s).text).toBe("one");
    appendFileSync(f, "two\n");
    expect(readTail(f, s).text).toBe("two");
    // Nothing added: nothing returned, rather than the whole file again.
    expect(readTail(f, s).text).toBe("");
  });

  it("holds back a torn final line until its newline arrives", () => {
    // This is the normal mid-run case: we read while the writer is mid-append.
    const f = tempFile();
    writeFileSync(f, 'one\n{"half":');
    const s = newTail();
    expect(readTail(f, s).text).toBe("one");

    appendFileSync(f, '"written"}\n');
    expect(readTail(f, s).text).toBe('{"half":"written"}');
  });

  it("never emits a fragment, however many reads it takes", () => {
    const f = tempFile();
    writeFileSync(f, "");
    const s = newTail();
    const whole = '{"a":1}';
    // One byte at a time, the cruellest version of the same case.
    for (const ch of whole) {
      expect(readTail(f, s).text).toBe("");
      appendFileSync(f, ch);
    }
    appendFileSync(f, "\n");
    expect(readTail(f, s).text).toBe(whole);
  });

  it("starts over when the file shrinks, instead of reading from the middle of a line", () => {
    const f = tempFile();
    writeFileSync(f, "aaaa\nbbbb\ncccc\n");
    const s = newTail();
    expect(readTail(f, s).text).toBe("aaaa\nbbbb\ncccc");

    writeFileSync(f, "new\n");
    const r = readTail(f, s);
    expect(r.restarted).toBe(true);
    expect(r.text).toBe("new");
  });

  it("does not report a restart when the file merely grows", () => {
    const f = tempFile();
    writeFileSync(f, "a\n");
    const s = newTail();
    readTail(f, s);
    appendFileSync(f, "b\n");
    expect(readTail(f, s).restarted).toBe(false);
  });

  it("reports an empty file as present but silent", () => {
    const f = tempFile();
    writeFileSync(f, "");
    const r = readTail(f, newTail());
    expect(r.present).toBe(false);
    expect(r.text).toBe("");
  });

  it("handles multi-byte characters split across reads", () => {
    const f = tempFile();
    writeFileSync(f, "");
    const s = newTail();
    // An em dash is three bytes in UTF-8.
    appendFileSync(f, "before — after\n");
    expect(readTail(f, s).text).toBe("before — after");
  });

  it("is bounded: a huge file does not come back in one line-less lump", () => {
    const f = tempFile();
    const line = `${"x".repeat(999)}\n`;
    writeFileSync(f, line.repeat(400)); // ~400 KB, larger than one chunk
    const s = newTail();
    const first = readTail(f, s);
    expect(first.text.length).toBeGreaterThan(0);
    // More remains, and a second read continues rather than repeating.
    const second = readTail(f, s);
    expect(second.text.length).toBeGreaterThan(0);
    expect(second.text).not.toBe(first.text);
  });

  it("eventually consumes the whole of a large file across successive reads", () => {
    const f = tempFile();
    const total = 400;
    writeFileSync(f, Array.from({ length: total }, (_, i) => `line${i}`).join("\n") + "\n");
    const s = newTail();
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = readTail(f, s);
      if (r.text !== "") seen.push(...r.text.split("\n"));
    }
    expect(seen).toHaveLength(total);
    expect(seen[0]).toBe("line0");
    expect(seen[total - 1]).toBe(`line${total - 1}`);
  });

  it("never throws, whatever it is pointed at", () => {
    const dir = tempDir("pa-tail-dir-");
    // A directory, not a file.
    expect(() => readTail(dir, newTail())).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
    expect(() => readTail(dir, newTail())).not.toThrow();
  });
});
