/** A run's message for its reader: `pa message`, kept on the record, and shown first everywhere. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadPlugins } from "../src/plugins/loader.js";
import type { HostServices } from "../src/plugins/types.js";
import {
  closeProgress,
  notesGuide,
  openProgress,
  progressFile,
  progressGuide,
  progressMessage,
  progressNote,
  progressStatus,
  ProgressError,
  snapshotFromRecord,
  TEXT_MAX,
  withProgress,
} from "../src/progress.js";
import { progressCli, statusLines } from "../src/progress-cli.js";
import { readRecords } from "../src/records.js";
import { fire } from "../src/run.js";
import type { RunMessage, RunRecord } from "../src/types.js";
import { createListScreen, type ListData } from "../src/ui/list.js";
import { messageAreaLines, messageText, shownMessage } from "../src/ui/message.js";
import { runPageLines } from "../src/ui/running.js";
import { createRunsPage } from "../src/ui/runs.js";
import { stripAnsi, visibleWidth } from "../src/ui/width.js";
import { ALL, DIGEST_RUNS, inboxData, NIGHTLY, NOW, PR_DIGEST, record, teamRunView } from "./helpers/inbox-data.js";
import { isolatedAutomation, isolatedFireDeps, HOST_NOW } from "./helpers/isolated-host.js";
import { cleanupTempDirs, tempDir, trackTempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const REPO = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO, "bin", "pi-automations.js");
const DOWN = "\u001b[B";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function opened(chart = "", runId = "20261022-080000-m1m1"): { dir: string; run: string } {
  const dir = tempDir("pa-message-");
  openProgress(dir, { runId, key: "user:/r:digest", name: "digest", chart });
  return { dir, run: runId };
}

function refusal(fn: () => unknown): ProgressError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProgressError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("pa message, in the progress store", () => {
  it("keeps the text and its links, with or without a label, on a run with no chart", () => {
    const { dir, run } = opened();
    const r = progressMessage(dir, run, { text: "2 PRs wait on you", links: ["digest=https://x.test/d/1", "https://x.test/pr/7"] });
    expect(r.changed).toBe(true);
    expect(r.snapshot.message).toEqual({
      ts: expect.any(String),
      text: "2 PRs wait on you",
      links: [{ label: "digest", url: "https://x.test/d/1" }, { url: "https://x.test/pr/7" }],
    });
    expect(r.snapshot.notes).toEqual([]);
  });

  it("keeps one message: a later one replaces it, and notes stay as they were", () => {
    const { dir, run } = opened();
    progressNote(dir, run, { text: "Posted the digest", links: ["https://x.test/d/1"] });
    progressMessage(dir, run, { text: "first", links: ["https://x.test/a"] });
    const r = progressMessage(dir, run, { text: "second", links: ["b=https://x.test/b"] });
    expect(r.snapshot.message).toMatchObject({ text: "second", links: [{ label: "b", url: "https://x.test/b" }] });
    expect(progressStatus(dir, run).message?.text).toBe("second");
    expect(progressStatus(dir, run).notes.map((n) => n.text)).toEqual(["Posted the digest"]);
  });

  it("makes a retry with the same request id a no-op, apart from a note's", () => {
    const { dir, run } = opened();
    expect(progressMessage(dir, run, { text: "done", requestId: "m1" }).changed).toBe(true);
    const again = progressMessage(dir, run, { text: "done, said differently", requestId: "m1" });
    expect(again.changed).toBe(false);
    expect(again.snapshot.message?.text).toBe("done");
    // The same key on a note is a different write.
    expect(progressNote(dir, run, { text: "a note", requestId: "m1" }).changed).toBe(true);
  });

  it("refuses the whole call for one bad link, and writes nothing at all", () => {
    const { dir, run } = opened();
    const before = readFileSync(progressFile(dir, run), "utf8");
    for (const bad of ["ftp://x.test/a", "label=javascript:alert(1)", "not a url", "file:///etc/passwd"]) {
      expect(refusal(() => progressMessage(dir, run, { text: "t", links: ["https://ok.test", bad] })).code).toBe("BAD_LINK");
    }
    expect(refusal(() => progressMessage(dir, run, { text: "  " })).code).toBe("USAGE");
    expect(readFileSync(progressFile(dir, run), "utf8")).toBe(before);
  });

  it("cuts long text with a warning, and strips controls but keeps the lines", () => {
    const { dir, run } = opened();
    const long = progressMessage(dir, run, { text: "x".repeat(TEXT_MAX + 10) });
    expect(long.snapshot.message?.text).toHaveLength(TEXT_MAX);
    expect(long.warnings[0]).toMatch(/kept the first/);
    const odd = progressMessage(dir, run, { text: "one\u001b]8;;https://evil.test\u0007\ntwo\u009b" });
    expect(odd.snapshot.message?.text).toBe("one]8;;https://evil.test\ntwo");
  });

  it("is folded into the record at the end, comes back from it, and a straggler hears RUN_CLOSED", () => {
    const chart = 'flowchart TD\n  body["Do it"] --> post0["Save"]\n';
    const { dir, run } = opened(chart);
    progressMessage(dir, run, { text: "Saved", links: ["save=https://x.test/s"] });
    const folded = closeProgress(dir, run, "ok");
    expect(folded?.message).toMatchObject({ text: "Saved", links: [{ label: "save", url: "https://x.test/s" }] });
    const rec = withProgress({ id: run, key: "user:/r:digest", name: "digest", recordedAt: "2026-10-22T08:01:00.000Z" } as RunRecord, folded!);
    expect(rec.message?.text).toBe("Saved");
    expect(snapshotFromRecord(rec)?.message?.text).toBe("Saved");
    expect(refusal(() => progressMessage(dir, run, { text: "late" })).code).toBe("RUN_CLOSED");
  });

  it("asks the agent, in a line, for one message with links before it finishes", () => {
    for (const guide of [notesGuide(), progressGuide('flowchart TD\n  body["b"]\n')]) {
      expect(guide).toContain('pa message "what happened / what needs you" --link "label=https://…"');
      expect(guide).toMatch(/Links matter most/);
      // Bodies ask for receipts in plain words; the guide says which commands those words mean.
      expect(guide).toContain("When the instructions ask you to record what you published or to leave a message, use these commands.");
    }
  });
});

describe("pa message on the command line", () => {
  it("answers for a person and in --json, and pa status shows it under the notes", () => {
    const { dir, run } = opened();
    const env = { AUTOMATION_RUN: run, AUTOMATION_STATE_DIR: dir };
    const human = progressCli(["message", "Digest is up", "--link", "digest=https://x.test/d/1"], env);
    expect(human).toMatchObject({ code: 0, stdout: "message left with 1 link\n", stderr: "" });
    const json = JSON.parse(progressCli(["message", "Digest is up, 2 wait", "--json"], env).stdout);
    expect(json).toMatchObject({ ok: true, changed: true, data: { message: { text: "Digest is up, 2 wait", links: [] } } });
    expect(progressCli(["message", "--json"], env).code).toBe(1);
    expect(JSON.parse(progressCli(["message", "x", "--link", "file:///x", "--json"], env).stdout).error.code).toBe("BAD_LINK");

    const status = JSON.parse(progressCli(["status", "--json"], env).stdout);
    expect(status.data.message.text).toBe("Digest is up, 2 wait");
    progressMessage(dir, run, { text: "Final\u0007 word", links: ["pr=https://x.test/pr/7"] });
    const lines = statusLines(progressStatus(dir, run));
    expect(lines.slice(-2)).toEqual(["message Final word", "        pr: https://x.test/pr/7"]);
    expect(lines.join("\n")).not.toMatch(CONTROL);
  });
});

describe("a real run, and the real pa", () => {
  function pa(args: string[], env: Record<string, string>) {
    const base = { ...process.env };
    for (const k of ["AUTOMATION_RUN", "AUTOMATION_NODE", "AUTOMATION_STATE_DIR"]) delete base[k];
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", windowsHide: true, env: { ...base, ...env } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("lists pa message in its help", () => {
    expect(pa(["help"], {}).stdout).toContain("pa message <text>");
  });

  it("takes the message from inside the run, shows it in pa status, and writes it on the record", async () => {
    const a = isolatedAutomation({ name: "digest", frontmatter: "on:\n  manual: true\n" });
    const said: { status?: string; json?: string; code?: number | null } = {};
    const rec = await fire(
      a.located,
      { trigger: "manual", now: () => HOST_NOW },
      isolatedFireDeps(a.stateDir, {
        startTracking: (await import("../src/progress.js")).progressTracking,
        startSession: async (start: { env?: Record<string, string> }) => {
          const env = { ...(start.env ?? {}) } as Record<string, string>;
          return {
            file: "/sessions/fake.jsonl",
            id: "fake",
            prompt: async () => {
              said.code = pa(["message", "Draft is up, review the wording", "--link", "draft=https://x.test/d/9", "--link", "https://x.test/pr/9"], env).code;
              said.status = pa(["status"], env).stdout;
              said.json = pa(["status", "--json"], env).stdout;
              return "Published the draft.";
            },
            dispose: () => {},
          };
        },
      }),
    );

    expect(said.code).toBe(0);
    expect(said.status).toContain("message Draft is up, review the wording");
    expect(said.status).toContain("draft: https://x.test/d/9");
    expect(JSON.parse(said.json as string).data.message.links).toEqual([{ label: "draft", url: "https://x.test/d/9" }, { url: "https://x.test/pr/9" }]);
    expect(rec.outcome).toBe("ok");
    expect(rec.message).toMatchObject({ text: "Draft is up, review the wording", links: [{ label: "draft", url: "https://x.test/d/9" }, { url: "https://x.test/pr/9" }] });
    expect(readRecords(a.stateDir, a.located.key, 1)[0]?.message).toEqual(rec.message);
  }, 60_000);
});

describe("plugins hear the message", () => {
  function pluginFile(body: string): string {
    const base = path.join(REPO, "test", "fixtures");
    mkdirSync(base, { recursive: true });
    const dir = trackTempDir(mkdtempSync(path.join(base, "plugins-")));
    const file = path.join(dir, "plugin.mjs");
    writeFileSync(file, `export default { name: "probe", async setup(api) {\n${body}\n} };\n`);
    return file;
  }

  it("fires a message event, observe only, with the message as it is now", async () => {
    const out = path.join(tempDir("plugin-message-"), "events.jsonl");
    const observers = await loadPlugins({
      entries: [pluginFile(`const fs = await import("node:fs"); api.on("message", (e) => fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify(e) + "\\n"));`)],
      where: "host",
      host: (): HostServices => {
        throw new Error("not needed");
      },
      timeoutMs: 300,
    });
    const a = isolatedAutomation({ name: "observed", frontmatter: "on:\n  manual: true\n" });
    const rec = await fire(
      a.located,
      { trigger: "manual" },
      isolatedFireDeps(a.stateDir, {
        startTracking: (await import("../src/progress.js")).progressTracking,
        observe: observers,
        startSession: async (start: { env?: Record<string, string> }) => ({
          file: "",
          id: "",
          prompt: async () => {
            const run = start.env?.AUTOMATION_RUN;
            progressMessage(a.stateDir, run, { text: "first try", links: ["https://x.test/1"] });
            await new Promise((r) => setTimeout(r, 700));
            progressMessage(a.stateDir, run, { text: "Published", links: ["digest=https://x.test/d"] });
            return "done";
          },
          dispose: () => {},
        }),
      }),
    );
    const events = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { run: { runId: string }; message: RunMessage });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.run.runId === rec.id)).toBe(true);
    expect(events.at(-1)?.message).toMatchObject({ text: "Published", links: [{ label: "digest", url: "https://x.test/d" }] });
    expect(new Set(events.map((e) => e.message.text)).size).toBe(events.length);
    expect(rec.message?.text).toBe("Published");
  }, 30_000);
});

// ------------------------------------------------------------------------------------ the TUI

const MESSAGE: RunMessage = {
  ts: "2026-10-22T15:01:00.000Z",
  text: "Digest is up: 2 PRs wait on you (#11911 needs a re-review, #11920 has a failing check). Nothing else moved overnight.",
  links: [
    { label: "Canvas digest", url: "https://canvas.example/d/2026-10-22" },
    { label: "PR #11911", url: "https://github.com/example/repo/pull/11911" },
    { url: "https://github.com/example/repo/pull/11920" },
  ],
};

/** The /automations page with my-pr-digest's last run leaving `message`. */
function withMessage(message: RunMessage = MESSAGE): ListData {
  const runs = DIGEST_RUNS.slice();
  runs[6] = { ...(runs[6] as RunRecord), message };
  const d = inboxData(ALL);
  (d.details as NonNullable<ListData["details"]>)[PR_DIGEST.key] = { records: runs, lastRecord: runs[6] as RunRecord };
  return d;
}

