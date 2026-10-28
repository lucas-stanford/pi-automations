import { describe, expect, it } from "vitest";

import { DURATION_RE, formatDuration, parseDuration } from "../src/duration.js";

describe("parseDuration", () => {
  it("accepts the AUTOMATION.md grammar", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("refuses zero, because a zero-length run is not a run", () => {
    expect(parseDuration("0s")).toBeUndefined();
    expect(parseDuration("0m")).toBeUndefined();
  });

  it("refuses whitespace and compound forms", () => {
    expect(parseDuration("10 m")).toBeUndefined();
    expect(parseDuration("1h30m")).toBeUndefined();
    expect(parseDuration(" 10m")).toBeUndefined();
    expect(parseDuration("10m ")).toBeUndefined();
  });

  it("refuses units outside the grammar", () => {
    expect(parseDuration("10ms")).toBeUndefined();
    expect(parseDuration("2w")).toBeUndefined();
    expect(parseDuration("ten minutes")).toBeUndefined();
  });

  it("allows days only for config.json", () => {
    expect(parseDuration("7d")).toBeUndefined();
    expect(parseDuration("7d", { allowDays: true })).toBe(604_800_000);
    expect(parseDuration("30d", { allowDays: true })).toBe(2_592_000_000);
  });

  it("refuses leading zeros and negatives", () => {
    expect(parseDuration("01m")).toBeUndefined();
    expect(parseDuration("-1m")).toBeUndefined();
  });

  it("tolerates a non-string without throwing", () => {
    expect(parseDuration(undefined as unknown as string)).toBeUndefined();
    expect(parseDuration(10 as unknown as string)).toBeUndefined();
  });

  it("exports the grammar the parser advertises", () => {
    expect(DURATION_RE.test("90s")).toBe(true);
    expect(DURATION_RE.test("7d")).toBe(false);
  });
});

describe("formatDuration", () => {
  it("matches the listing examples", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(552_000)).toBe("9m12s");
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("drops empty components", () => {
    expect(formatDuration(600_000)).toBe("10m");
    expect(formatDuration(3_660_000)).toBe("1h1m");
    expect(formatDuration(14_400_000)).toBe("4h");
  });

  it("round-trips any duration that lands on a single unit", () => {
    for (const s of ["1s", "59s", "1m", "10m", "1h", "4h"]) {
      const ms = parseDuration(s) as number;
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });

  it("is a DISPLAY format, so a compound result is deliberately not re-parseable", () => {
    // The guide's own example, 552000 -> "9m12s", is not valid AUTOMATION.md syntax. That is
    // intended: formatDuration renders for humans, it is not the inverse of parseDuration.
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(parseDuration(formatDuration(90_000))).toBeUndefined();
  });

  it("is defensive about nonsense input", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});
