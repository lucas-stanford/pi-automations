import { describe, expect, it } from "vitest";

import { AutomationError, ModelError, oneLine } from "../src/errors.js";
import { fnv1a, formatStagger, staggerSeconds } from "../src/stagger.js";

describe("AutomationError", () => {
  it("renders exactly one line, field first", () => {
    const e = new AutomationError("on.schedule.timezone", '"PST" is not an IANA zone — try America/Los_Angeles');
    expect(e.message).toBe(
      'on.schedule.timezone: "PST" is not an IANA zone — try America/Los_Angeles',
    );
    expect(e.message.split("\n")).toHaveLength(1);
  });

  it("keeps the halves addressable so callers can re-render", () => {
    const e = new AutomationError("timeout", "6h exceeds this host's maximum of 4h");
    expect(e.field).toBe("timeout");
    expect(e.fix).toBe("6h exceeds this host's maximum of 4h");
  });

  it("is a real Error subclass", () => {
    expect(new AutomationError("a", "b")).toBeInstanceOf(Error);
  });
});

describe("ModelError", () => {
  it("is an AutomationError so one catch handles both", () => {
    const e = new ModelError("model", 'provider "anthropc" is not registered');
    expect(e).toBeInstanceOf(AutomationError);
    expect(e.name).toBe("ModelError");
  });
});

describe("oneLine", () => {
  it("passes an AutomationError through untouched", () => {
    expect(oneLine(new AutomationError("f", "x"))).toBe("f: x");
  });

  it("takes only the first line of a multi-line error", () => {
    expect(oneLine(new Error("boom\n  at somewhere\n  at else"))).toBe("boom");
  });

  it("falls back to the error name when the message is empty", () => {
    expect(oneLine(new TypeError(""))).toBe("TypeError");
  });

  it("stringifies a non-Error throw", () => {
    expect(oneLine("plain string")).toBe("plain string");
    expect(oneLine(42)).toBe("42");
  });
});

describe("fnv1a", () => {
  it("matches the reference vectors for 32-bit FNV-1a", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });

  it("stays inside the unsigned 32-bit range", () => {
    for (const s of ["", "a", "foobar", "user:/x:y", "z".repeat(1000)]) {
      const h = fnv1a(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it("hashes bytes, not code units, so non-ASCII is stable", () => {
    expect(fnv1a("é")).toBe(fnv1a(Buffer.from("é", "utf8").toString("utf8")));
  });
});

describe("staggerSeconds", () => {
  it("is deterministic", () => {
    expect(staggerSeconds("user:/r:daily-briefing", 120)).toBe(
      staggerSeconds("user:/r:daily-briefing", 120),
    );
  });

  it("stays inside the configured window", () => {
    for (const k of ["a", "b", "user:/r:x", "repository:/r:x"]) {
      const s = staggerSeconds(k, 120);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(120);
    }
  });

  it("separates the same name in different scopes", () => {
    expect(staggerSeconds("user:/r:x", 120)).not.toBe(staggerSeconds("repository:/r:x", 120));
  });

  it("returns 0 when staggering is switched off", () => {
    expect(staggerSeconds("anything", 0)).toBe(0);
    expect(staggerSeconds("anything", -5)).toBe(0);
  });
});

describe("formatStagger", () => {
  it("renders the listing form", () => {
    expect(formatStagger(47)).toBe("+0:47");
    expect(formatStagger(72)).toBe("+1:12");
    expect(formatStagger(0)).toBe("+0:00");
  });
});