function page(d: ListData, rows: number, width: number, keys: string[] = []): string[] {
  const s = createListScreen({ tui: { requestRender() {}, terminal: { rows } }, close() {}, reload: async () => d, act() {}, actGlobal() {} }, d);
  for (const k of keys) s.handleInput(k);
  const out = s.render(width);
  s.dispose();
  return out;
}

describe("what a run left for its reader: its message, else its notes, else its reply", () => {
  it("falls back in that order, and keeps every link", () => {
    const base = record("x", "r1", NOW, 1000, "ok", { output: { text: "All done." } });
    expect(shownMessage({ ...base, message: MESSAGE, notes: [{ ts: "t", text: "n", links: [] }] })).toMatchObject({ from: "message", text: MESSAGE.text, links: MESSAGE.links });
    const notes = [
      { ts: "t", text: "Digest published", links: [{ url: "https://x.test/d" }] },
      { ts: "t", text: "Posted to chat", links: [{ url: "https://x.test/m" }, { url: "https://x.test/d" }] },
    ];
    expect(shownMessage({ ...base, notes })).toEqual({ from: "notes", text: "Digest published · Posted to chat", links: [{ url: "https://x.test/d" }, { url: "https://x.test/m" }] });
    expect(shownMessage(base)).toEqual({ from: "reply", text: "All done.", links: [] });
    expect(shownMessage({ ...base, output: { text: "\n# Digest\n\nmore below" } })).toEqual({ from: "reply", text: "# Digest", links: [] });
    expect(shownMessage(record("x", "r2", NOW, 1000, "failed", { error: { kind: "agent", message: "gh: 502" } }))).toEqual({ from: "reply", text: "gh: 502", links: [] });
    expect(shownMessage(undefined)).toBeUndefined();
  });

  it("makes nothing up for a run that said nothing: ok without output, skipped, missed", () => {
    expect(shownMessage(record("x", "r1", NOW, 1000, "ok"))).toBeUndefined();
    expect(shownMessage(record("x", "r1", NOW, 1000, "ok", { output: { text: "  \n " } }))).toBeUndefined();
    expect(shownMessage(record("x", "r2", NOW, 0, "skipped", { reason: "weekend" }))).toBeUndefined();
    expect(shownMessage(record("x", "r3", NOW, 0, "missed", { reason: "the host was asleep" }))).toBeUndefined();
    expect(shownMessage(record("x", "r4", NOW, 1000, "failed"))).toBeUndefined();
  });

  it("reads Markdown as a reader would: emphasis and ticks dropped, inline links become link rows", () => {
    const rec = record("x", "r1", NOW, 1000, "ok", {
      output: { text: "**org/repo#12 fix: keep `focus`** by *Ann*: see [the PR](https://x.test/pr/12), file_name_here untouched" },
    });
    const shown = shownMessage(rec)!;
    expect(shown.links).toEqual([{ label: "the PR", url: "https://x.test/pr/12" }]);
    expect(messageText(shown.text)).toBe("org/repo#12 fix: keep focus by Ann: see the PR, file_name_here untouched");
    expect(shownMessage({ ...rec, output: { text: "[bad](javascript:alert(1)) and [ok](https://x.test/a)" } })!.links).toEqual([{ label: "ok", url: "https://x.test/a" }]);
    expect(shownMessage({ ...rec, message: { ts: "t", text: "see [d](https://x.test/d)", links: [{ url: "https://x.test/d" }] } })!.links).toEqual([{ url: "https://x.test/d" }]);
  });
});

