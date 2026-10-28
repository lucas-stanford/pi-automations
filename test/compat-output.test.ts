/** What the surfaces LOOK like, frozen at two widths. */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { discover } from "../src/discover.js";
import { GLYPH, outcomeGlyph } from "../src/ui/glyphs.js";
import { renderListing, statusLine } from "../src/listing.js";
import { renderReport } from "../src/report.js";
import { workspaceRefusalMessage } from "../src/run.js";
import { computeStatuses } from "../src/status.js";
import { Trust } from "../src/trust.js";
import { buildSessionLines } from "../src/ui/session-view.js";
import { parseSessionLines } from "../src/providers/pi/transcript.js";
import { outputLines, summaryLine } from "../src/summary.js";
import { PLAIN_THEME } from "../src/ui/theme.js";
import { visibleWidth } from "../src/ui/width.js";
import type { Root, RunRecord, Status } from "../src/types.js";
import { cleanupTempDirs } from "./helpers/temp.js";
import { HOST_NOW, isolatedAutomation } from "./helpers/isolated-host.js";

afterAll(cleanupTempDirs);

const FIXTURES = path.join(import.meta.dirname, "compat-fixtures");
const WIDTHS = [80, 120] as const;

/** A home that exists only as a string, so the rendered output cannot vary by machine. */
const HOME = "/home/tester";
const USER_ROOT = `${HOME}/.agents/automations`;
const PROJECT_DIR = `${HOME}/work/example`;
const PROJECT_ROOT = `${PROJECT_DIR}/.agents/automations`;

function root(p: string, scope: "user" | "repository"): Root {
  return { path: p, scope, kind: "agents" };
}

function status(over: Partial<Status> & { name: string }): Status {
  const scope = over.scope ?? "user";
  const r = over.root ?? root(scope === "user" ? USER_ROOT : PROJECT_ROOT, scope);
  return {
    key: `${scope}:${r.path}:${over.name}`,
    scope,
    root: r,
    dir: `${r.path}/${over.name}`,
    state: "armed",
    effectiveTimeoutMs: 600_000,
    staggerSec: 0,
    ...over,
  } as Status;
}

function automation(over: Record<string, unknown> = {}) {
  return {
    name: "x",
    description: "d",
    enabled: true,
    on: {},
    hooks: { pre: [], post: [] },
    body: "Do the thing.",
    ...over,
  } as NonNullable<Status["automation"]>;
}

const STATUSES: Status[] = [
  status({
    name: "daily-briefing",
    state: "armed",
    automation: automation({
      name: "daily-briefing",
      on: { schedule: { cron: "0 7 * * *", timezone: "America/Los_Angeles" } },
      hooks: { pre: [{ script: "fetch.js" }], post: [{ script: "post.js" }] },
    }),
    nextFire: "2026-09-18T07:00:00-07:00",
    last: { outcome: "ok", at: "2026-09-17T14:02:11.000Z", durationMs: 131_000 },
  }),
  status({
    name: "inbox-triage",
    state: "armed",
    flow: true,
    automation: automation({
      name: "inbox-triage",
      // Every schedule names its timezone. Without one, `describeNext` uses the host's, and the
      // frozen NEXT column would read differently on a machine in another offset.
      on: { schedule: { cron: "*/30 * * * *", timezone: "UTC" } },
      hooks: { pre: [], post: [] },
    }),
    nextFire: "2026-09-17T14:30:00Z",
  }),
  status({
    name: "quiet-one",
    state: "disabled",
    automation: automation({ name: "quiet-one", on: { manual: true } }),
  }),
  status({
    name: "broken",
    state: "invalid",
    reason: "unknown field: retry",
  }),
  status({
    name: "repo-thing",
    scope: "repository",
    state: "off",
    reason: "repository automations are off until you arm them",
    automation: automation({ name: "repo-thing", on: { manual: true } }),
  }),
];

