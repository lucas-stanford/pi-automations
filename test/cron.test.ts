import { describe, expect, it } from "vitest";

import {
  clockIn,
  describeNext,
  isoWithOffset,
  makeCron,
  nextTick,
  previousTick,
  schedulePeriodMs,
  staggerCapFor,
  ticksBetween,
  validateCron,
} from "../src/cron.js";
import { staggerSeconds } from "../src/stagger.js";
import type { Schedule } from "../src/types.js";

describe("previousTick", () => {
  it("returns the most recent instant at or before the moment given", () => {
    const s = sched("0 7 * * *", "UTC");
    expect(previousTick(s, new Date("2026-09-17T09:00:00.000Z"))?.toISOString()).toBe(
      "2026-09-17T07:00:00.000Z",
    );
  });

  it("includes an instant that is exactly now", () => {
    const s = sched("0 7 * * *", "UTC");
    expect(previousTick(s, new Date("2026-09-17T07:00:00.000Z"))?.toISOString()).toBe(
      "2026-09-17T07:00:00.000Z",
    );
  });

  it("returns yesterday's instant before today's has happened", () => {
    const s = sched("0 7 * * *", "UTC");
    expect(previousTick(s, new Date("2026-09-17T06:59:00.000Z"))?.toISOString()).toBe(
      "2026-09-16T07:00:00.000Z",
    );
  });

  it("works for a per-minute schedule without walking a long window", () => {
    const s = sched("* * * * *", "UTC");
    expect(previousTick(s, new Date("2026-09-17T12:00:30.000Z"))?.toISOString()).toBe(
      "2026-09-17T12:00:00.000Z",
    );
  });

  it("handles an irregular schedule across its long gap", () => {
    // Monday 09:00, asked on the following Sunday: the answer is that Monday, three days back.
    const s = sched("0 9 * * MON", "UTC");
    expect(previousTick(s, new Date("2026-09-20T12:00:00.000Z"))?.toISOString()).toBe(
      "2026-09-14T09:00:00.000Z",
    );
  });

  it("returns nothing when the pattern has no instant in range", () => {
    expect(previousTick(sched("0 0 30 FEB *", "UTC"), new Date("2026-09-17T12:00:00Z")))
      .toBeUndefined();
  });
});

describe("nextTick", () => {
  it("is strictly after the instant given", () => {
    const s = sched("0 7 * * *", "UTC");
    const exact = new Date("2026-09-17T07:00:00.000Z");
    expect(nextTick(s, exact)?.toISOString()).toBe("2026-09-18T07:00:00.000Z");
  });
});

const sched = (cron: string, timezone?: string): Schedule => ({
  cron,
  catchUp: "skip",
  ...(timezone ? { timezone } : {}),
});

describe("validateCron — accepts", () => {
  it("accepts the expressions the specification page shows", () => {
    for (const expr of [
      "0 7 * * MON-FRI",
      "0 */4 * * MON-FRI",
      "0 9 * * MON",
      "0 8 * * MON-FRI",
      "*/15 * * * *",
      "0 0 * * *",
      "* * * * *",
    ]) {
      expect(validateCron(expr), expr).toBeUndefined();
    }
  });

  it("accepts three-letter names in either case, in both name fields", () => {
    for (const expr of ["0 0 1 JAN *", "0 0 1 jan *", "0 7 * * SUN", "0 7 * * sat"]) {
      expect(validateCron(expr), expr).toBeUndefined();
    }
  });

  it("accepts names that contain extended-cron letters", () => {
    // Regression: a blind [LWH#?] scan over the whole field rejected these, because WED has a W,
    // JUL has an L and THU has an H. The vocabulary check must run per token, after name lookup.
    for (const expr of [
      "0 7 * * WED",
      "0 7 * * THU",
      "0 0 1 JUL *",
      "0 7 * * MON,WED,FRI",
      "0 0 1 JUL-AUG *",
    ]) {
      expect(validateCron(expr), expr).toBeUndefined();
    }
  });

  it("accepts lists, ranges and stepped ranges", () => {
    for (const expr of [
      "0,30 * * * *",
      "0-30 * * * *",
      "0-30/5 * * * *",
      "0 9,17 * * MON-FRI",
      "0 0 1,15 * *",
      "0 7 * * MON,WED,FRI",
    ]) {
      expect(validateCron(expr), expr).toBeUndefined();
    }
  });

  it("accepts day-of-week 7 as Sunday", () => {
    expect(validateCron("0 7 * * 7")).toBeUndefined();
  });

  it("tolerates surrounding whitespace", () => {
    expect(validateCron("  0 7 * * *  ")).toBeUndefined();
  });
});