describe("the list page shows the selected automation's last message under the list", () => {
  it("as a rule with its name and when, the text, then each link as a hyperlink", () => {
    const lines = page(withMessage(), 40, 100, [DOWN, DOWN]);
    const at = lines.findIndex((l) => l.includes("Last message"));
    expect(lines[at - 1]).toBe("");
    expect(stripAnsi(lines[at] as string)).toMatch(/^ {2}── Last message · my-pr-digest · today 08:01 ─+$/);
    expect(lines.slice(at + 1, at + 6).map(stripAnsi)).toEqual([
      "    Digest is up: 2 PRs wait on you (#11911 needs a re-review, #11920 has a failing check). Nothing",
      "    else moved overnight.",
      "    ↗ Canvas digest https://canvas.example/d/2026-10-22",
      "    ↗ PR #11911 https://github.com/example/repo/pull/11911",
      "    ↗ https://github.com/example/repo/pull/11920",
    ]);
    expect(lines[at + 3]).toContain("\u001B]8;;https://canvas.example/d/2026-10-22\u001B\\Canvas digest\u001B]8;;\u001B\\");
  });

  it("follows the selection, falls back to a run's notes, and says nothing twice for a failure's card", () => {
    // nightly-report's card already says why it failed.
    expect(page(withMessage(), 40, 100).join("\n")).not.toContain("Last message");
    // my-pr-review answered, and left no message or notes: its reply is its message.
    const review = page(withMessage(), 40, 100, [DOWN, DOWN, DOWN, DOWN]).map(stripAnsi);
    expect(review.find((l) => l.includes("Last message"))).toContain("my-pr-review");
    expect(review).toContain("    acme/tools#9850 fix: restore plugin detail focus: 1 fixed, 0 nits declined");
    const notes = page(inboxData(ALL), 40, 100, [DOWN, DOWN]).map(stripAnsi);
    expect(notes).toContain("    Digest published · Posted to the team chat");
    expect(notes).toContain("    ↗ Canvas digest https://canvas.example/d/2026-10-22");
  });

  it("keeps links and trims text when the terminal is short, and lets the list keep its rows", () => {
    for (const [width, rows] of [[80, 24], [80, 16], [60, 14]] as const) {
      const lines = page(withMessage(), rows, width, [DOWN, DOWN]);
      expect(lines, `${width}×${rows}`).toHaveLength(rows);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
      const text = lines.map(stripAnsi);
      expect(text.some((l) => l.startsWith("  ❯") && l.includes("my-pr-digest")), `${width}×${rows}`).toBe(true);
      const at = text.findIndex((l) => l.includes("Last message"));
      expect(at, `${width}×${rows}`).toBeGreaterThan(0);
      const area = text.slice(at + 1, -2);
      const links = area.filter((l) => l.trimStart().startsWith("↗"));
      expect(links.length, `${width}×${rows}`).toBeGreaterThanOrEqual(Math.min(3, area.length));
      // A link is never cut for the sake of text.
      if (area.some((l) => l.includes("Digest is up"))) expect(links).toHaveLength(3);
    }
    const tight = page(withMessage(), 16, 80, [DOWN, DOWN]).map(stripAnsi);
    expect(tight.join("\n")).not.toContain("Digest is up");
    expect(tight.filter((l) => l.trimStart().startsWith("↗"))).toHaveLength(3);
  });

  it("draws no area for a last run that said nothing", () => {
    // my-issue-verify's last run was skipped.
    const skipped = page(inboxData(ALL), 40, 100, [DOWN, DOWN, DOWN]).map(stripAnsi);
    expect(skipped.find((l) => l.startsWith("  ❯"))).toContain("my-issue-verify");
    expect(skipped.join("\n")).not.toContain("Last message");
    for (const over of [{ outcome: "ok" as const }, { outcome: "missed" as const, reason: "the host was asleep" }]) {
      const d = inboxData(ALL);
      const runs = DIGEST_RUNS.slice(0, 6);
      runs.push(record("my-pr-digest", "d22", NOW, 60_000, over.outcome, "reason" in over ? { reason: over.reason } : {}));
      (d.details as NonNullable<ListData["details"]>)[PR_DIGEST.key] = { records: runs, lastRecord: runs.at(-1) as RunRecord };
      const lines = page(d, 40, 100, [DOWN, DOWN]).map(stripAnsi);
      expect(lines.find((l) => l.startsWith("  ❯")), over.outcome).toContain("my-pr-digest");
      expect(lines.join("\n"), over.outcome).not.toContain("Last message");
    }
  });

  it("hides when there is no room for it beside the list", () => {
    const lines = page(withMessage(), 10, 80, [DOWN, DOWN]);
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).not.toContain("Last message");
    expect(lines.map(stripAnsi).some((l) => l.startsWith("  ❯"))).toBe(true);
  });

  it("never lets the message's text start a control sequence", () => {
    const evil: RunMessage = {
      ts: MESSAGE.ts,
      text: "ok\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007 \u001b[2J done",
      links: [{ label: "x\u001b[31m", url: "https://x.test/a" }],
    };
    const out = page(withMessage(evil), 40, 100, [DOWN, DOWN]).join("\n");
    expect(out).not.toContain("evil.test\u0007");
    expect(out).not.toContain("\u001b[2J");
    expect(out).not.toContain("\u001b[31m");
    const hyperlinks = [...out.matchAll(/\u001b\]8;;([^\u001b]*)\u001b\\/g)].map((m) => m[1]).filter(Boolean);
    expect(hyperlinks.every((u) => /^https:\/\/(canvas|group|x)\./.test(u as string))).toBe(true);
  });

  it("draws nothing for fewer than three rows, and links before text", () => {
    const shown = { from: "message" as const, text: "a b c d e f", links: MESSAGE.links };
    expect(messageAreaLines({ name: "n", when: "now", shown, width: 60, room: 2 })).toEqual([]);
    expect(messageAreaLines({ name: "n", when: "now", shown, width: 60, room: 3 }).map(stripAnsi).slice(2)).toEqual(["    ↗ Canvas digest https://canvas.example/d/2026-10-22"]);
    const roomy = messageAreaLines({ name: "n", when: "now", shown, width: 60, room: 6 }).map(stripAnsi);
    expect(roomy.slice(2)).toEqual(["    a b c d e f", "    ↗ Canvas digest https://canvas.example/d/2026-10-22", "    ↗ PR #11911 https://github.com/example/repo/pull/11911", "    ↗ https://github.com/example/repo/pull/11920"]);
    const many = { ...shown, links: Array.from({ length: 8 }, (_, i) => ({ url: `https://x.test/${i}` })) };
    const capped = messageAreaLines({ name: "n", when: "now", shown: many, width: 60 }).map(stripAnsi);
    expect(capped.at(-1)).toBe("    and 4 more links · l shows them");
  });
});