const RECORDS: Record<string, RunRecord[]> = {
  [`user:${USER_ROOT}:daily-briefing`]: [
    {
      id: "20260917T070000-e5f6",
      key: `user:${USER_ROOT}:daily-briefing`,
      name: "daily-briefing",
      scope: "user",
      root: USER_ROOT,
      trigger: "schedule",
      scheduledFor: "2026-09-17T07:00:00-07:00",
      late: false,
      recordedAt: "2026-09-17T14:02:11.000Z",
      startedAt: "2026-09-17T14:00:00.000Z",
      endedAt: "2026-09-17T14:02:11.000Z",
      outcome: "ok",
      model: "anthropic/claude-sonnet-4-5",
      timeout: "10m",
      hooks: [],
      output: { text: "12 new, 3 urgent." },
    },
    {
      id: "20260916T070000-c3d4",
      key: `user:${USER_ROOT}:daily-briefing`,
      name: "daily-briefing",
      scope: "user",
      root: USER_ROOT,
      trigger: "schedule",
      late: true,
      recordedAt: "2026-09-16T14:00:02.000Z",
      startedAt: "2026-09-16T14:00:00.000Z",
      endedAt: "2026-09-16T14:00:02.000Z",
      outcome: "failed",
      error: { kind: "model", message: "no credentials for anthropic" },
      model: "anthropic/claude-sonnet-4-5",
      timeout: "10m",
      hooks: [],
    },
  ],
};

// The approved behaviour change, as a person meets it.
//
// An automation that asked for an isolated worktree, could not have one, and was therefore refused.
// Frozen at both widths so the reason and the remediation stay readable with long paths.
const REFUSAL_KEY = `repository:${PROJECT_ROOT}:isolated-nightly`;
const REFUSAL_INTENDED =
  "/var/folders/_9/j7x2k1qd3p16y8cvn4bqzt0r0000gn/T/pi-automations-worktree-a1b2c3d4/isolated-nightly";
const REFUSAL: RunRecord = {
  id: "20260917T140000-w0rk",
  key: REFUSAL_KEY,
  name: "isolated-nightly",
  scope: "repository",
  root: PROJECT_ROOT,
  trigger: "schedule",
  scheduledFor: "2026-09-17T07:00:00Z",
  late: false,
  recordedAt: "2026-09-17T14:00:00.000Z",
  startedAt: "2026-09-17T14:00:00.000Z",
  endedAt: "2026-09-17T14:00:00.000Z",
  outcome: "failed",
  error: {
    kind: "host",
    message: workspaceRefusalMessage({
      key: REFUSAL_KEY,
      repository: PROJECT_DIR,
      // Long, because that is the case the widths exist to measure: a short path fits at both and
      // proves nothing about what a reader keeps when it does not.
      intended: REFUSAL_INTENDED,
      detail: `fatal: destination path '${REFUSAL_INTENDED}' already exists and is not an empty directory`,
    }),
  },
};

const REFUSAL_STATUS: Status = status({
  name: "isolated-nightly",
  scope: "repository",
  state: "armed",
  automation: automation({
    name: "isolated-nightly",
    on: { schedule: { cron: "0 7 * * *", timezone: "UTC" } },
  }),
  nextFire: "2026-09-18T07:00:00Z",
  last: { outcome: "failed", at: "2026-09-17T14:00:00.000Z", reason: "host", durationMs: 0 },
});