describe("validateCron — refuses", () => {
  it("refuses a six-field expression with the specification's own wording", () => {
    expect(validateCron("0 7 * * MON-FRI *")).toBe(
      '"0 7 * * MON-FRI *" is not a 5-field cron expression',
    );
  });

  it("refuses too few fields", () => {
    expect(validateCron("0 7 * *")).toBe('"0 7 * *" is not a 5-field cron expression');
    expect(validateCron("")).toBe('"" is not a 5-field cron expression');
  });

  it("refuses nicknames and says what to write instead", () => {
    const r = validateCron("@daily");
    expect(r).toContain("is a nickname");
    expect(r).toContain('"0 0 * * *"');
  });

  it("refuses an out-of-range value and names the field", () => {
    expect(validateCron("60 * * * *")).toBe(
      '"60 * * * *" is not a valid cron expression — minute "60" is out of range 0-59',
    );
    expect(validateCron("* 24 * * *")).toContain("hour");
    expect(validateCron("* * 0 * *")).toContain("day-of-month");
    expect(validateCron("* * * 13 *")).toContain("month");
    expect(validateCron("* * * * 8")).toContain("day-of-week");
  });

  it("refuses the extended vocabulary croner would otherwise accept", () => {
    for (const expr of ["0 0 L * *", "0 7 * * 1#2", "0 7 ? * *", "0 0 1W * *", "0 H * * *"]) {
      const r = validateCron(expr);
      expect(r, expr).toBeDefined();
      expect(r, expr).toContain("Draft 0.2 does not define");
    }
  });

  it("refuses a name in a field that takes no names", () => {
    expect(validateCron("MON 7 * * *")).toContain("minute");
    expect(validateCron("0 JAN * * *")).toContain("hour");
  });

  it("refuses a month name in the day-of-week field and vice versa", () => {
    expect(validateCron("0 7 * MON *")).toContain("month");
    expect(validateCron("0 7 * * JAN")).toContain("day-of-week");
  });

  it("refuses a zero or missing step", () => {
    expect(validateCron("*/0 * * * *")).toContain("step must be 1 or more");
    expect(validateCron("*/ * * * *")).toContain("step that is not a number");
  });

  it("refuses a step on a single value, which reads as a range but is not one", () => {
    expect(validateCron("5/15 * * * *")).toContain("applies a step to a single value");
  });

  it("refuses a backwards range", () => {
    expect(validateCron("30-10 * * * *")).toContain("runs backwards");
  });

  it("refuses an empty list entry", () => {
    expect(validateCron("0,,30 * * * *")).toContain("empty list entry");
  });

  it("refuses a non-string", () => {
    expect(validateCron(undefined)).toContain("not a 5-field cron expression");
    expect(validateCron(42)).toContain("not a 5-field cron expression");
  });

  it("always returns exactly one line", () => {
    for (const expr of ["@daily", "0 0 L * *", "60 * * * *", "0 7 * *", "30-10 * * * *"]) {
      expect(String(validateCron(expr)).split("\n"), expr).toHaveLength(1);
    }
  });
});

describe("makeCron", () => {
  it("evaluates in the schedule's zone", () => {
    const la = makeCron(sched("0 7 * * *", "America/Los_Angeles"));
    const utc = makeCron(sched("0 7 * * *", "UTC"));
    const from = new Date("2026-09-17T00:00:00.000Z");
    expect(la.nextRun(from)?.toISOString()).toBe("2026-09-17T14:00:00.000Z");
    expect(utc.nextRun(from)?.toISOString()).toBe("2026-09-17T07:00:00.000Z");
  });

  it("uses POSIX OR semantics for day-of-month and day-of-week", () => {
    // legacyMode. Without it, "0 0 13 * FRI" means Friday-the-13th only.
    const runs = makeCron(sched("0 0 13 * FRI", "UTC"))
      .nextRuns(3, new Date("2026-02-01T00:00:00.000Z"))
      .map((d) => d.toISOString().slice(0, 10));
    expect(runs).toEqual(["2026-02-06", "2026-02-13", "2026-02-20"]);
  });
});