describe("the message on an automation's page, its runs and its run", () => {
  it("replaces Notes with Message, leads with it, and points at the notes it does not repeat", () => {
    const d = withMessage();
    const lines = page(d, 30, 100, [DOWN, DOWN, "\r"]).map(stripAnsi);
    const at = lines.findIndex((l) => l.startsWith("  Last run"));
    expect(lines.slice(at, at + 7)).toEqual([
      "  Last run   ✓ today 08:01 · took 1m",
      "  Message    Digest is up: 2 PRs wait on you (#11911 needs a re-review, #11920 has a failing check).",
      "             Nothing else moved overnight.",
      "             ↗ Canvas digest https://canvas.example/d/2026-10-22",
      "             ↗ PR #11911 https://github.com/example/repo/pull/11911",
      "             ↗ https://github.com/example/repo/pull/11920",
      "             and 2 notes · l shows them",
    ]);
    expect(lines.join("\n")).not.toContain("Notes");
  });

  it("keeps a failure's reason when the failed run left a message too", () => {
    const d = inboxData(ALL);
    const details = d.details as NonNullable<ListData["details"]>;
    const runs = (details[NIGHTLY.key]?.records ?? []).slice();
    runs[runs.length - 1] = { ...(runs.at(-1) as RunRecord), message: { ts: "t", text: "Could not post; retry after the outage", links: [{ label: "status", url: "https://status.test" }] } };
    details[NIGHTLY.key] = { records: runs, lastRecord: runs.at(-1) as RunRecord };
    const text = page(d, 30, 100, ["\r"]).map(stripAnsi).join("\n");
    expect(text).toContain("gh: HTTP 502 while posting the report to #builds");
    expect(text).toContain("  Message    Could not post; retry after the outage\n             ↗ status https://status.test");
  });

  it("puts the message first in the runs list, its links when opened, then the reply and notes", () => {
    const runs = DIGEST_RUNS.slice();
    runs[6] = { ...(runs[6] as RunRecord), message: MESSAGE };
    const log = createRunsPage({ tui: { requestRender() {} }, name: "my-pr-digest", runs: runs.map((r) => ({ record: r })), now: () => NOW, close() {} }).render(120).map(stripAnsi);
    expect(log[2]).toMatch(/^ {2}❯ ✓ today 08:00 {6}1m {3}Digest is up: 2 PRs wait on you/);
    const links = log.findIndex((l) => l.includes("↗ Canvas digest https://canvas.example"));
    const reply = log.findIndex((l) => l.includes("PR digest 2026-10-22: nothing needs you"));
    const notes = log.findIndex((l) => l.includes("Digest published"));
    expect(links).toBeGreaterThan(2);
    expect(reply).toBeGreaterThan(links);
    expect(notes).toBeGreaterThan(reply);
  });

  it("shows the message above the notes on a run's page", () => {
    const view = { ...teamRunView(), message: { ts: "t", text: "Review posted, one blocker", links: [{ label: "review", url: "https://x.test/r/1" }] } };
    const lines = runPageLines(view, 100, NOW).map(stripAnsi);
    const msg = lines.indexOf("  Message so far");
    expect(lines.slice(msg, msg + 3)).toEqual(["  Message so far", "    Review posted, one blocker", "    ↗ review https://x.test/r/1"]);
    expect(lines.indexOf("  Notes so far")).toBeGreaterThan(msg);
  });
});
