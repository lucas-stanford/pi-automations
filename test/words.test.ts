import { describe, expect, it } from "vitest";

import type { Automation, RunRecord } from "../src/types.js";
import { agoLong, agoWords, armWords, errorHint, runningWords, spanLong, startPhrase, usualMs, whenLong } from "../src/ui/words.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

function automation(on: Automation["on"], scripts: string[] = []): Automation {
  return {
    name: "a",
    description: "d",
    enabled: true,
    on,
    hooks: { pre: scripts.map((script) => ({ script })), post: [] },
    body: "b",
  };
}

function rec(id: string, minutesAgo: number, outcome: RunRecord["outcome"] = "ok", durationMinutes = 1): RunRecord {
  const started = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  const ended = new Date(Date.parse(started) + durationMinutes * 60_000).toISOString();
  return {
    id,
    key: "k",
    name: "a",
    scope: "user",
    root: "/r",
    trigger: "manual",
    late: false,
    recordedAt: ended,
    startedAt: started,
    endedAt: outcome === "ok" ? ended : undefined,
    outcome,
  };
}

describe("automation UI words", () => {
  it("uses coarse ago words past an hour", () => {
    expect(agoWords(new Date(NOW.getTime() - 59 * 60_000).toISOString(), NOW)).toBe("59m ago");
    expect(agoWords(new Date(NOW.getTime() - 10 * 60 * 60_000).toISOString(), NOW)).toBe("10h ago");
    expect(agoWords(new Date(NOW.getTime() - 2 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("2d ago");
  });

  it("describes start phrases for watch/manual, schedule/manual, manual-only, and schedule/watch", () => {
    expect(startPhrase(automation({ manual: true, watch: { script: "scripts/watch.js", every: "5m" } }))).toBe(
      "starts when its watch finds something new, or when you run it",
    );
    expect(startPhrase(automation({ manual: true, schedule: { cron: "0 9 * * 1-5" } }))).toBe(
      "runs weekdays 09:00, or when you run it",
    );
    expect(startPhrase(automation({ manual: true }))).toBe("runs only when you run it");
    expect(startPhrase(automation({ schedule: { cron: "0 9 * * 1-5" }, watch: { script: "scripts/watch.js", every: "5m" } }))).toBe(
      "runs weekdays 09:00 and when its watch finds something new",
    );
  });

  it("computes usualMs as the median ok duration only when at least two samples exist", () => {
    expect(usualMs([rec("one", 1)])).toBeUndefined();
    expect(usualMs([rec("ten", 30, "ok", 10), rec("twelve", 20, "ok", 12), rec("fourteen", 10, "ok", 14), rec("bad", 40, "failed", 30)])).toBe(12 * 60_000);
    expect(usualMs([rec("ten", 20, "ok", 10), rec("twelve", 10, "ok", 12)])).toBe(11 * 60_000);
  });

  it("writes arm words from scripts or prompt and gives cron hints only when known", () => {
    expect(armWords(automation({ manual: true, watch: { script: "scripts/new-tags.js", every: "15m" } }, ["scripts/pre.js"]))).toBe(
      "arming lets scripts/new-tags.js, scripts/pre.js run every 15m on this machine",
    );
    expect(armWords(automation({ manual: true }))).toBe("arming lets its prompt run when you run it on this machine");
    expect(errorHint('on.schedule.cron: "every morning" is not a 5-field cron expression')).toContain("a cron is five fields");
    expect(errorHint("unknown field retry")).toBeUndefined();
  });
});

describe("words for a sentence", () => {
  it("spells a span out: seconds, minutes, hours and days, singular and plural", () => {
    expect(spanLong(45_000)).toBe("45 seconds");
    expect(spanLong(60_000)).toBe("1 minute");
    expect(spanLong(3 * 60_000)).toBe("3 minutes");
    expect(spanLong(3_600_000)).toBe("1 hour");
    expect(spanLong(80 * 60_000)).toBe("1 hour 20 minutes");
    expect(spanLong(2 * 86_400_000)).toBe("2 days");
    expect(agoLong(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW)).toBe("3 hours ago");
    expect(agoLong(NOW.toISOString(), NOW)).toBe("just now");
  });

  it("says when, with `at` before a clock time", () => {
    const local = new Date(2026, 9, 22, 13, 50);
    expect(whenLong(new Date(2026, 9, 22, 13, 51).toISOString(), local)).toBe("in 1 minute");
    expect(whenLong(new Date(2026, 9, 22, 22, 0).toISOString(), local)).toBe("today at 22:00");
    expect(whenLong(new Date(2026, 9, 23, 8, 0).toISOString(), local)).toBe("tomorrow at 08:00");
    expect(whenLong(new Date(2026, 9, 26, 7, 0).toISOString(), local)).toBe("Mon at 07:00");
  });

  it("says how a run is going, naming the unit once when both are in it", () => {
    expect(runningWords(3 * 60_000, 7 * 60_000, 3_600_000)).toBe("3 minutes so far, usually 7. Gives up at 1 hour.");
    expect(runningWords(23_000, 7 * 60_000, 0)).toBe("23 seconds so far, usually 7 minutes.");
    expect(runningWords(60_000, undefined, 600_000)).toBe("1 minute so far. Gives up at 10 minutes.");
  });
});