describe("ticksBetween", () => {
  it("is exclusive of the lower bound and inclusive of the upper", () => {
    const s = sched("0 * * * *", "UTC");
    const ticks = ticksBetween(
      s,
      new Date("2026-09-17T01:00:00.000Z"),
      new Date("2026-09-17T04:00:00.000Z"),
    );
    expect(ticks.map((d) => d.toISOString())).toEqual([
      "2026-09-17T02:00:00.000Z",
      "2026-09-17T03:00:00.000Z",
      "2026-09-17T04:00:00.000Z",
    ]);
  });

  it("returns nothing when the window is empty or inverted", () => {
    const s = sched("0 * * * *", "UTC");
    const t = new Date("2026-09-17T01:00:00.000Z");
    expect(ticksBetween(s, t, t)).toEqual([]);
    expect(ticksBetween(s, new Date("2026-09-17T05:00:00Z"), t)).toEqual([]);
  });

  it("respects the max bound rather than materialising an unbounded walk", () => {
    const s = sched("* * * * *", "UTC");
    const ticks = ticksBetween(
      s,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2027-01-01T00:00:00.000Z"),
      5,
    );
    expect(ticks).toHaveLength(5);
  });

  it("cannot spin on a boundary instant, because nextRun is strictly after", () => {
    const s = sched("0 7 * * *", "UTC");
    const exact = new Date("2026-09-17T07:00:00.000Z");
    expect(ticksBetween(s, exact, new Date("2026-09-18T07:00:00.000Z")).map((d) => d.toISOString()))
      .toEqual(["2026-09-18T07:00:00.000Z"]);
  });
});

describe("ticksBetween — daylight saving", () => {
  it("yields one tick per day across spring forward, shifting to 03:00 on the missing hour", () => {
    const s = sched("0 2 * * *", "America/Los_Angeles");
    const ticks = ticksBetween(
      s,
      new Date("2026-03-06T00:00:00-08:00"),
      new Date("2026-03-11T00:00:00-07:00"),
    );
    expect(ticks.map((d) => d.toISOString())).toEqual([
      "2026-03-06T10:00:00.000Z",
      "2026-03-07T10:00:00.000Z",
      "2026-03-08T10:00:00.000Z", // 02:00 does not exist; croner fires at 03:00 local
      "2026-03-09T09:00:00.000Z",
      "2026-03-10T09:00:00.000Z",
    ]);
    expect(ticks.map((d) => clockIn(d, "America/Los_Angeles"))).toEqual([
      "02:00",
      "02:00",
      "03:00",
      "02:00",
      "02:00",
    ]);
  });

  it("yields one tick per day across fall back, not two on the repeated hour", () => {
    const s = sched("0 2 * * *", "America/Los_Angeles");
    const ticks = ticksBetween(
      s,
      new Date("2026-10-30T00:00:00-07:00"),
      new Date("2026-11-04T00:00:00-08:00"),
    );
    expect(ticks).toHaveLength(5);
    expect(ticks.map((d) => clockIn(d, "America/Los_Angeles"))).toEqual([
      "02:00",
      "02:00",
      "02:00",
      "02:00",
      "02:00",
    ]);
  });
});

