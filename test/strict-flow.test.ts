/** `flow: strict`: the checker that holds a body's `##` sections to its flowchart. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { composeAutomationText, fieldsFromAutomation, problemsFromError } from "../src/authoring/compose.js";
import { handleCheck, type CommandDeps, type Refreshed } from "../src/commands.js";
import { DEFAULTS } from "../src/config.js";
import { discover, located } from "../src/discover.js";
import { parseAutomation } from "../src/parse.js";
import { State } from "../src/state.js";
import { computeStatuses } from "../src/status.js";
import { checkStrictFlow, flowProblemLine, plainText } from "../src/strict-flow.js";
import { Trust } from "../src/trust.js";
import type { Status } from "../src/types.js";
import { checkPageLines } from "../src/ui/check.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const CHART = [
  "```mermaid",
  "flowchart TD",
  '  pre0["Pick the change"] --> body["Review it"]',
  '  body --> read["Read the change"]',
  '  read --> map["Map the code"]',
  '  map --> draft["Draft the review"]',
  '  draft -->|clean| post["Post the comment"]',
  '  draft -->|findings| fix["Fix the findings"]',
  "  fix -->|again| draft",
  "  post --> post0",
  "```",
].join("\n");

const SECTIONS = {
  read: "## Read the change {#read}\n\nRead the diff.",
  map: "## Map the code {#map}\n\nList what it touches.",
  draft: "## Draft the review {#draft}\n\nIf nothing is left, `pa next post`; otherwise go to Fix the findings.",
  fix: "## Fix the findings {#fix}\n\nFix them, then back to `pa next draft`.",
  post: "## Post the comment {#post}\n\nPost it.",
};

function body(parts: string[], chart = CHART): string {
  return ["# Review a change", "", chart, "", ...parts.flatMap((p) => [p, ""])].join("\n");
}

const VALID = body(Object.values(SECTIONS));

function lines(text: string, firstLine = 1): string[] {
  return checkStrictFlow(text, firstLine).map(flowProblemLine);
}

describe("a strict body that follows its chart", () => {
  it("has no problems, with a retry loop, an intro and ### subsections", () => {
    const text = body([
      "The intro before the first step is free text.",
      SECTIONS.read,
      "### Details\n\nA subsection belongs to the step above it.",
      SECTIONS.map,
      SECTIONS.draft,
      SECTIONS.fix,
      SECTIONS.post,
    ]);
    expect(lines(text)).toEqual([]);
    expect(lines(VALID)).toEqual([]);
  });

  it("ignores headings inside code fences", () => {
    const fenced = "```markdown\n## Not a step\n## Another {#nope}\n```";
    const tilde = "~~~\n## Also not one\n~~~";
    expect(lines(body([SECTIONS.read, fenced, tilde, SECTIONS.map, SECTIONS.draft, SECTIONS.fix, SECTIONS.post]))).toEqual([]);
  });

  it("matches labels with <br/>, quotes and inline code, and headings with emphasis and code", () => {
    const chart = [
      "```mermaid",
      "flowchart LR",
      '  a["Read the<br/>change"] --> b["Run `npm test`"]',
      "  b --> c[Ship it]",
      "```",
    ].join("\n");
    const text = body(["## Read the  change {#a}", "## Run `npm test` {#b}", "## **Ship** it {#c}"], chart);
    expect(lines(text)).toEqual([]);
  });

  it("uses the id as the label of a node that has none", () => {
    const chart = "```mermaid\nflowchart TD\n  gather --> report\n```";
    expect(lines(body(["## gather {#gather}", "## report {#report}"], chart))).toEqual([]);
  });

  it("keeps the step names a branch mentions by id, by #id, by pa next, or by label in any case", () => {
    const chart = "```mermaid\nflowchart TD\n  check --> ok[\"Ship it\"]\n  check --> bad[\"Send it back\"]\n```";
    const variants = [
      "Go to ok, or to bad.",
      "See #ok and #bad.",
      "Run `pa next ok` or `pa next bad`.",
      "Then ship it — or SEND IT BACK.",
    ];
    for (const v of variants) {
      const text = body([`## check {#check}\n\n${v}`, "## Ship it {#ok}", "## Send it back {#bad}"], chart);
      expect(lines(text), v).toEqual([]);
    }
  });
});

describe("rule a: the chart", () => {
  it("refuses a strict body with no flowchart", () => {
    expect(lines("# Title\n\n## Read {#read}\n")).toEqual([
      "the body has no flowchart — add a ```mermaid block that starts with flowchart TD and has a node per step, or remove flow: strict",
    ]);
  });

  it("takes only a mermaid flowchart, not another diagram", () => {
    expect(lines("```mermaid\nsequenceDiagram\n  a->>b: hi\n```\n")).toHaveLength(1);
  });
});

describe("rule b: one section per step", () => {
  it("names a step with no section and the heading that would fix it", () => {
    const text = body([SECTIONS.read, SECTIONS.map, SECTIONS.draft, SECTIONS.post]);
    expect(lines(text)).toEqual(['node `fix` ("Fix the findings") has no section — add `## Fix the findings {#fix}`']);
  });

  it("refuses a second section for the same step", () => {
    const text = body([SECTIONS.read, "## Read the change {#read}", SECTIONS.map, SECTIONS.draft, SECTIONS.fix, SECTIONS.post]);
    expect(lines(text)).toEqual(["line 19: `read` has a second section — merge it into the one on line 15"]);
  });
});

describe("rule c: every ## is a step", () => {
  it("refuses a ## with no id, one with an id not on the chart, and one naming a hook or the body", () => {
    const text = body([
      "## Notes",
      SECTIONS.read,
      SECTIONS.map,
      SECTIONS.draft,
      "## Something else {#other}",
      SECTIONS.fix,
      SECTIONS.post,
      "## Record {#post0}",
      "## The run {#body}",
    ]);
    expect(lines(text)).toEqual([
      'line 15: "## Notes" is not a step — end it with {#id} for its node on the chart, or make it a ### under a step',
      'line 29: "## Something else {#other}" names `other`, which is not on the chart — use one of read, map, draft, post, fix, or add other to the chart',
      'line 39: "## Record {#post0}" names `post0`, which is a hook and has no section — give it a step\'s id, or make it a ### under a step',
      'line 41: "## The run {#body}" names `body`, which is the body and has no section — give it a step\'s id, or make it a ### under a step',
    ]);
  });

  it("recognises a step's heading without its id, numbered or not, and says what to write", () => {
    const text = body(["## 1. Read the change", SECTIONS.map, SECTIONS.draft, SECTIONS.fix, SECTIONS.post]);
    expect(lines(text)).toEqual(['line 15: "## 1. Read the change" has no node id — write `## Read the change {#read}`']);
  });

  it("does not count a trailing closing sequence as part of the heading", () => {
    const text = body(["## Read the change {#read} ##", SECTIONS.map, SECTIONS.draft, SECTIONS.fix, SECTIONS.post]);
    expect(lines(text)).toEqual([]);
  });
});

describe("rule d: the heading is the node's label", () => {
  it("shows both texts", () => {
    const text = body(["## Read the diff {#read}", SECTIONS.map, SECTIONS.draft, SECTIONS.fix, SECTIONS.post]);
    expect(lines(text)).toEqual([
      'line 15: heading "Read the diff" does not match node `read`\'s label "Read the change" — make them the same text',
    ]);
  });
});

describe("rule e: sections in the chart's order", () => {
  it("refuses a section above the step that leads to it", () => {
    const text = body([SECTIONS.map, SECTIONS.read, SECTIONS.draft, SECTIONS.fix, SECTIONS.post]);
    expect(lines(text)).toEqual([
      "line 15: section `map` comes before `read` (line 19), but the chart goes read → map — move `map` below `read`",
    ]);
  });

  it("does not order the steps of a loop", () => {
    expect(lines(VALID)).toEqual([]);
    const text = body([SECTIONS.read, SECTIONS.map, SECTIONS.fix, SECTIONS.draft, SECTIONS.post]);
    expect(lines(text)).toEqual([]);
  });

  it("gives the same answer whichever arrow the chart lists first", () => {
    const sections = ["## read {#read}\n\nGo to verify, or skip to report.", "## verify {#verify}", "## report {#report}"];
    const a = "```mermaid\nflowchart TD\n  body --> read\n  read --> verify\n  read -->|skip| report\n  verify --> report\n  report -->|retry| verify\n```";
    const b = "```mermaid\nflowchart TD\n  body --> read\n  read -->|skip| report\n  read --> verify\n  verify --> report\n  report -->|retry| verify\n```";
    expect(lines(body(sections, a))).toEqual([]);
    expect(lines(body(sections, b))).toEqual([]);
  });

  it("orders a whole loop against the steps before and after it", () => {
    const chart = "```mermaid\nflowchart TD\n  a --> b\n  b --> c\n  c -->|retry| b\n  c --> d\n```";
    const C = "## c {#c}\n\nBack to b, or on to d.";
    expect(lines(body(["## a {#a}", "## b {#b}", C, "## d {#d}"], chart))).toEqual([]);
    expect(lines(body(["## a {#a}", C, "## d {#d}", "## b {#b}"], chart))).toEqual([
      "line 17: section `d` comes before `b` (line 19), but the chart goes c → d, and `b` is on a loop with `c` — move `d` below `b`",
    ]);
    expect(lines(body([C, "## a {#a}", "## b {#b}", "## d {#d}"], chart))).toEqual([
      "line 11: section `c` comes before `a` (line 15), but the chart goes a → b, and `c` is on a loop with `b` — move `c` below `a`",
    ]);
  });
});

describe("subgraphs", () => {
  it("does not take a subgraph an arrow points at for a step", () => {
    const chart = [
      "```mermaid",
      "flowchart TD",
      "  read --> checks",
      "  subgraph checks [Checks]",
      "    lint --> test",
      "  end",
      "```",
    ].join("\n");
    expect(lines(body(["## read {#read}", "## lint {#lint}", "## test {#test}"], chart))).toEqual([]);
    expect(lines(body(["## read {#read}", "## lint {#lint}", "## test {#test}", "## checks {#checks}"], chart))[0]).toContain(
      "names `checks`, which is not on the chart",
    );
  });

  it("still gives a loose chart's subgraph arrow a node, as progress tracking expects", async () => {
    const { parseChart } = await import("../src/chart.js");
    const c = parseChart("flowchart TD\n  read --> checks\n  subgraph checks [Checks]\n    lint\n  end\n  subgraph Plain title\n  end\n");
    expect(c.nodes.map((n) => n.id)).toEqual(["read", "checks", "lint"]);
    expect(c.subgraphs).toEqual(["checks"]);
  });
});

describe("rule f: a branch names where it goes", () => {
  it("names the successor a branching section never mentions", () => {
    const draft = "## Draft the review {#draft}\n\nWrite it, then `pa next post`.";
    const text = body([SECTIONS.read, SECTIONS.map, draft, SECTIONS.fix, SECTIONS.post]);
    expect(lines(text)).toEqual([
      'line 23: section `draft` branches to `post` and `fix` but never mentions `fix` ("Fix the findings") — say when to go there, for example `then go to fix`',
    ]);
  });

  it("counts a mention under a ### of the section, not one in the next section", () => {
    const chart = "```mermaid\nflowchart TD\n  check --> ok\n  check --> bad\n```";
    const under = body(["## check {#check}\n\n### Then\n\nGo to ok or bad.", "## ok {#ok}", "## bad {#bad}"], chart);
    expect(lines(under)).toEqual([]);
    const later = body(["## check {#check}\n\nGo to ok.", "## ok {#ok}\n\nNot bad.", "## bad {#bad}"], chart);
    expect(lines(later)).toHaveLength(1);
  });

  it("does not take a longer word for the id", () => {
    const chart = "```mermaid\nflowchart TD\n  check --> ok\n  check --> bad\n```";
    const text = body(["## check {#check}\n\nIt is okay, or badly done.", "## ok {#ok}", "## bad {#bad}"], chart);
    expect(lines(text)).toHaveLength(2);
  });
});

describe("every problem at once", () => {
  it("collects them all, by line, chart-wide ones last, numbered from firstLine", () => {
    const text = body(["## Notes", SECTIONS.map, "## Read the diff {#read}", "## Draft the review {#draft}\n\nThen `pa next post`."]);
    expect(lines(text, 8)).toEqual([
      'line 22: "## Notes" is not a step — end it with {#id} for its node on the chart, or make it a ### under a step',
      "line 24: section `map` comes before `read` (line 28), but the chart goes read → map — move `map` below `read`",
      'line 28: heading "Read the diff" does not match node `read`\'s label "Read the change" — make them the same text',
      'line 30: section `draft` branches to `post` and `fix` but never mentions `fix` ("Fix the findings") — say when to go there, for example `then go to fix`',
      'node `post` ("Post the comment") has no section — add `## Post the comment {#post}`',
      'node `fix` ("Fix the findings") has no section — add `## Fix the findings {#fix}`',
    ]);
  });
});

describe("plainText", () => {
  it("decodes Mermaid entity codes and HTML entities on both sides", () => {
    expect(plainText("Fix #quot;flaky#quot; tests")).toBe("Fix flaky tests");
    expect(plainText("Issue #35;12 &amp; &lt;b&gt; &#35;3 &#x41;")).toBe("Issue #12 & <b> #3 A");
    const chart = '```mermaid\nflowchart TD\n  a["Fix #quot;flaky#quot; tests"] --> b["Build &amp; test"]\n  b --> c["Ship #35;1"]\n```';
    expect(lines(body(['## Fix "flaky" tests {#a}', "## Build & test {#b}", "## Ship #1 {#c}"], chart))).toEqual([]);
    expect(lines(body(["## Fix &quot;flaky&quot; tests {#a}", "## Build &amp; test {#b}", "## Ship &#35;1 {#c}"], chart))).toEqual([]);
  });

  it("drops markup and quotes and collapses space", () => {
    expect(plainText('Read the<br/>"change"')).toBe("Read the change");
    expect(plainText("**Bold** _em_ `code` [link](https://x.test) ~~gone~~")).toBe("Bold em code link gone");
    expect(plainText("snake_case_name stays")).toBe("snake_case_name stays");
  });
});

describe("where a strict refusal shows", () => {
  const NOW = new Date("2026-09-17T14:00:00Z");
  const CHART_ONLY = '```mermaid\nflowchart TD\n  read["Read the change"] --> post["Post the comment"]\n```';
  const text = (body: string) => `---\nname: review\ndescription: Review a change.\nflow: strict\non:\n  manual: true\n---\n\n# Review\n\n${CHART_ONLY}\n\n${body}\n`;

  async function statusOf(body: string): Promise<{ s: Status; r: Refreshed; deps: CommandDeps }> {
    const root = tempDir("pa-strict-");
    mkdirSync(path.join(root, "review"));
    writeFileSync(path.join(root, "review", "AUTOMATION.md"), text(body));
    const stateDir = tempDir("pa-strict-state-");
    const found = discover({ roots: [{ path: root, scope: "user", kind: "agents" }] });
    const statuses = await computeStatuses(found, { trust: new Trust(stateDir), config: DEFAULTS, stateDir, now: NOW });
    const deps: CommandDeps = {
      config: DEFAULTS,
      stateDir,
      trust: new Trust(stateDir),
      state: new State(stateDir),
      now: () => NOW,
      home: path.resolve("/home/nobody"),
      cwd: stateDir,
      spawnFire: () => 0,
    };
    return { s: statuses[0] as Status, r: { statuses, byKey: new Map(located(found).map((l) => [l.key, l])), projectRoots: [] }, deps };
  }

  it("lists the automation as invalid, and pa check and the check page give each problem a line", async () => {
    const { s, r, deps } = await statusOf("## Read it {#read}\n\n## Notes");
    expect(s.state).toBe("invalid");
    expect(s.problems).toHaveLength(3);
    expect(s.reason).toBe(`flow: ${s.problems?.join("; ")}`);

    const check = (await handleCheck(deps, r, "review")).lines;
    expect(check.slice(0, 5)).toEqual([
      "review  invalid",
      "  reason        flow: 3 problems",
      '    line 16: heading "Read it" does not match node `read`\'s label "Read the change" — make them the same text',
      '    line 18: "## Notes" is not a step — end it with {#id} for its node on the chart, or make it a ### under a step',
      '    node `post` ("Post the comment") has no section — add `## Post the comment {#post}`',
    ]);

    const page = checkPageLines({ status: s, now: NOW, home: deps.home, config: DEFAULTS }).join("\n");
    for (const p of s.problems ?? []) expect(page).toContain(p);
  });

  it("gives the Automation Manager one problem per line", () => {
    let error: unknown;
    try {
      parseAutomation(text("## Read it {#read}"), "review");
    } catch (e) {
      error = e;
    }
    expect(problemsFromError(error).map((p) => p.message)).toEqual([
      'flow: line 16: heading "Read it" does not match node `read`\'s label "Read the change" — make them the same text',
      'flow: node `post` ("Post the comment") has no section — add `## Post the comment {#post}`',
    ]);
    expect(problemsFromError(new Error("plain"))).toHaveLength(1);
  });

  it("keeps flow: strict when the manager saves an edited field", () => {
    const current = text("## Read the change {#read}\n\nRead it.\n\n## Post the comment {#post}\n\nPost it.");
    const fields = fieldsFromAutomation(parseAutomation(current, "review"));
    const saved = composeAutomationText(current, "review", { ...fields, description: "Review one change." });
    expect(saved).toContain("flow: strict\n");
    expect(parseAutomation(saved, "review")).toMatchObject({ flow: "strict", description: "Review one change." });
  });
});