// The whole frozen picture for one width.
//
// Assembled from the real renderers, in the order a person meets them: the listing, the one-line
// status, the report, and the session pane.
function renderAll(width: number): string {
  const out: string[] = [];

  out.push(`=== listing (width ${width}) ===`);
  out.push(
    ...renderListing(STATUSES, {
      home: HOME,
      projectRoots: [PROJECT_DIR],
      width,
      now: HOST_NOW,
      locale: "en",
    }),
  );

  out.push("");
  out.push(`=== status line (width ${width}) ===`);
  out.push(statusLine(STATUSES, HOST_NOW, "en"));

  out.push("");
  out.push(`=== report (width ${width}) ===`);
  out.push(
    ...renderReport(STATUSES, RECORDS, DEFAULTS, HOST_NOW, {
      home: HOME,
      projectRoots: [PROJECT_DIR],
    }).split("\n"),
  );

  out.push("");
  out.push(`=== session pane (width ${width}) ===`);
  const parsed = parseSessionLines(
    readFileSync(path.join(FIXTURES, "pi-session.jsonl"), "utf8"),
  );
  out.push(...buildSessionLines(parsed.lines, { width, theme: PLAIN_THEME }));

  out.push("");
  out.push(`=== run output lines (width ${width}) ===`);
  const rec = RECORDS[`user:${USER_ROOT}:daily-briefing`]?.[0] as RunRecord;
  out.push(...outputLines(rec, width));
  out.push(`summary: ${summaryLine(rec, width)}`);

  out.push("");
  out.push(`=== worktree refusal (width ${width}) ===`);
  out.push(`record: ${REFUSAL.error?.message ?? ""}`);
  out.push(`summary: ${summaryLine(REFUSAL, width)}`);
  out.push(...renderListing([REFUSAL_STATUS], {
    home: HOME,
    projectRoots: [PROJECT_DIR],
    width,
    now: HOST_NOW,
    locale: "en",
  }));

  out.push("");
  out.push(`=== glyphs ===`);
  out.push(
    ["armed", "off", "disabled", "invalid"]
      .map((s) => `${s}=${GLYPH[s as Status["state"]]}`)
      .join(" "),
  );
  out.push(
    ["ok", "skipped", "missed", "aborted", "failed"]
      .map((o) => `${o}=${outcomeGlyph(o as RunRecord["outcome"])}`)
      .join(" "),
  );
  out.push(`running=${GLYPH.running} flow=${GLYPH.flow} late=${GLYPH.late} reason=${GLYPH.reason}`);

  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------- frozen output

// Regenerate both fixtures with: $env:FREEZE_COMPAT_OUTPUT='1'; node
// .\node_modules\vitest\vitest.mjs run test\compat-output.test.ts Deliberately opt-in and
// fail-closed.
const FREEZE = process.env.FREEZE_COMPAT_OUTPUT === "1";

describe("rendered output is frozen at 80 and 120 columns", () => {
  for (const width of WIDTHS) {
    it(`matches the recorded fixture at ${width}`, () => {
      const file = path.join(FIXTURES, `output-${width}.txt`);
      const actual = renderAll(width);
      if (FREEZE) writeFileSync(file, actual);
      expect(actual).toBe(readFileSync(file, "utf8"));
    });
  }

  it("differs between the two widths, so the fixtures are not measuring nothing", () => {
    expect(renderAll(80)).not.toBe(renderAll(120));
  });

  it("carries the worktree refusal at both widths, reason and remediation intact", () => {
    for (const width of WIDTHS) {
      const frozen = readFileSync(path.join(FIXTURES, `output-${width}.txt`), "utf8");
      expect(frozen).toContain(`=== worktree refusal (width ${width}) ===`);
      // The record's own message is width-independent and carries all four things: that it was
      // workspace preparation, the repository, the intended workspace, git's diagnosis, and the
      // remediation.
      expect(frozen).toContain("could not prepare the git worktree");
      expect(frozen).toContain("already exists");
      expect(frozen).toContain("config.worktree");
      // And the one-line surface still identifies it as a host workspace failure after clipping.
      expect(frozen).toContain("summary: host: workspace:");

      // What each width actually keeps. The paths above are long enough that this is a real
      // question: before the refusal was reordered, both widths clipped inside the repository path
      // and every workspace failure read identically.
      const summary = frozen
        .split("\n")
        .find((l) => l.trim().startsWith("summary: host: workspace:")) as string;
      expect(summary).toBeTypeOf("string");
      // The distinguishing cause survives at both widths.
      expect(summary).toContain("the worktree path already exists");
      // The actionable remediation survives at 120, where there is room for it.
      if (width >= 120) expect(summary).toContain("remove it from config.worktree");
    }
  });

  it("never draws a listing row wider than the terminal", () => {
    for (const width of WIDTHS) {
      const lines = renderListing(STATUSES, {
        home: HOME,
        projectRoots: [PROJECT_DIR],
        width,
        now: HOST_NOW,
        locale: "en",
      });
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("every surface renders without colour", () => {
  it("produces the same text with no theme as with the plain theme", () => {
    const parsed = parseSessionLines(
      readFileSync(path.join(FIXTURES, "pi-session.jsonl"), "utf8"),
    );
    for (const width of WIDTHS) {
      expect(buildSessionLines(parsed.lines, { width })).toEqual(
        buildSessionLines(parsed.lines, { width, theme: PLAIN_THEME }),
      );
    }
  });

  it("routes colour through the theme rather than emitting escapes itself", () => {
    const parsed = parseSessionLines(
      readFileSync(path.join(FIXTURES, "pi-session.jsonl"), "utf8"),
    );
    const marked = buildSessionLines(parsed.lines, {
      width: 80,
      theme: { fg: (c, t) => `<${c}>${t}</${c}>` },
    });
    expect(marked.every((l) => /^<[a-zA-Z]+>/.test(l))).toBe(true);
    // Nothing writes a raw ANSI escape: the theme is the only colour authority.
    expect(marked.some((l) => l.includes("\u001b["))).toBe(false);
  });
});

describe("the legacy Pi transcript decodes the same way it always has", () => {
  const parsed = parseSessionLines(
    readFileSync(path.join(FIXTURES, "pi-session.jsonl"), "utf8"),
  );

  it("reads the session id out of the header line", () => {
    expect(parsed.id).toBe("sess-compat-1");
  });

  it("keeps the order of thought, speech and tool use", () => {
    expect(parsed.lines.map((l) => l.kind)).toEqual([
      "note",
      "user",
      "thinking",
      "text",
      "tool",
      "result",
      "text",
      "tool",
      "result",
      "text",
    ]);
  });

  it("lets a settled line replace the partial draft it settles", () => {
    // The fixture has {"type":"partial","text":"12 new messages"} followed by the finished
    // assistant text that starts with it. One line survives, not two.
    const texts = parsed.lines.filter((l) => l.kind === "partial");
    expect(texts).toHaveLength(0);
    expect(parsed.lines.some((l) => l.text.startsWith("12 new messages overnight"))).toBe(true);
  });

  it("ignores an entry type it has never seen rather than failing", () => {
    // The fixture carries {"type":"custom",…}; nothing in the pane mentions it.
    expect(parsed.lines.some((l) => l.text.includes("telemetry"))).toBe(false);
  });

  it("does not throw on a torn final line", () => {
    const whole = readFileSync(path.join(FIXTURES, "pi-session.jsonl"), "utf8");
    const torn = whole.slice(0, whole.length - 40);
    expect(() => parseSessionLines(torn)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------- no subprocess

/** Nothing in this file may reach a child process. */
const CHILD_PROCESS = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("node:child_process", () => {
  const trap =
    (name: string) =>
    (...args: unknown[]) => {
      CHILD_PROCESS.calls.push(`${name}:${String(args[0])}`);
      throw new Error(`compat-output must not spawn a child process (${name})`);
    };
  const api = {
    spawn: trap("spawn"),
    spawnSync: trap("spawnSync"),
    exec: trap("exec"),
    execSync: trap("execSync"),
    execFile: trap("execFile"),
    execFileSync: trap("execFileSync"),
    fork: trap("fork"),
  };
  return { ...api, default: api };
});

describe("reading status never spawns a child process", () => {
  it("computes flow presence from files alone, whether the automation is tracked or not", async () => {
    const before = CHILD_PROCESS.calls.length;

    for (const tracked of [true, false]) {
      const a = isolatedAutomation({
        name: tracked ? "charted" : "plain",
        frontmatter: "on:\n  manual: true\n",
        ...(tracked ? { files: { "flow.mmd": "flowchart TD\n  body --> post0\n" } } : {}),
      });

      const statuses = await computeStatuses(discover({ roots: a.roots }), {
        trust: new Trust(a.stateDir),
        config: DEFAULTS,
        stateDir: a.stateDir,
        now: HOST_NOW,
      });

      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.flow).toBe(tracked ? true : undefined);
    }

    expect(CHILD_PROCESS.calls.slice(before)).toEqual([]);
  });

  it("proves the trap is live, so the assertion above is not vacuous", async () => {
    const cp = await import("node:child_process");
    expect(() => cp.execFileSync("fm", ["guide"])).toThrow(/must not spawn/);
    expect(CHILD_PROCESS.calls.at(-1)).toBe("execFileSync:fm");
    // Drop the deliberate call so a later assertion is not confused by it.
    CHILD_PROCESS.calls.pop();
  });
});
