import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AutomationError } from "../src/errors.js";
import {
  FIELDS,
  isIanaZone,
  MODEL_RE,
  NAME_RE,
  normalizeSchedule,
  parseAutomation,
  setEnabledInPlace,
  splitFrontmatter,
} from "../src/parse.js";
// @ts-expect-error - plain JS fixture builder, deliberately untyped
import { buildFixtures, INVALID } from "./helpers/fixtures.mjs";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

// Each test FILE builds its own fixture tree. vitest runs files in parallel, and one shared tree
// that every file wipes and rewrites made this file fail with ENOENT whenever another file happened
// to be rebuilding — a failure that never reproduced when either file ran alone.
let F: { userRoot: string; projectAutomations: string; invalidRoot: string };

beforeAll(() => {
  F = buildFixtures(tempDir("pi-fixtures-parse-"));
});
afterAll(cleanupTempDirs);

function readFixture(root: string, dir: string): string {
  return readFileSync(path.join(root, dir, "AUTOMATION.md"), "utf8");
}

function parseFixture(root: string, dir: string) {
  return parseAutomation(readFixture(root, dir), dir);
}

describe("splitFrontmatter", () => {
  it("splits on the first closing fence", () => {
    const r = splitFrontmatter("---\nname: x\n---\nbody\n---\nmore\n");
    expect(r?.yaml).toBe("name: x");
    expect(r?.body).toBe("body\n---\nmore\n");
  });

  it("tolerates CRLF", () => {
    const r = splitFrontmatter("---\r\nname: x\r\n---\r\nbody\r\n");
    expect(r?.yaml).toBe("name: x");
    expect(r?.body.trim()).toBe("body");
  });

  it("tolerates a byte order mark before the opening fence", () => {
    expect(splitFrontmatter("\uFEFF---\nname: x\n---\nbody\n")?.yaml).toBe("name: x");
  });

  it("returns undefined without an opening fence", () => {
    expect(splitFrontmatter("# Just markdown\n")).toBeUndefined();
  });

  it("returns undefined when the fence is never closed", () => {
    expect(splitFrontmatter("---\nname: x\nbody\n")).toBeUndefined();
  });
});

describe("parseAutomation — the valid fixtures", () => {
  it("parses the fully populated user automation", () => {
    const a = parseFixture(F.userRoot, "daily-briefing");
    expect(a.name).toBe("daily-briefing");
    expect(a.enabled).toBe(true);
    expect(a.model).toBe("anthropic/claude-sonnet-4-5:low");
    expect(a.timeout).toBe("10m");
    expect(a.on.manual).toBe(true);
    expect(a.on.schedule).toEqual({
      cron: "0 7 * * MON-FRI",
      timezone: "America/Los_Angeles",
      catchUp: "once",
    });
    expect(a.hooks.pre).toEqual([{ script: "scripts/overnight_counts.js" }]);
    expect(a.hooks.post).toEqual([{ script: "scripts/mark_run.js" }]);
    expect(a.body.startsWith("# Daily briefing")).toBe(true);
  });

  it("treats a bare cron string exactly like the mapping form", () => {
    const bare = parseFixture(F.userRoot, "weekly-report");
    expect(bare.on.schedule).toEqual({ cron: "0 9 * * MON", catchUp: "skip" });
    expect(normalizeSchedule("0 9 * * MON")).toEqual(
      normalizeSchedule({ cron: "0 9 * * MON" }),
    );
  });

  it("defaults enabled to true and manual to false", () => {
    const a = parseFixture(F.userRoot, "weekly-report");
    expect(a.enabled).toBe(true);
    expect(a.on.manual).toBe(false);
  });

  it("keeps enabled: false, which is the whole-automation switch", () => {
    expect(parseFixture(F.userRoot, "standup-notes").enabled).toBe(false);
  });

  it("parses a manual-only automation with no schedule", () => {
    const a = parseFixture(F.userRoot, "manual-only");
    expect(a.on.schedule).toBeUndefined();
    expect(a.on.manual).toBe(true);
  });

  it("keeps hook order within each phase", () => {
    const a = parseFixture(F.projectAutomations, "stale-pr-nudge");
    expect(a.hooks.pre).toEqual([
      { script: "scripts/list_stale.js" },
      { prompt: "If the list is empty answer skip, otherwise continue." },
    ]);
    expect(a.hooks.post).toEqual([
      { script: "scripts/post_summary.js" },
      { prompt: "Summarise what was posted in one line." },
    ]);
  });

  it("defaults hooks to two empty lists when the block is absent", () => {
    expect(parseFixture(F.userRoot, "manual-only").hooks).toEqual({ pre: [], post: [] });
  });

  it("keeps `on` a string key — YAML 1.1 would turn it into the boolean true", () => {
    // If the document were parsed as YAML 1.1 the trigger block would vanish entirely and this
    // automation would be rejected for having no `on` field.
    expect(parseFixture(F.userRoot, "manual-only").on.manual).toBe(true);
  });
});