describe("schedulePeriodMs and staggerCapFor", () => {
  const from = new Date("2026-09-17T12:00:00.000Z");

  it("measures the gap of a regular schedule", () => {
    expect(schedulePeriodMs(sched("* * * * *", "UTC"), from)).toBe(60_000);
    expect(schedulePeriodMs(sched("0 * * * *", "UTC"), from)).toBe(3_600_000);
    expect(schedulePeriodMs(sched("*/15 * * * *", "UTC"), from)).toBe(900_000);
  });

  it("takes the SHORTEST gap of an irregular schedule, not a typical one", () => {
    // Mon-Fri at 07:00 is one day four times and three days once. The one-day gap is what anything
    // fitting between two fires has to respect.
    expect(schedulePeriodMs(sched("0 7 * * MON-FRI", "UTC"), from)).toBe(86_400_000);
  });

  it("keeps the stagger strictly inside the schedule's own slot", () => {
    expect(staggerCapFor(sched("* * * * *", "UTC"), 120, from)).toBe(30);
    expect(staggerCapFor(sched("*/2 * * * *", "UTC"), 120, from)).toBe(60);
  });

  it("leaves the configured cap alone when the schedule is comfortably longer", () => {
    expect(staggerCapFor(sched("0 * * * *", "UTC"), 120, from)).toBe(120);
    expect(staggerCapFor(sched("0 7 * * *", "UTC"), 120, from)).toBe(120);
  });

  it("falls back to the configured cap without a schedule", () => {
    expect(staggerCapFor(undefined, 120, from)).toBe(120);
  });

  it("guarantees the offset can never swallow a whole period", () => {
    for (const cron of ["* * * * *", "*/2 * * * *", "*/5 * * * *", "0 * * * *"]) {
      const s = sched(cron, "UTC");
      const period = schedulePeriodMs(s, from) as number;
      const cap = staggerCapFor(s, 120, from);
      for (const key of ["a", "b", "user:/r:x", "repository:/r:y"]) {
        const offset = staggerSeconds(key, cap) * 1000;
        expect(offset, `${cron} ${key}`).toBeLessThan(period);
      }
    }
  });
});

describe("describeNext", () => {
  const from = new Date("2026-09-17T12:00:00.000Z");

  it("shows the cron clock plus the offset, not the staggered clock", () => {
    const s = sched("0 7 * * *", "UTC");
    expect(describeNext(s, from, 47)).toBe("07:00 +0:47 tomorrow");
  });

  it("omits the offset when staggering is switched off", () => {
    const s = sched("0 7 * * *", "UTC");
    expect(describeNext(s, from, 0)).toBe("07:00 tomorrow");
  });

  it("counts down in minutes when the fire is within the hour", () => {
    const s = sched("0 * * * *", "UTC");
    expect(describeNext(s, new Date("2026-09-17T12:19:00.000Z"), 72)).toBe("13:00 +1:12 in 42m");
  });

  it("says today for a later fire on the same day", () => {
    const s = sched("0 23 * * *", "UTC");
    expect(describeNext(s, from, 0)).toBe("23:00 today");
  });

  it("names the weekday inside a week", () => {
    const s = sched("0 9 * * MON", "UTC");
    expect(describeNext(s, from, 0)).toBe("09:00 Monday");
  });

  it("uses the schedule's own zone for the clock", () => {
    const s = sched("0 7 * * *", "America/Los_Angeles");
    expect(describeNext(s, from, 0).startsWith("07:00")).toBe(true);
  });

  it("returns an em dash when the pattern has no future run", () => {
    const s = sched("0 0 30 FEB *", "UTC");
    expect(describeNext(s, from, 0)).toBe("—");
  });
});

describe("isoWithOffset", () => {
  it("carries the schedule zone's offset rather than normalising to Z", () => {
    const at = new Date("2026-09-17T14:00:00.000Z");
    expect(isoWithOffset(at, "America/Los_Angeles")).toBe("2026-09-17T07:00:00-07:00");
  });

  it("uses Z for UTC", () => {
    expect(isoWithOffset(new Date("2026-09-17T07:00:00.000Z"), "UTC")).toBe(
      "2026-09-17T07:00:00Z",
    );
  });

  it("reflects the standard-time offset on the other side of a transition", () => {
    const at = new Date("2026-12-17T15:00:00.000Z");
    expect(isoWithOffset(at, "America/Los_Angeles")).toBe("2026-12-17T07:00:00-08:00");
  });

  it("round-trips to the same instant", () => {
    const at = new Date("2026-09-17T14:00:00.000Z");
    for (const tz of ["UTC", "America/Los_Angeles", "Europe/Berlin", "Asia/Kolkata"]) {
      expect(Date.parse(isoWithOffset(at, tz))).toBe(at.getTime());
    }
  });
});
