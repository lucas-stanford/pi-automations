/** `pa` — the one command line, and the in-run verbs a tracked run reports with. */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { key } from "../src/paths.js";
import { openProgress } from "../src/progress.js";
import { appendRecord } from "../src/records.js";
import type { RunRecord } from "../src/types.js";
import { automationIn, isolatedHome, proveIsolated } from "./helpers/isolated-env.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const REPO = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO, "bin", "pi-automations.js");

const CHART = 'flowchart TD\n  pre0["Pick"] --> body["Do it"]\n  body --> grade["Grade each comment"]\n  grade --> report\n';

function run(args: string[], env: Record<string, string>) {
  // Only what the test gives it: an inherited AUTOMATION_RUN would point it at someone else's run.
  const base = { ...process.env };
  for (const k of ["AUTOMATION_RUN", "AUTOMATION_NODE", "AUTOMATION_STATE_DIR"]) delete base[k];
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...base, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tracked() {
  const dir = tempDir("pa-cli-");
  const runId = "20260917-140000-c1c1";
  openProgress(dir, { runId, key: "user:/r:review", name: "review", chart: CHART });
  return { AUTOMATION_RUN: runId, AUTOMATION_STATE_DIR: dir };
}

describe("one command, two names", () => {
  it("installs `pa` and `pi-automations` as the same entry", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin.pa).toBe("./bin/pi-automations.js");
    expect(pkg.bin["pi-automations"]).toBe("./bin/pi-automations.js");
  });

  it("lists the in-run verbs in its help", () => {
    const r = run(["help"], {});
    expect(r.code).toBe(0);
    for (const verb of ["pa step <node>", "pa next <to>", "pa say <text>", "pa note <text>", "pa status", "pa runs <name>"]) {
      expect(r.stdout).toContain(verb);
    }
  });
});

describe("in a run, with --json", () => {
  it("answers success with one object on stdout", () => {
    const env = tracked();
    const r = run(["step", "grade", "-m", "Grading 4 threads", "--json"], env);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const body = JSON.parse(r.stdout) as { ok: boolean; changed: boolean; data: { node: { id: string; status: string; text: string } } };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.data.node).toMatchObject({ id: "grade", status: "active", text: "Grading 4 threads" });

    // The same move again: still ok, and says nothing changed.
    expect(JSON.parse(run(["step", "grade", "-m", "Grading 4 threads", "--json"], env).stdout).changed).toBe(false);
  });

  it("answers failure with one object too: the code, the message and the suggestions", () => {
    const env = tracked();
    const r = run(["next", "repotr", "--from", "grade", "--json"], env);
    expect(r.code).toBe(2);
    const body = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; message: string; suggestions: string[] } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNKNOWN_NODE");
    expect(body.error.suggestions).toContain("report");
  });

  it("is a usage error, exit 1, for a missing argument or a link that is not http(s)", () => {
    const env = tracked();
    expect(run(["step", "--json"], env).code).toBe(1);
    const bad = run(["note", "posted", "--link", "file:///c:/x", "--json"], env);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout).error.code).toBe("BAD_LINK");
  });

  it("says plainly when it is not inside a run", () => {
    const r = run(["status", "--json"], { AUTOMATION_STATE_DIR: tempDir("pa-cli-none-") });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe("NO_RUN");
  });

  it("reports the whole run with status", () => {
    const env = tracked();
    run(["next", "body", "--from", "pre0"], env);
    run(["note", "Replied", "--link", "thread=https://x.test/pr/7#discussion_r1"], env);
    const s = JSON.parse(run(["status", "--json"], env).stdout) as {
      data: { nodes: { id: string; status: string }[]; taken: string[][]; notes: { links: unknown[] }[] };
    };
    expect(s.data.nodes.map((n) => `${n.id}:${n.status}`)).toEqual(["pre0:done", "body:active", "grade:pending", "report:pending"]);
    expect(s.data.taken).toEqual([["pre0", "body"]]);
    expect(s.data.notes[0]?.links).toEqual([{ label: "thread", url: "https://x.test/pr/7#discussion_r1" }]);
  });
});

