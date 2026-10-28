/** The two agent skills: agent-automations stays host-neutral, and pi-automations names only real `pa` verbs. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SUBS } from "../src/commands.js";
import { IN_RUN_VERBS } from "../src/progress-cli.js";
import { mentionsPi } from "./helpers/pi-only.js";
import { readSkillFrontmatter } from "./helpers/skill-frontmatter.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORTABLE = path.join(ROOT, "skills", "agent-automations");
const PI_SKILL = path.join(ROOT, "skills", "pi-automations");

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** Every verb `pa` answers: the shared management verbs, the in-run verbs, and the CLI's own. */
function paVerbs(): Set<string> {
  const cli = readFileSync(path.join(ROOT, "bin", "pi-automations.js"), "utf8");
  const own = [...cli.matchAll(/argv\[0\] === "([a-z-]+)"/g)].map((m) => m[1] as string);
  expect(own, "the CLI's own verbs").toEqual(expect.arrayContaining(["tick", "serve", "watcher", "fire"]));
  return new Set([...SUBS, ...IN_RUN_VERBS, ...own]);
}

describe("the agent-automations skill", () => {
  it("knows what counts as a pi-automations mention", () => {
    for (const text of ["run `pa check x`", "pa note", "/automations arm x", "pi-automations", "`pi /login`", "NOT_AN_EDGE"]) {
      expect(mentionsPi(text), text).toBe(true);
    }
    for (const text of ["pass the path", "pages", "`~/.agents/automations/<name>/`", "https://pi.dev", "api", "spa-like"]) {
      expect(mentionsPi(text), text).toBe(false);
    }
  });

  it.each(walk(PORTABLE).map((f) => ({ name: rel(f), file: f })))("$name never names pa, pi or pi-automations", ({ file }) => {
    const lines = readFileSync(file, "utf8").split("\n");
    const found = lines.flatMap((line, i) => (mentionsPi(line) ? [`${i + 1}: ${line}`] : []));
    expect(found).toEqual([]);
  });
});

describe("the pi-automations skill", () => {
  const skill = readSkillFrontmatter(readFileSync(path.join(PI_SKILL, "SKILL.md"), "utf8"));

  it("has Agent Skills frontmatter and points to the format skill", () => {
    expect(skill.data.name).toBe(path.basename(PI_SKILL));
    expect(skill.data.license).toBe("MIT");
    const description = skill.data.description as string;
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Use when/);
    expect(String(skill.data.compatibility).length).toBeLessThanOrEqual(500);
    expect(skill.body).toContain("load the `agent-automations` skill");
    expect(skill.body.split("\n").length).toBeLessThan(500);
  });

  it("links only to files it has", () => {
    for (const file of walk(PI_SKILL).filter((f) => f.endsWith(".md"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/\]\(((?:references|assets)\/[^)#\s]+)/g)) {
        expect(statSync(path.join(PI_SKILL, m[1] as string), { throwIfNoEntry: false }), `${rel(file)} links to ${m[1]}`).toBeDefined();
      }
    }
  });

  it("names only verbs pa has", () => {
    const verbs = paVerbs();
    const used = new Set<string>();
    for (const file of walk(PI_SKILL)) {
      for (const m of readFileSync(file, "utf8").matchAll(/(?<![\w/.-])pa ([a-z][\w-]*)/g)) {
        const verb = m[1] as string;
        used.add(verb);
        expect(verbs.has(verb), `${rel(file)}: pa ${verb}`).toBe(true);
      }
    }
    for (const verb of ["check", "arm", "run", "runs", "watch", "watcher", "note", "message", "next"]) {
      expect(used, `the skill covers pa ${verb}`).toContain(verb);
    }
  });
});