describe("parseAutomation — one test per error line", () => {
  const cases = (INVALID as Array<{ dir: string; expect: string | null }>).filter(
    (c) => c.expect !== null,
  );

  it("covers every generated invalid fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of cases) {
    it(`${c.dir} -> ${c.expect}`, () => {
      let thrown: unknown;
      try {
        parseFixture(F.invalidRoot, c.dir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${c.dir} should have been refused`).toBeInstanceOf(AutomationError);
      expect((thrown as AutomationError).message).toBe(c.expect);
    });
  }

  it("names the real cause when a cron expression is left unquoted", () => {
    let thrown: unknown;
    try {
      parseFixture(F.invalidRoot, "unquoted-cron");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AutomationError);
    const msg = (thrown as AutomationError).message;
    expect(msg.startsWith("frontmatter: ")).toBe(true);
    expect(msg).toContain("quote the cron expression");
  });

  it("refuses a duplicated key rather than silently taking the last one", () => {
    let thrown: unknown;
    try {
      parseFixture(F.invalidRoot, "duplicate-key");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AutomationError);
    expect((thrown as AutomationError).message).toMatch(/frontmatter: .*(duplicate|unique)/i);
  });

  it("always produces exactly one line", () => {
    for (const c of INVALID as Array<{ dir: string }>) {
      try {
        parseFixture(F.invalidRoot, c.dir);
        throw new Error(`${c.dir} was accepted`);
      } catch (e) {
        expect(e, c.dir).toBeInstanceOf(AutomationError);
        expect((e as AutomationError).message.split("\n"), c.dir).toHaveLength(1);
      }
    }
  });
});

describe("parseAutomation — field limits", () => {
  const file = (fields: string, body = "Body.") =>
    `---\n${fields}on:\n  manual: true\n---\n\n${body}\n`;

  it("refuses a name over 64 characters", () => {
    const long = "a".repeat(65);
    expect(() => parseAutomation(file(`name: ${long}\ndescription: d\n`), long)).toThrow(
      "name: is 65 characters — the maximum is 64",
    );
  });

  it("refuses a description over 1024 characters", () => {
    const long = "d".repeat(1025);
    expect(() => parseAutomation(file(`name: x\ndescription: ${long}\n`), "x")).toThrow(
      "description: is 1025 characters — the maximum is 1024",
    );
  });

  it("accepts a description at exactly the limit", () => {
    const at = "d".repeat(1024);
    expect(parseAutomation(file(`name: x\ndescription: ${at}\n`), "x").description).toHaveLength(
      1024,
    );
  });

  it("accepts an explicit null for an optional field as absent", () => {
    const a = parseAutomation(file("name: x\ndescription: d\nmodel: null\ntimeout: null\n"), "x");
    expect(a.model).toBeUndefined();
    expect(a.timeout).toBeUndefined();
  });
});

describe("parseAutomation — flow", () => {
  const CHART = '```mermaid\nflowchart TD\n  read["Read the change"] --> post["Post the comment"]\n```';
  const STRICT_BODY = `# Review\n\n${CHART}\n\n## Read the change {#read}\n\nRead it.\n\n## Post the comment {#post}\n\nPost it.`;
  const file = (flow: string, body = STRICT_BODY) =>
    `---\nname: x\ndescription: d\non:\n  manual: true\n${flow}---\n\n${body}\n`;

  it("is loose when absent or loose, and leaves the automation as it was", () => {
    expect(parseAutomation(file(""), "x")).not.toHaveProperty("flow");
    expect(parseAutomation(file("flow: loose\n"), "x")).not.toHaveProperty("flow");
    expect(parseAutomation(file("flow: loose\n", "## Anything goes\n\nNo chart."), "x").body).toBe("## Anything goes\n\nNo chart.");
  });

  it("is strict when it says so, and a body that follows its chart parses", () => {
    expect(parseAutomation(file("flow: strict\n"), "x").flow).toBe("strict");
  });

  it("refuses any other value", () => {
    expect(() => parseAutomation(file("flow: tight\n"), "x")).toThrow('flow: "tight" is not loose or strict');
    expect(() => parseAutomation(file("flow: true\n"), "x")).toThrow("flow: true is not loose or strict");
  });

  it("refuses a strict body with every problem, numbered by the file's lines", () => {
    const body = `# Review\n\n${CHART}\n\n## Read it {#read}\n\n## Notes`;
    let error: AutomationError | undefined;
    try {
      parseAutomation(file("flow: strict\n", body), "x");
    } catch (e) {
      error = e as AutomationError;
    }
    expect(error).toBeInstanceOf(AutomationError);
    expect(error?.field).toBe("flow");
    expect(error?.problems).toEqual([
      'line 16: heading "Read it" does not match node `read`\'s label "Read the change" — make them the same text',
      'line 18: "## Notes" is not a step — end it with {#id} for its node on the chart, or make it a ### under a step',
      'node `post` ("Post the comment") has no section — add `## Post the comment {#post}`',
    ]);
    expect(error?.message).toBe(`flow: ${error?.problems?.join("; ")}`);
  });

  it("refuses a strict body without a chart", () => {
    expect(() => parseAutomation(file("flow: strict\n", "Just do it."), "x")).toThrow(
      "flow: the body has no flowchart — add a ```mermaid block that starts with flowchart TD and has a node per step, or remove flow: strict",
    );
  });

  it("names flow among the fields when refusing an unknown one", () => {
    expect(() => parseAutomation(file("mode: strict\n"), "x")).toThrow(
      "mode: unknown field — Draft 0.2 has name, description, enabled, model, timeout, on, hooks, flow",
    );
  });
});

describe("the closed lists", () => {
  it("has exactly the eight Draft 0.2 fields", () => {
    expect([...FIELDS]).toEqual([
      "name",
      "description",
      "enabled",
      "model",
      "timeout",
      "on",
      "hooks",
      "flow",
    ]);
  });

  it("NAME_RE matches the documented grammar", () => {
    for (const ok of ["a", "daily-briefing", "x1", "a-b-c", "123"]) {
      expect(NAME_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["", "-a", "a-", "a--b", "A", "a_b", "a b", "a.b"]) {
      expect(NAME_RE.test(bad), bad).toBe(false);
    }
  });

  it("MODEL_RE matches <provider>/<id>[:<thinking>]", () => {
    for (const ok of [
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-5:low",
      "openai/gpt-5.2",
      "google/gemini-2.5-pro:high",
    ]) {
      expect(MODEL_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["claude-sonnet-4-5", "anthropic/", "/model", "anthropic/a/b", "a b/c"]) {
      expect(MODEL_RE.test(bad), bad).toBe(false);
    }
  });

  it("MODEL_RE accepts the colons that real model ids contain", () => {
    for (const ok of [
      "amazon-bedrock/amazon.nova-2-lite-v1:0",
      "openrouter/some-model:exacto",
      "amazon-bedrock/amazon.nova-2-lite-v1:0",
    ]) {
      expect(MODEL_RE.test(ok), ok).toBe(true);
    }
  });
});

describe("isIanaZone", () => {
  it("accepts UTC, which Intl.supportedValuesOf omits", () => {
    expect(Intl.supportedValuesOf("timeZone").includes("UTC")).toBe(false);
    expect(isIanaZone("UTC")).toBe(true);
  });

  it("accepts real zones and refuses abbreviations", () => {
    expect(isIanaZone("America/Los_Angeles")).toBe(true);
    expect(isIanaZone("Europe/Berlin")).toBe(true);
    expect(isIanaZone("PST")).toBe(false);
    expect(isIanaZone("Mars/Olympus")).toBe(false);
    expect(isIanaZone("")).toBe(false);
    expect(isIanaZone(undefined)).toBe(false);
  });
});

describe("setEnabledInPlace", () => {
  const withEnabled = `---\nname: x\nenabled: true\ndescription: d\non:\n  manual: true\n---\n\nBody.\n`;
  const withoutEnabled = `---\nname: x\ndescription: d\non:\n  manual: true\n---\n\nBody.\n`;

  it("flips an existing line and touches nothing else", () => {
    const out = setEnabledInPlace(withEnabled, false);
    expect(out).toBe(withEnabled.replace("enabled: true", "enabled: false"));
  });

  it("keeps a trailing comment", () => {
    const src = `---\nname: x\nenabled: true  # paused during the release\ndescription: d\non:\n  manual: true\n---\n\nBody.\n`;
    const out = setEnabledInPlace(src, false);
    expect(out).toContain("enabled: false # paused during the release");
  });

  it("inserts after the name line when there is no enabled line", () => {
    const out = setEnabledInPlace(withoutEnabled, false);
    expect(out.split("\n").slice(0, 3)).toEqual(["---", "name: x", "enabled: false"]);
  });

  it("is a no-op when enabling a file that has no enabled line, because true is the default", () => {
    expect(setEnabledInPlace(withoutEnabled, true)).toBe(withoutEnabled);
  });

  it("preserves CRLF line endings", () => {
    const crlf = withEnabled.replace(/\n/g, "\r\n");
    const out = setEnabledInPlace(crlf, false);
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).toContain("enabled: false");
  });

  it("does not touch an enabled key that appears in the body", () => {
    const src = `---\nname: x\ndescription: d\non:\n  manual: true\n---\n\nenabled: true in the body\n`;
    const out = setEnabledInPlace(src, false);
    expect(out).toContain("enabled: true in the body");
    expect(out.split("\n")[2]).toBe("enabled: false");
  });

  it("leaves a file with no frontmatter alone", () => {
    expect(setEnabledInPlace("# no frontmatter\n", false)).toBe("# no frontmatter\n");
  });

  it("round-trips through the parser", () => {
    const off = setEnabledInPlace(withEnabled, false);
    expect(parseAutomation(off, "x").enabled).toBe(false);
    const on = setEnabledInPlace(off, true);
    expect(parseAutomation(on, "x").enabled).toBe(true);
  });
});
