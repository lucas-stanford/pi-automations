/** The progress store: where a tracked run has got to, recorded by the run and by `pa`. */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseChart } from "../src/chart.js";
import { readRecords } from "../src/records.js";
import { fire } from "../src/run.js";
import {
  closeProgress,
  foldAbandoned,
  notesGuide,
  openProgress,
  parseLink,
  progressFile,
  progressGuide,
  progressNext,
  progressNote,
  progressSay,
  progressStatus,
  progressStep,
  progressTracking,
  ProgressError,
  readProgress,
  TEXT_MAX,
} from "../src/progress.js";
import { progressCli, statusLines } from "../src/progress-cli.js";
import type { RunRecord } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";
import { HOST_NOW, isolatedAutomation, isolatedFireDeps } from "./helpers/isolated-host.js";

afterAll(cleanupTempDirs);

const CHART = `flowchart TD
  %% pi moves pre0 and body.
  pre0["Pick the next issue"] --> body["Verify the issue"]
  body --> read["Read the issue"]
  read --> reproduce["Try it on production"]
  read -->|no browser needed| draft["Draft the verdict"]
  reproduce --> draft
  draft --> post0["Record the run"]
`;

const FAN = `flowchart TD
  split --> a & b & c
  a --> gather
  b --> gather
  c --> gather
`;

