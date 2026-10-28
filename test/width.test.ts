/** The width contract. */

import { describe, expect, it } from "vitest";

import {
  fitTo,
  padLeft,
  padTo,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
  wrapHard,
} from "../src/ui/width.js";

const RED = "\u001B[31m";
const RESET = "\u001B[0m";

describe("visibleWidth", () => {
  it("counts plain text by character", () => {
    expect(visibleWidth("")).toBe(0);
    expect(visibleWidth("flow-example")).toBe(12);
  });

  it("ignores SGR colour", () => {
    expect(visibleWidth(`${RED}ok${RESET}`)).toBe(2);
    expect(`${RED}ok${RESET}`.length).toBeGreaterThan(2);
  });

  it("ignores multi-parameter and 256-colour SGR", () => {
    expect(visibleWidth("\u001B[38;5;213mx\u001B[0m")).toBe(1);
    expect(visibleWidth("\u001B[38;2;255;0;0mxy\u001B[0m")).toBe(2);
  });

  it("ignores OSC 8 hyperlinks terminated by BEL or ST", () => {
    expect(visibleWidth("\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007")).toBe(4);
    expect(visibleWidth("\u001B]8;;https://example.com\u001B\\link\u001B]8;;\u001B\\")).toBe(4);
  });

  it("ignores pi's APC cursor marker", () => {
    expect(visibleWidth("\u001B_pi:c\u0007abc")).toBe(3);
  });

  it("counts a combining mark as zero", () => {
    expect(visibleWidth("e\u0301")).toBe(1);
  });

  it("counts CJK and emoji as two columns", () => {
    expect(visibleWidth("日本")).toBe(4);
    expect(visibleWidth("\u{1F600}")).toBe(2);
  });
});

describe("stripAnsi", () => {
  it("leaves exactly what a terminal shows", () => {
    expect(stripAnsi(`${RED}a\u001B[1mb${RESET}`)).toBe("ab");
  });
});

describe("truncateToWidth", () => {
  it("returns the input untouched when it already fits", () => {
    const s = `${RED}abc${RESET}`;
    expect(truncateToWidth(s, 3)).toBe(s);
    expect(truncateToWidth(s, 99)).toBe(s);
  });

  it("returns nothing for a non-positive budget", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
    expect(truncateToWidth("abc", -1)).toBe("");
  });

  it("cuts plain text at the column boundary", () => {
    expect(truncateToWidth("abcdef", 3)).toBe("abc");
  });

  it("keeps colour across the cut and never leaks it", () => {
    const out = truncateToWidth(`${RED}abcdef${RESET}`, 3);
    expect(visibleWidth(out)).toBe(3);
    expect(stripAnsi(out)).toBe("abc");
    expect(out.startsWith(RED)).toBe(true);
    expect(out.endsWith(RESET)).toBe(true);
  });

  it("drops a double-width character rather than half-drawing it", () => {
    // "日本" is four columns; a three-column budget can only hold the first.
    const out = truncateToWidth("日本", 3);
    expect(out).toBe("日");
    expect(visibleWidth(out)).toBe(2);
  });

  it("never exceeds the budget for any prefix length", () => {
    const s = `${RED}automations${RESET} 日本 x`;
    for (let n = 1; n <= 20; n++) {
      expect(visibleWidth(truncateToWidth(s, n))).toBeLessThanOrEqual(n);
    }
  });
});

describe("padTo / padLeft / fitTo", () => {  it("pads to the visible width, not the string length", () => {
    expect(visibleWidth(padTo(`${RED}ab${RESET}`, 5))).toBe(5);
    expect(visibleWidth(padLeft(`${RED}ab${RESET}`, 5))).toBe(5);
  });

  it("never truncates while padding", () => {
    expect(padTo("abcdef", 3)).toBe("abcdef");
    expect(padLeft("abcdef", 3)).toBe("abcdef");
  });

  it("fitTo is exactly n columns in both directions", () => {
    expect(visibleWidth(fitTo("abcdef", 3))).toBe(3);
    expect(visibleWidth(fitTo("ab", 6))).toBe(6);
    expect(visibleWidth(fitTo(`${RED}abcdef${RESET}`, 4))).toBe(4);
  });
});

describe("wrapHard", () => {
  it("returns the input untouched when it already fits", () => {
    expect(wrapHard("abc", 5)).toEqual(["abc"]);
  });

  it("loses nothing — the chunks rejoin to the original", () => {
    const s = '  "key": "a rather long json value that will not fit at all",';
    const chunks = wrapHard(s, 12);
    expect(chunks.join("")).toBe(s);
    for (const c of chunks) expect(visibleWidth(c)).toBeLessThanOrEqual(12);
  });

  it("terminates on a non-positive width instead of looping", () => {
    expect(wrapHard("abc", 0)).toEqual(["abc"]);
  });
});
