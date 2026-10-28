import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { notificationText, notifyFailed } from "../src/notify.js";
import { openCommand, renderReport } from "../src/report.js";
import { sparkline, summarise } from "../src/ui/sparkline.js";
import { outcomeGlyph } from "../src/ui/glyphs.js";
import type { RunRecord, Status } from "../src/types.js";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const HOME = "/home/alice";

function status(over: Partial<Status> = {}): Status {
  return {
    key: "user:/home/alice/.agents/automations:daily-briefing",
    name: "daily-briefing",
    scope: "user",
    root: { path: "/home/alice/.agents/automations", scope: "user", kind: "agents" },
    dir: "/home/alice/.agents/automations/daily-briefing",
    state: "armed",
    effectiveTimeoutMs: 600_000,
    staggerSec: 47,
    nextFire: "2026-09-18T07:00:47-07:00",
    automation: {
      name: "daily-briefing",
      description: "Summarise overnight.",
      enabled: true,
      on: { schedule: { cron: "0 7 * * MON-FRI", catchUp: "skip" }, manual: true },
      hooks: { pre: [{ script: "a.js" }], post: [{ script: "b.js" }] },
      body: "Write it.",
    },
    ...over,
  };
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    key: "user:/home/alice/.agents/automations:daily-briefing",
    name: "daily-briefing",
    scope: "user",
    root: "/home/alice/.agents/automations",
    trigger: "schedule",
    late: false,
    recordedAt: NOW.toISOString(),
    startedAt: new Date(NOW.getTime() - 552_000).toISOString(),
    endedAt: NOW.toISOString(),
    outcome: "ok",
    model: "anthropic/claude-sonnet-4-5:low",
    ...over,
  };
}

describe("glyphs", () => {

  it("marks a failure differently from a low bar", () => {
    // A skipped run is often exactly right, so it must not look like a failure.
    expect(outcomeGlyph("failed")).toBe("✗");
    expect(outcomeGlyph("skipped")).not.toBe(outcomeGlyph("failed"));
    expect(outcomeGlyph("ok")).not.toBe(outcomeGlyph("skipped"));
  });
});

describe("sparkline", () => {
  it("renders one glyph per run, newest last", () => {
    const s = sparkline(["ok", "ok", "failed", "skipped"]);
    expect([...s]).toHaveLength(4);
    expect(s.endsWith(outcomeGlyph("skipped"))).toBe(true);
  });

  it("keeps only the most recent runs", () => {
    expect([...sparkline(Array(20).fill("ok"), 7)]).toHaveLength(7);
  });

  it("is empty when there is no history", () => {
    expect(sparkline([])).toBe("");
    expect(summarise([])).toBe("never run");
  });

  it("summarises counts for surfaces with no room for glyphs", () => {
    expect(summarise(["ok", "ok", "failed"])).toBe("2 ok · 1 failed");
  });
});

describe("renderReport", () => {
  const html = () =>
    renderReport(
      [
        status(),
        status({
          key: "repository:/srv/repo/.agents/automations:stale-pr-nudge",
          name: "stale-pr-nudge",
          scope: "repository",
          root: { path: "/srv/repo/.agents/automations", scope: "repository", kind: "agents" },
          dir: "/srv/repo/.agents/automations/stale-pr-nudge",
          state: "off",
          reason: "not armed — /automations arm stale-pr-nudge",
        }),
      ],
      {
        "user:/home/alice/.agents/automations:daily-briefing": [
          record(),
          record({ id: "r2", outcome: "failed", error: { kind: "timeout", message: "ran long" } }),
        ],
      },
      DEFAULTS,
      NOW,
      { home: HOME },
    );

  it("is completely self-contained — no network, no script", () => {
    const out = html();
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/<link\b/i);
    expect(out).toContain("<style>");
  });

  it("declares a colour scheme so it is readable in either theme", () => {
    expect(html()).toContain('<meta name="color-scheme" content="dark light">');
  });

  it("uses the same USER / rule / REPOSITORY grouping as the listing", () => {
    const out = html();
    const user = out.indexOf("<h2>User");
    const rule = out.indexOf("<hr>");
    const project = out.indexOf("<h2>Repository");
    expect(user).toBeGreaterThan(-1);
    expect(rule).toBeGreaterThan(user);
    expect(project).toBeGreaterThan(rule);
  });

  it("shows every state, the reason, and the run history", () => {
    const out = html();
    expect(out).toContain("daily-briefing");
    expect(out).toContain("stale-pr-nudge");
    expect(out).toContain("not armed — /automations arm stale-pr-nudge");
    expect(out).toContain("9m12s");
    expect(out).toContain("anthropic/claude-sonnet-4-5:low");
    expect(out).toContain("ran long");
  });

  it("escapes anything that came from a file", () => {
    const out = renderReport(
      [
        status({
          name: "x",
          reason: '<img src=x onerror="alert(1)"> & "quoted"',
        }),
      ],
      {},
      DEFAULTS,
      NOW,
      { home: HOME },
    );
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x");
    expect(out).toContain("&amp;");
  });

  it("says none rather than rendering an empty table", () => {
    const out = renderReport([], {}, DEFAULTS, NOW, { home: HOME });
    expect(out).toContain("none");
    expect(out).toContain("Agent Automations");
  });

  it("omits the repository section entirely when there are no repository automations", () => {
    const out = renderReport([status()], {}, DEFAULTS, NOW, { home: HOME });
    expect(out).not.toContain("<h2>Repository");
    expect(out).not.toContain("<hr>");
  });
});

describe("openCommand", () => {
  it("uses the platform's own opener", () => {
    expect(openCommand("/f.html", "darwin")).toEqual({ file: "open", args: ["/f.html"] });
    expect(openCommand("/f.html", "linux")).toEqual({ file: "xdg-open", args: ["/f.html"] });
    expect(openCommand("C:\\f.html", "win32")).toEqual({ file: "explorer.exe", args: ["C:\\f.html"] });
  });
});

describe("notify", () => {
  it("names the automation and the failure", () => {
    const t = notificationText(
      record({ outcome: "failed", error: { kind: "timeout", message: "ran long" } }),
    );
    expect(t.title).toBe("daily-briefing failed");
    // The same sentence the log, the entry and the report show — a toast that phrases the failure
    // differently makes a person wonder whether it is even the same run. Plus how long it lasted,
    // which is the first thing you want to know about a timeout.
    expect(t.body).toBe("timeout: ran long (after 9m12s)");
  });

  it("falls back to the reason when there is no error object", () => {
    expect(notificationText(record({ outcome: "failed", reason: "hook died" })).body).toBe(
      "hook died (after 9m12s)",
    );
  });

  it("never notifies anything but a failure", async () => {
    // Every quiet morning producing a notification teaches people to ignore them.
    for (const outcome of ["ok", "skipped", "missed", "aborted"] as const) {
      await expect(notifyFailed(record({ outcome }))).resolves.toBeUndefined();
    }
  });

  it("never throws, even on a platform with no notifier", async () => {
    await expect(
      notifyFailed(record({ outcome: "failed" }), "aix" as NodeJS.Platform),
    ).resolves.toBeUndefined();
  });
});