function opened(chart = CHART, runId = "20260917-140000-a1b2"): { dir: string; run: string } {
  const dir = tempDir("pa-progress-");
  openProgress(dir, { runId, key: "user:/r:demo", name: "demo", chart });
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

describe("the chart", () => {
  it("reads ids, quoted labels, edge labels, chains and & groups, and skips comments", () => {
    const c = parseChart(CHART);
    expect(c.nodes.map((n) => n.id)).toEqual(["pre0", "body", "read", "reproduce", "draft", "post0"]);
    expect(c.nodes.find((n) => n.id === "draft")?.label).toBe("Draft the verdict");
    expect(c.edges).toContainEqual({ from: "read", to: "draft", label: "no browser needed" });

    const fan = parseChart(FAN);
    expect(fan.edges.filter((e) => e.from === "split").map((e) => e.to)).toEqual(["a", "b", "c"]);
    expect(parseChart("graph LR\n  x(Round) -.-> y{Diamond}; y ==> z((Circle))\n").nodes).toEqual([
      { id: "x", label: "Round" },
      { id: "y", label: "Diamond" },
      { id: "z", label: "Circle" },
    ]);
  });

  it("ignores subgraphs, styles and classes rather than mistaking them for nodes", () => {
    const c = parseChart("flowchart TD\n  subgraph s [Group]\n    a --> b\n  end\n  classDef hot fill:#f00\n  class a hot\n  style b fill:#0f0\n");
    expect(c.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("step: one node, converging", () => {
  it("activates by default, and a repeat changes nothing and appends nothing", () => {
    const { dir, run } = opened();
    const first = progressStep(dir, run, { node: "read", text: "Reading #12" });
    expect(first.changed).toBe(true);
    expect(first.node).toMatchObject({ id: "read", status: "active", text: "Reading #12" });
    const size = readFileSync(progressFile(dir, run), "utf8").length;

    const again = progressStep(dir, run, { node: "read", text: "Reading #12" });
    expect(again.changed).toBe(false);
    expect(readFileSync(progressFile(dir, run), "utf8").length).toBe(size);
    // No text says nothing new either.
    expect(progressStep(dir, run, { node: "read" }).changed).toBe(false);
  });

  it("addresses a node by its exact label as well as its id", () => {
    const { dir, run } = opened();
    expect(progressStep(dir, run, { node: "Draft the verdict", status: "done" }).node?.id).toBe("draft");
  });

  it("refuses an unknown node, with the nodes it probably meant", () => {
    const { dir, run } = opened();
    const e = refusal(() => progressStep(dir, run, { node: "raed" }));
    expect(e.code).toBe("UNKNOWN_NODE");
    expect(e.suggestions[0]).toContain("read");
  });

  it("refuses a status it may not set", () => {
    const { dir, run } = opened();
    expect(refusal(() => progressStep(dir, run, { node: "read", status: "interrupted" })).code).toBe("USAGE");
  });

  it("keeps the first TEXT_MAX characters, and says so", () => {
    const { dir, run } = opened();
    const r = progressStep(dir, run, { node: "read", text: "x".repeat(TEXT_MAX + 10) });
    expect(r.node?.text).toHaveLength(TEXT_MAX);
    expect(r.warnings[0]).toContain(`kept the first ${TEXT_MAX}`);
  });
});

describe("next: settle one, start the next, record the arrow", () => {
  it("marks from done and to active, and records the arrow taken", () => {
    const { dir, run } = opened();
    progressStep(dir, run, { node: "read" });
    const r = progressNext(dir, run, { to: "draft", from: "read", text: "no browser needed" });
    expect(r.changed).toBe(true);
    expect(r.from?.status).toBe("done");
    expect(r.node).toMatchObject({ id: "draft", status: "active", text: "no browser needed" });
    expect(r.snapshot.taken).toEqual([["read", "draft"]]);
    expect(progressNext(dir, run, { to: "draft", from: "read", text: "no browser needed" }).changed).toBe(false);
  });

  it("comes from AUTOMATION_NODE, else the one running node", () => {
    const { dir, run } = opened();
    progressStep(dir, run, { node: "read" });
    expect(progressNext(dir, run, { to: "reproduce" }).from?.id).toBe("read");
    expect(progressNext(dir, run, { to: "draft", envNode: "reproduce" }).from?.id).toBe("reproduce");
  });

  it("refuses to guess when several nodes are running, or none is", () => {
    const { dir, run } = opened();
    expect(refusal(() => progressNext(dir, run, { to: "draft" })).code).toBe("NO_ACTIVE");
    progressStep(dir, run, { node: "body" });
    progressStep(dir, run, { node: "read" });
    const e = refusal(() => progressNext(dir, run, { to: "draft" }));
    expect(e.code).toBe("AMBIGUOUS_ACTIVE");
    expect(e.suggestions.join()).toContain("body");
  });

  it("converges several branches on one node — fan-in", () => {
    const { dir, run } = opened(FAN);
    for (const b of ["a", "b", "c"]) progressStep(dir, run, { node: b });
    for (const b of ["a", "b", "c"]) progressNext(dir, run, { to: "gather", from: b });
    const s = progressStatus(dir, run);
    expect(s.taken).toEqual([["a", "gather"], ["b", "gather"], ["c", "gather"]]);
    expect(s.nodes.filter((n) => ["a", "b", "c"].includes(n.id)).every((n) => n.status === "done")).toBe(true);
    expect(s.nodes.find((n) => n.id === "gather")?.status).toBe("active");
  });

  it("never marks a failed branch done", () => {
    const { dir, run } = opened(FAN);
    progressStep(dir, run, { node: "a", status: "failed" });
    progressNext(dir, run, { to: "gather", from: "a" });
    expect(progressStatus(dir, run).nodes.find((n) => n.id === "a")?.status).toBe("failed");
  });
});

describe("say and note", () => {
  it("say lands on a node, and a request id makes a retry a no-op", () => {
    const { dir, run } = opened();
    progressStep(dir, run, { node: "read" });
    expect(progressSay(dir, run, { text: "found 3 comments" }).node?.text).toBe("found 3 comments");
    expect(progressSay(dir, run, { text: "one", node: "draft", requestId: "k1" }).changed).toBe(true);
    expect(progressSay(dir, run, { text: "one", node: "draft", requestId: "k1" }).changed).toBe(false);
  });

  it("a note keeps its text and its links, with or without a label", () => {
    const { dir, run } = opened();
    const r = progressNote(dir, run, {
      text: "**Posted** the review",
      links: ["review=https://x.test/pr/1?tab=files&x=1", "https://x.test/digest"],
    });
    expect(r.snapshot.notes).toEqual([
      {
        ts: expect.any(String),
        text: "**Posted** the review",
        links: [{ label: "review", url: "https://x.test/pr/1?tab=files&x=1" }, { url: "https://x.test/digest" }],
      },
    ]);
    expect(progressNote(dir, run, { text: "again", requestId: "n1" }).changed).toBe(true);
    expect(progressNote(dir, run, { text: "again", requestId: "n1" }).changed).toBe(false);
  });

  it("refuses a link that is not http or https, and writes nothing at all", () => {
    const { dir, run } = opened();
    const before = readFileSync(progressFile(dir, run), "utf8");
    for (const bad of ["ftp://x.test/a", "label=javascript:alert(1)", "not a url", "file:///etc/passwd"]) {
      expect(refusal(() => progressNote(dir, run, { text: "t", links: ["https://ok.test", bad] })).code).toBe("BAD_LINK");
    }
    expect(readFileSync(progressFile(dir, run), "utf8")).toBe(before);
  });

  it("splits label=URL on the first = only when what follows is a URL", () => {
    expect(parseLink("PR=https://x.test/a?b=c")).toEqual({ label: "PR", url: "https://x.test/a?b=c" });
    expect(parseLink("https://x.test/a?b=c")).toEqual({ url: "https://x.test/a?b=c" });
    // Not split, and then not a URL either: refused rather than guessed at.
    expect(refusal(() => parseLink("a=b=https://x.test")).code).toBe("BAD_LINK");
    expect(parseLink("Group message = HTTPS://group.test/m/1")).toEqual({ label: "Group message", url: "https://group.test/m/1" });
  });
});

describe("nothing a writer sends reaches a terminal as a control", () => {
  // Ends the OSC 8 hyperlink early, opens another to somewhere else, and rings the bell.
  const PAYLOAD = "https://example.com/a\u001b]8;;https://evil.example\u001b\\b\u0007";
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

  it("keeps a link as the URL parsed it, with every control percent-encoded", () => {
    const link = parseLink(`re\u001b[31mview=${PAYLOAD}`);
    expect(link.url.startsWith("https://example.com/a")).toBe(true);
    expect(link.url).not.toMatch(CONTROL);
    expect(link.url).toContain("%1B");
    expect(link.label).toBe("re[31mview");
    expect(parseLink(PAYLOAD).url).not.toMatch(CONTROL);
  });

  it("strips them from note, step and say text, keeping the lines of the Markdown", () => {
    const { dir, run } = opened();
    const note = progressNote(dir, run, { text: "line one\u001b]8;;x\u0007\nline two\u009b", links: [PAYLOAD] });
    expect(note.snapshot.notes[0]?.text).toBe("line one]8;;x\nline two");
    expect(note.snapshot.notes[0]?.links[0]?.url).not.toMatch(CONTROL);
    expect(progressStep(dir, run, { node: "read", text: "a\u001b[2Jb" }).node?.text).toBe("a[2Jb");
    expect(progressSay(dir, run, { text: "c\u0007d", node: "read" }).node?.text).toBe("cd");

    const lines = statusLines(progressStatus(dir, run)).join("\n");
    expect(lines).not.toMatch(CONTROL);
  });

  it("prints a status with none of them even when the file itself carries them", () => {
    const { dir, run } = opened('flowchart TD\n  a["evil\u001b]8;;https://x\u0007"] --> b\n');
    const lines = statusLines(progressStatus(dir, run)).join("\n");
    expect(lines).toContain("evil");
    expect(lines).not.toMatch(CONTROL);
  });
});
describe("the run's end", () => {
  it("folds everything, removes the file, and refuses a straggler with RUN_CLOSED", () => {
    const { dir, run } = opened();
    progressNext(dir, run, { to: "body", from: "pre0" });
    progressStep(dir, run, { node: "read", text: "reading" });
    progressNote(dir, run, { text: "drafted", links: ["issue=https://x.test/12"] });

    const folded = closeProgress(dir, run, "ok");
    expect(folded?.chart).toBe(CHART);
    expect(folded?.taken).toEqual([["pre0", "body"]]);
    // Still running at the end means it did not finish: interrupted, not quietly done.
    expect(folded?.steps.find((s) => s.id === "read")).toMatchObject({ status: "interrupted", text: "reading" });
    expect(folded?.steps.find((s) => s.id === "pre0")?.status).toBe("done");
    expect(folded?.steps.find((s) => s.id === "post0")?.status).toBe("pending");
    expect(folded?.notes[0]?.links).toEqual([{ label: "issue", url: "https://x.test/12" }]);

    expect(existsSync(progressFile(dir, run))).toBe(false);
    expect(refusal(() => progressSay(dir, run, { text: "late", node: "read" })).code).toBe("RUN_CLOSED");
    expect(refusal(() => progressStatus(dir, run)).code).toBe("RUN_CLOSED");
    expect(refusal(() => progressStatus(dir, "20990101-000000-ffff")).code).toBe("UNKNOWN_RUN");
  });

  it("puts an abandoned run's progress onto the record the sweeper writes", () => {
    const { dir, run } = opened();
    progressStep(dir, run, { node: "read", text: "half way" });
    const rec = foldAbandoned(dir, { id: run, key: "user:/r:demo", outcome: "aborted" } as RunRecord);
    expect(rec.steps?.find((s) => s.id === "read")?.status).toBe("interrupted");
    expect(readProgress(dir, run)).toBeUndefined();
  });

  it("refuses a run id that would escape the progress directory", () => {
    expect(refusal(() => progressStatus(tempDir("pa-progress-"), "../secrets")).code).toBe("UNKNOWN_RUN");
    expect(refusal(() => progressStatus(tempDir("pa-progress-"), undefined)).code).toBe("NO_RUN");
  });
});

describe("a real run, with an agent reporting through pa", () => {
  it("tells the body how to report, hands it the run, and folds what it said into the record", async () => {
    const a = isolatedAutomation({
      name: "verify",
      frontmatter: "on:\n  manual: true\nhooks:\n  pre:\n    - script: pick.js\n  post:\n    - script: done.js\n",
      body: `# Verify\n\n\`\`\`mermaid\n${CHART}\`\`\`\n\nVerify it.\n`,
      scripts: {
        "pick.js": "process.stdout.write('PICK #12');\n",
        "done.js": "process.stdout.write('recorded');\n",
      },
    });

    const asked: string[] = [];
    let env: Record<string, string> = {};
    const rec = await fire(
      a.located,
      { trigger: "manual", now: () => HOST_NOW },
      isolatedFireDeps(a.stateDir, {
        startTracking: progressTracking,
        startSession: async (start: { env?: Record<string, string> }) => {
          env = { ...(start.env ?? {}) };
          return {
            file: "/sessions/fake.jsonl",
            id: "fake",
            prompt: async (text: string) => {
              asked.push(text);
              // What an agent following the guide does, with only what the run handed it.
              const pa = (...argv: string[]) => progressCli(argv, env);
              expect(pa("step", "read", "-m", "Reading #12").code).toBe(0);
              expect(pa("next", "draft", "--from", "read", "-m", "no browser needed").code).toBe(0);
              expect(pa("step", "draft", "--status", "done", "-m", "reproduced").code).toBe(0);
              expect(pa("note", "Drafted the verdict", "--link", "issue=https://x.test/issues/12").code).toBe(0);
              return "done";
            },
            dispose: () => {},
          };
        },
      }),
    );

    expect(rec.outcome).toBe("ok");
    expect(env.AUTOMATION_RUN).toBe(rec.id);
    expect(env.AUTOMATION_NODE).toBe("body");
    expect(env.AUTOMATION_STATE_DIR).toBe(a.stateDir);
    expect(asked[0]).toContain(progressGuide(CHART));
    expect(asked[0]).toContain("Nodes: pre0, body, read, reproduce, draft, post0");

    expect(rec.chart).toBe(CHART);
    const status = Object.fromEntries((rec.steps ?? []).map((s) => [s.id, s.status]));
    expect(status).toEqual({
      pre0: "done",
      body: "done",
      read: "done",
      reproduce: "pending",
      draft: "done",
      post0: "done",
    });
    expect(rec.taken).toEqual([["pre0", "body"], ["read", "draft"]]);
    expect(rec.notes).toEqual([
      { ts: expect.any(String), text: "Drafted the verdict", links: [{ label: "issue", url: "https://x.test/issues/12" }] },
    ]);
    expect(rec.flow).toBeUndefined();
    expect(readRecords(a.stateDir, a.located.key, 1)[0]?.notes).toEqual(rec.notes);

    // The events file is gone; only the tombstone that answers a straggler is left.
    expect(readdirSync(path.join(a.stateDir, "progress"))).toEqual([`${rec.id}.closed`]);
  });
});

describe("strict flow: next follows the chart's arrows", () => {
  function strictRun(): { dir: string; run: string } {
    const dir = tempDir("pa-progress-");
    const run = "20260917-140000-s1r2";
    openProgress(dir, { runId: run, key: "user:/r:demo", name: "demo", chart: CHART, strict: true });
    return { dir, run };
  }

  it("records strict on the open event and the snapshot; a loose run's open event is unchanged", () => {
    const s = strictRun();
    expect(JSON.parse(readFileSync(progressFile(s.dir, s.run), "utf8").split("\n")[0] as string).strict).toBe(true);
    expect(progressStatus(s.dir, s.run).strict).toBe(true);
    const l = opened();
    expect(Object.keys(JSON.parse(readFileSync(progressFile(l.dir, l.run), "utf8").split("\n")[0] as string))).toEqual([
      "t",
      "run",
      "key",
      "name",
      "at",
      "chart",
    ]);
    expect(progressStatus(l.dir, l.run)).not.toHaveProperty("strict");
  });

  it("refuses a move between steps with no arrow, naming where it can go", () => {
    const { dir, run } = strictRun();
    progressStep(dir, run, { node: "reproduce" });
    const e = refusal(() => progressNext(dir, run, { to: "read", from: "reproduce" }));
    expect(e.code).toBe("NOT_AN_EDGE");
    expect(e.message).toBe("the chart has no arrow reproduce → read; from reproduce it goes to draft");
    expect(e.suggestions).toEqual(["draft"]);
    expect(progressNext(dir, run, { to: "draft", from: "reproduce" }).changed).toBe(true);
  });

  it("leaves the run's own moves between hooks and the body alone, checks the body's way in, and leaves pa step free", () => {
    const { dir, run } = strictRun();
    expect(progressNext(dir, run, { to: "body", from: "pre0" }).changed).toBe(true);
    expect(progressNext(dir, run, { to: "post0", from: "body" }).changed).toBe(true);
    expect(refusal(() => progressNext(dir, run, { to: "draft", from: "body" })).message).toBe(
      "the chart has no arrow body → draft; from body it goes to read",
    );
    expect(progressNext(dir, run, { to: "read", from: "body" }).changed).toBe(true);
    expect(progressStep(dir, run, { node: "reproduce", status: "skipped" }).changed).toBe(true);
  });

  it("refuses through the CLI with exit 2, and a loose run still takes any move", () => {
    const { dir, run } = strictRun();
    const env = { AUTOMATION_RUN: run, AUTOMATION_STATE_DIR: dir };
    expect(progressCli(["step", "draft"], env).code).toBe(0);
    const r = progressCli(["next", "read", "--from", "draft"], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("pa: the chart has no arrow draft → read; from draft it goes to post0\n  did you mean: post0\n");
    const json = JSON.parse(progressCli(["next", "read", "--from", "draft", "--json"], env).stdout);
    expect(json.error.code).toBe("NOT_AN_EDGE");

    const loose = opened();
    const looseEnv = { AUTOMATION_RUN: loose.run, AUTOMATION_STATE_DIR: loose.dir };
    expect(progressCli(["step", "draft"], looseEnv).code).toBe(0);
    expect(progressCli(["next", "read", "--from", "draft"], looseEnv).code).toBe(0);
  });

  it("adds one line to the guide, and only in strict mode", () => {
    const strict = progressGuide(CHART, true).split("\n");
    const loose = progressGuide(CHART).split("\n");
    expect(strict.length).toBe(loose.length + 1);
    expect(strict.filter((l) => !loose.includes(l))).toEqual([
      "Each `##` section is one step: start it with `pa next <id> --from <the step before>`, following the chart's arrows.",
    ]);
  });

  it("is strict for a run of a flow: strict automation", async () => {
    const chart = 'flowchart TD\n  body["Review"] --> read["Read the change"]\n  read --> post["Post the comment"]\n';
    const a = isolatedAutomation({
      name: "strict-run",
      frontmatter: "flow: strict\non:\n  manual: true\n",
      body: `# Review\n\n\`\`\`mermaid\n${chart}\`\`\`\n\n## Read the change {#read}\n\nRead it.\n\n## Post the comment {#post}\n\nPost it.`,
    });
    const asked: string[] = [];
    const tried: number[] = [];
    await fire(
      a.located,
      { trigger: "manual", now: () => HOST_NOW },
      isolatedFireDeps(a.stateDir, {
        startTracking: progressTracking,
        startSession: async (start: { env?: Record<string, string> }) => {
          const env = { ...(start.env ?? {}) };
          return {
            file: "/s.jsonl",
            id: "s",
            prompt: async (t: string) => {
              asked.push(t);
              tried.push(progressCli(["next", "read"], env).code);
              tried.push(progressCli(["next", "post", "--from", "read"], env).code);
              tried.push(progressCli(["next", "read", "--from", "post"], env).code);
              return "ok";
            },
            dispose: () => {},
          };
        },
      }),
    );
    expect(asked[0]).toContain(progressGuide(chart, true));
    expect(tried).toEqual([0, 0, 2]);
  });
});

describe("a run with no chart still keeps its notes", () => {
  function plain() {
    return isolatedAutomation({
      name: "plain",
      frontmatter: "on:\n  manual: true\nhooks:\n  pre:\n    - script: env.js\n  post:\n    - script: env.js\n",
      scripts: {
        // Writes what this hook was given beside the state, one file per phase.
        "env.js":
          "const fs=require('fs'),p=require('path');" +
          "const k=['AUTOMATION_RUN','AUTOMATION_STATE_DIR','AUTOMATION_NODE'];const o={};" +
          "for(const n of k)o[n]=Object.prototype.hasOwnProperty.call(process.env,n)?process.env[n]:null;" +
          "fs.writeFileSync(p.join(process.env.AUTOMATION_STATE_DIR||'.',`env-${process.env.AUTOMATION_PHASE}.json`),JSON.stringify(o));\n",
      },
    });
  }

  it("gives the body the short notes guide and the run, records its note, and draws nothing", async () => {
    const a = plain();
    const asked: string[] = [];
    const events: string[] = [];
    let env: Record<string, string> = {};
    const tried: { code: number; stdout: string; stderr: string }[] = [];
    const rec = await fire(
      a.located,
      { trigger: "manual", now: () => HOST_NOW, emit: (e) => events.push(e.event) },
      isolatedFireDeps(a.stateDir, {
        startTracking: progressTracking,
        startSession: async (start: { env?: Record<string, string> }) => {
          env = { ...(start.env ?? {}) };
          return {
            file: "/s.jsonl",
            id: "s",
            prompt: async (t: string) => {
              asked.push(t);
              tried.push(progressCli(["step", "body", "--json"], env));
              tried.push(progressCli(["say", "hello", "--json"], env));
              tried.push(progressCli(["note", "Posted the summary", "--link", "summary=https://x.test/s/1"], env));
              return "ok";
            },
            dispose: () => {},
          };
        },
      }),
    );

    expect(rec.outcome).toBe("ok");
    expect(env).toMatchObject({ AUTOMATION_RUN: rec.id, AUTOMATION_STATE_DIR: a.stateDir });
    expect(env).not.toHaveProperty("AUTOMATION_NODE");
    expect(asked[0]).toContain(notesGuide());
    expect(asked[0]).not.toContain("<progress>");
    expect(events).not.toContain("flow");

    // Nothing to move: step and say are refused by name, and note is not.
    for (const r of tried.slice(0, 2)) {
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout).error.code).toBe("NO_CHART");
    }
    expect(tried[2]?.code).toBe(0);

    expect(rec.notes).toEqual([
      { ts: expect.any(String), text: "Posted the summary", links: [{ label: "summary", url: "https://x.test/s/1" }] },
    ]);
    expect(rec.chart).toBeUndefined();
    expect(rec.steps).toBeUndefined();
    expect(rec.flow).toBeUndefined();
    expect(readdirSync(path.join(a.stateDir, "progress"))).toEqual([`${rec.id}.closed`]);
  });

  it("gives every hook the run and the state directory, and no node", async () => {
    const a = plain();
    const rec = await fire(
      a.located,
      { trigger: "manual", now: () => HOST_NOW },
      isolatedFireDeps(a.stateDir, { startTracking: progressTracking }),
    );
    for (const phase of ["pre", "post"]) {
      const seen = JSON.parse(readFileSync(path.join(a.stateDir, `env-${phase}.json`), "utf8"));
      expect(seen).toEqual({ AUTOMATION_RUN: rec.id, AUTOMATION_STATE_DIR: a.stateDir, AUTOMATION_NODE: null });
    }
  });

  it("leaves a record with no notes exactly as it was", async () => {
    const a = isolatedAutomation({ name: "quiet", frontmatter: "on:\n  manual: true\n" });
    const rec = await fire(
      a.located,
      { trigger: "manual", now: () => HOST_NOW },
      isolatedFireDeps(a.stateDir, { startTracking: progressTracking }),
    );
    for (const k of ["chart", "steps", "taken", "notes", "flow"]) expect(k in rec).toBe(false);
  });
});
describe("several writers at once", () => {
  const BIN = path.join(import.meta.dirname, "..", "bin", "pi-automations.js");

  function pa(dir: string, run: string, args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...args, "--json"], {
        env: { ...process.env, AUTOMATION_RUN: run, AUTOMATION_STATE_DIR: dir, AUTOMATION_NODE: "" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
    });
  }

  it("converges a fan-in of separate processes, each arrow exactly once", async () => {
    const { dir, run } = opened(FAN, "20260917-140000-fan1");
    for (const b of ["a", "b", "c"]) progressStep(dir, run, { node: b });

    // Every branch reports twice, all at once: the retries must change nothing.
    const runs = await Promise.all(
      ["a", "b", "c", "a", "b", "c"].map((b) => pa(dir, run, ["next", "gather", "--from", b])),
    );
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0]);
    const changed = runs.map((r) => (JSON.parse(r.out) as { changed: boolean }).changed);
    expect(changed.filter(Boolean)).toHaveLength(3);

    const lines = readFileSync(progressFile(dir, run), "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes('"t":"next"'))).toHaveLength(3);
    expect(progressStatus(dir, run).taken.map(([a]) => a).sort()).toEqual(["a", "b", "c"]);
  }, 30_000);

  it("records a message once however many times it is retried with the same request id", async () => {
    const { dir, run } = opened(FAN, "20260917-140000-say1");
    progressStep(dir, run, { node: "gather" });

    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pa(dir, run, ["say", `done ${i % 2}`, "--node", "gather", "--request-id", `k${i % 2}`]),
      ),
    );
    expect(runs.every((r) => r.code === 0)).toBe(true);
    const lines = readFileSync(progressFile(dir, run), "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes('"t":"say"'))).toHaveLength(2);
    expect(lines.filter((l) => l.includes('"rid":"k0"'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('"rid":"k1"'))).toHaveLength(1);
  }, 30_000);

  it("holds under sustained contention: every check is made inside the lock", async () => {
    const { dir, run } = opened(FAN, "20260917-140000-hot1");
    for (const b of ["a", "b", "c"]) progressStep(dir, run, { node: b });
    const writer = path.join(import.meta.dirname, "helpers", "progress-writer.mjs");
    // Released together once every writer has had time to start.
    setTimeout(() => writeFileSync(path.join(dir, "go"), ""), 1500);

    const outs = await Promise.all(
      ["a", "b", "c", "a", "b", "c"].map(
        (b) =>
          new Promise<number>((resolve, reject) => {
            const child = spawn(process.execPath, [writer, dir, run, b, "60"], {
              windowsHide: true,
              stdio: ["ignore", "pipe", "inherit"],
            });
            let out = "";
            child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0 ? resolve((JSON.parse(out) as { changed: number }).changed) : reject(new Error(`exit ${code}`)),
            );
          }),
      ),
    );

    // 720 attempts between them; exactly five updates and three arrows were new.
    expect(outs.reduce((a, b) => a + b, 0)).toBe(8);
    const lines = readFileSync(progressFile(dir, run), "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes('"t":"say"'))).toHaveLength(5);
    expect(lines.filter((l) => l.includes('"t":"next"'))).toHaveLength(3);
    expect(existsSync(`${progressFile(dir, run).replace(/\.jsonl$/, "")}.lock`)).toBe(false);
  }, 60_000);
});
