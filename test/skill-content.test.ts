import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseAutomation, splitFrontmatter } from "../src/parse.js";
import { extractExamples, type Example } from "./helpers/automation-examples.js";
import { readSkillFrontmatter } from "./helpers/skill-frontmatter.js";
import { tempDir } from "./helpers/temp.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILL_DIR = path.join(ROOT, "skills", "agent-automations");
const PI_SKILL_DIR = path.join(ROOT, "skills", "pi-automations");

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

function asAutomation(ex: Example): { text: string; dir: string } {
  const text = ex.flags.includes("frontmatter") ? `---\n${ex.code}\n---\n\nRun.\n` : ex.code;
  const yaml = splitFrontmatter(text)?.yaml ?? "";
  const named = /^name:\s*["']?([^"'\s#]+)/m.exec(yaml)?.[1];
  return { text, dir: ex.attrs.dir ?? named ?? "example" };
}

function parseError(text: string, dir: string): string | undefined {
  try {
    parseAutomation(text, dir);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

const documents = [
  ...walk(SKILL_DIR).filter((f) => f.endsWith(".md") && path.basename(f) !== "AUTOMATION.md"),
  ...walk(PI_SKILL_DIR).filter((f) => f.endsWith(".md")),
];

describe("skill examples", () => {
  const cases = documents.flatMap((file) =>
    extractExamples(readFileSync(file, "utf8")).map((ex, i) => ({
      name: `${rel(file)} #${i + 1}${ex.attrs.title ? ` (${ex.attrs.title})` : ""}`,
      ex,
    })),
  );

  it("finds examples in both skills", () => {
    const counted = new Set(cases.map((c) => c.name.split(" #")[0]));
    expect(counted).toContain("skills/agent-automations/SKILL.md");
    expect(counted).toContain("skills/pi-automations/references/reporting.md");
  });

  it("keeps a nested fence inside a longer example fence", () => {
    const text = [
      '````markdown automation title="Example"',
      "---",
      "name: example",
      "---",
      "```mermaid",
      "flowchart LR",
      "```",
      "````",
    ].join("\n");
    expect(extractExamples(text)).toEqual([
      {
        lang: "markdown",
        flags: ["automation"],
        attrs: { title: "Example" },
        code: "---\nname: example\n---\n```mermaid\nflowchart LR\n```",
      },
    ]);
  });

  it.each(cases)("$name", ({ ex }) => {
    const { text, dir } = asAutomation(ex);
    const error = parseError(text, dir);
    if (ex.attrs.invalid !== undefined) {
      expect(error, "the example should be refused").toBe(ex.attrs.invalid);
    } else {
      expect(error, "the example should parse").toBeUndefined();
    }
  });
});

describe("the agent skill", () => {
  const skill = readSkillFrontmatter(readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8"));

  it("has Agent Skills frontmatter", () => {
    expect(skill.data.name).toBe(path.basename(SKILL_DIR));
    expect(skill.data.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof skill.data.description).toBe("string");
    const description = skill.data.description as string;
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Use when/);
    if (skill.data.compatibility !== undefined) {
      expect(String(skill.data.compatibility).length).toBeLessThanOrEqual(500);
    }
  });

  it("stays short, opens with its decision flowchart and links only to files it has", () => {
    expect(skill.body.split("\n").length).toBeLessThan(500);
    const firstFence = /^```(\S*)/m.exec(skill.body);
    expect(firstFence?.[1]).toBe("mermaid");

    for (const file of walk(SKILL_DIR).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\]\(((?:references|assets)\/[^)#\s]+)/g)) {
        const target = path.join(SKILL_DIR, m[1] as string);
        expect(statSync(target, { throwIfNoEntry: false }), `${rel(file)} links to ${m[1]}`).toBeDefined();
      }
    }
  });

  const templates = walk(path.join(SKILL_DIR, "assets")).filter((f) => path.basename(f) === "AUTOMATION.md");

  it("has a template for each trigger", () => {
    const parsed = templates.map((f) => parseAutomation(readFileSync(f, "utf8"), path.basename(path.dirname(f))));
    expect(parsed.some((a) => a.on.schedule)).toBe(true);
    expect(parsed.some((a) => a.on.watch)).toBe(true);
    expect(parsed.some((a) => a.on.manual && !a.on.schedule && !a.on.watch)).toBe(true);
  });

  it.each(templates.map((f) => ({ name: rel(f), file: f })))("$name parses and its scripts exist", ({ file }) => {
    const dir = path.dirname(file);
    const automation = parseAutomation(readFileSync(file, "utf8"), path.basename(dir));
    const scripts = [
      ...(automation.on.watch ? [automation.on.watch.script] : []),
      ...[...automation.hooks.pre, ...automation.hooks.post].flatMap((h) => ("script" in h ? [h.script] : [])),
    ];
    for (const script of scripts) {
      expect(statSync(path.join(dir, script), { throwIfNoEntry: false }), script).toBeDefined();
    }
  });

  it("ships a watch script that keeps the exit-code contract", () => {
    const dir = tempDir("pa-skill-watch-");
    const script = path.join(SKILL_DIR, "assets", "watch-inbox", "scripts", "watch.mjs");
    const check = () => {
      try {
        const stdout = execFileSync(process.execPath, [script], {
          cwd: dir,
          env: { ...process.env, AUTOMATION_DIR: dir },
          encoding: "utf8",
          stdio: "pipe",
        });
        return { exit: 0, stdout };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { exit: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
      }
    };

    expect(check()).toMatchObject({ exit: 3, stdout: "" });
    mkdirSync(path.join(dir, "inbox", "processed"), { recursive: true });
    expect(check()).toMatchObject({ exit: 3 });
    writeFileSync(path.join(dir, "inbox", "b.txt"), "second");
    writeFileSync(path.join(dir, "inbox", "a.txt"), "first");
    expect(check()).toEqual({ exit: 0, stdout: "a.txt\nb.txt\n" });
  });
});