describe("in a run, for a person", () => {
  it("prints a line on stdout and nothing on stderr", () => {
    const env = tracked();
    const r = run(["step", "Grade each comment", "-m", "grading"], env);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("grade active");
    expect(r.stderr).toBe("");
  });

  it("puts an error on stderr, with what it probably meant, and nothing on stdout", () => {
    const env = tracked();
    const r = run(["say", "hi", "--node", "grde"], env);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('no node "grde"');
    expect(r.stderr).toContain("did you mean: grade");
  });

  it("finds a node from AUTOMATION_NODE, the way a subagent is told its node", () => {
    const env = { ...tracked(), AUTOMATION_NODE: "grade" };
    run(["step", "grade"], env);
    expect(run(["next", "report"], env).stdout.trim()).toBe("report active, grade done");
  });

  it("shows status as one line per node, then the notes with their links", () => {
    const env = tracked();
    run(["step", "pre0", "--status", "done", "-m", "picked #7"], env);
    run(["note", "Posted the review", "--link", "review=https://x.test/pr/7"], env);
    const out = run(["status"], env).stdout;
    expect(out).toContain("✓ pre0");
    expect(out).toContain("picked #7");
    expect(out).toContain("note   Posted the review");
    expect(out).toContain("review: https://x.test/pr/7");
  });
});

describe("pa runs <name>", () => {
  it("shows recent runs with what each one published, and keeps it all in --json", () => {
    const iso = isolatedHome("pa-runs-");
    automationIn(iso, "digest", "on:\n  manual: true\n");
    const resolved = proveIsolated(iso);
    const rec: RunRecord = {
      id: "20260917-080000-d1d1",
      key: key("user", iso.roots, "digest"),
      name: "digest",
      scope: "user",
      root: path.resolve(iso.roots),
      trigger: "schedule",
      late: false,
      recordedAt: "2026-09-17T08:03:00.000Z",
      startedAt: "2026-09-17T08:00:00.000Z",
      endedAt: "2026-09-17T08:03:00.000Z",
      outcome: "ok",
      output: { text: "Published the digest." },
      notes: [
        {
          ts: "2026-09-17T08:02:00.000Z",
          text: "Published the morning digest",
          links: [{ label: "digest", url: "https://canvas.test/d/42" }, { url: "https://group.test/m/9" }],
        },
      ],
    };
    appendRecord(resolved.stateDir, rec);

    const human = execFileSync(process.execPath, [BIN, "runs", "digest"], { encoding: "utf8", env: iso.env, cwd: iso.cwd, windowsHide: true });
    expect(human).toContain("Published the digest.");
    expect(human).toContain("note: Published the morning digest");
    expect(human).toContain("digest: https://canvas.test/d/42");
    expect(human).toContain("https://group.test/m/9");

    const json = execFileSync(process.execPath, [BIN, "runs", "digest", "--json"], { encoding: "utf8", env: iso.env, cwd: iso.cwd, windowsHide: true });
    expect((JSON.parse(json.trim()) as RunRecord).notes).toEqual(rec.notes);
  }, 90_000);
});

describe("pa watcher", () => {
  const cli = (iso: ReturnType<typeof isolatedHome>, args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: iso.env, cwd: iso.cwd, windowsHide: true });
    return { code: r.status, stdout: r.stdout };
  };

  it("reports the watcher off, under its own name and under the old name detached", () => {
    const iso = isolatedHome("pa-watcher-");
    proveIsolated(iso);
    const now = cli(iso, ["watcher", "status"]);
    expect(now.code).toBe(0);
    expect(now.stdout).toContain("watcher: off");
    expect(now.stdout).toContain("start it with: pa watcher start");
    expect(cli(iso, ["detached", "status"])).toEqual(now);
  }, 90_000);

  it("names start, stop and status for a verb it does not know", () => {
    const iso = isolatedHome("pa-watcher-verb-");
    proveIsolated(iso);
    const r = cli(iso, ["watcher", "bogus"]);
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe('unknown verb "bogus" — start, stop [--purge], status');
  }, 90_000);

  it("is in the help as watcher, and detached is not", () => {
    const iso = isolatedHome("pa-watcher-help-");
    const help = cli(iso, ["help"]).stdout;
    expect(help).toContain("pa watcher <verb>");
    expect(help).not.toContain("detached");
  }, 90_000);
});
