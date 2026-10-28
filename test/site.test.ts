/** The spec site and the bundled agent skill: every example parses as documented, and site/dist is current. */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error -- a plain ESM build script with no type declarations
import { buildSite, DEFAULT_OUT, extractExamples, PI_GROUP, SKILL_OUT, SKILL_ZIP, splitFrontMatter } from "../site/build.mjs";
import { parseAutomation, splitFrontmatter } from "../src/parse.js";
import { mentionsPi } from "./helpers/pi-only.js";
import { tempDir } from "./helpers/temp.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const SKILL_DIR = path.join(ROOT, "skills", "agent-automations");
const PI_SKILL_DIR = path.join(ROOT, "skills", "pi-automations");

interface Example {
  lang: string;
  flags: string[];
  attrs: Record<string, string>;
  code: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** Turn an example into the AUTOMATION.md text and the directory name a host would see. */
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

/** Markdown documents whose `automation` and `frontmatter` examples must parse as marked. */
const documents = [
  ...readdirSync(path.join(SITE, "content"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(SITE, "content", f)),
  ...walk(SKILL_DIR).filter((f) => f.endsWith(".md") && path.basename(f) !== "AUTOMATION.md"),
  ...walk(PI_SKILL_DIR).filter((f) => f.endsWith(".md")),
];

describe("site and skill examples", () => {
  const cases = documents.flatMap((file) =>
    (extractExamples(readFileSync(file, "utf8")) as Example[]).map((ex, i) => ({
      name: `${rel(file)} #${i + 1}${ex.attrs.title ? ` (${ex.attrs.title})` : ""}`,
      ex,
    })),
  );

  it("finds examples on every page that should have them", () => {
    const counted = new Set(cases.map((c) => c.name.split(" #")[0]));
    for (const page of [
      "site/content/index.md",
      "site/content/specification.md",
      "site/content/flowcharts.md",
      "site/content/quickstart.md",
      "site/content/watch-scripts.md",
      "site/content/reporting.md",
      "site/content/quickstart-pi.md",
      "skills/agent-automations/SKILL.md",
      "skills/pi-automations/references/reporting.md",
    ]) {
      expect(counted, page).toContain(page);
    }
    expect(cases.filter((c) => c.ex.attrs.invalid !== undefined).length).toBeGreaterThan(15);
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
  const skill = splitFrontMatter(readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8")) as {
    data: Record<string, unknown>;
    body: string;
  };

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

describe("host-neutral pages", () => {
  const pages = readdirSync(path.join(SITE, "content"))
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const { data, body } = splitFrontMatter(readFileSync(path.join(SITE, "content", file), "utf8")) as {
        data: Record<string, unknown>;
        body: string;
      };
      return { file, group: data.group, body };
    });
  const piPages = new Set(pages.filter((p) => p.group === PI_GROUP).map((p) => p.file));

  it("keeps everything about pi-automations in its own group", () => {
    expect([...piPages].sort()).toEqual(["pi-automations.md", "pi-implementation.md", "quickstart-pi.md", "reporting.md"]);
  });

  // A page outside the group may name pi-automations only in a line that links into the group.
  it.each(pages.filter((p) => !piPages.has(p.file)).map((p) => ({ name: p.file, ...p })))(
    "$name does not mention pa, pi or pi-automations",
    ({ body }) => {
      const found = body.split("\n").flatMap((line, i) => {
        const targets = [...line.matchAll(/\]\(([^)\s#]+)/g)].map((m) => m[1] as string);
        if (!mentionsPi(line.replace(/\]\([^)]*\)/g, "]()"))) return [];
        return targets.some((t) => piPages.has(t)) ? [] : [`${i + 1}: ${line}`];
      });
      expect(found).toEqual([]);
    },
  );
});

/** The files of a stored zip, by name. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const start = at + 30 + nameLength + zip.readUInt16LE(at + 28);
    expect(zip.readUInt16LE(at + 8), "stored, not compressed").toBe(0);
    files.set(zip.toString("utf8", at + 30, at + 30 + nameLength), zip.subarray(start, start + size));
    at = start + size;
  }
  return files;
}

describe("site/dist", () => {
  let built: { out: string; files: string[]; pages: string[] } | undefined;
  const build = () => {
    if (!built) {
      const out = tempDir("pa-site-");
      built = { out, ...(buildSite({ outDir: out }) as { files: string[]; pages: string[] }) };
    }
    return built;
  };

  it("has pages rendered from the agent skill, and a byte-identical copy of it", () => {
    const { out, files, pages } = build();
    const references = readdirSync(path.join(SKILL_DIR, "references")).filter((f) => f.endsWith(".md"));
    expect(pages).toEqual(
      expect.arrayContaining(["skill", ...references.map((f) => `skill-${f.replace(/\.md$/, "")}`)]),
    );

    const skillFiles = walk(SKILL_DIR).map((f) => path.relative(SKILL_DIR, f).split(path.sep).join("/"));
    expect(files.filter((f) => f.startsWith(`${SKILL_OUT}/`))).toEqual(skillFiles.map((f) => `${SKILL_OUT}/${f}`));
    const zipped = unzip(readFileSync(path.join(out, SKILL_ZIP)));
    expect([...zipped.keys()]).toEqual(skillFiles.map((f) => `agent-automations/${f}`));
    for (const f of skillFiles) {
      const original = readFileSync(path.join(SKILL_DIR, f));
      expect(readFileSync(path.join(out, SKILL_OUT, f)).equals(original), f).toBe(true);
      expect(zipped.get(`agent-automations/${f}`)?.equals(original), `zip: ${f}`).toBe(true);
    }

    const page = readFileSync(path.join(out, "skill.html"), "utf8");
    expect(page).toContain(`href="${SKILL_ZIP}"`);
    expect(page).toContain(`href="${SKILL_OUT}/SKILL.md"`);
    expect(page).toContain('href="skill-checklist.html"');

    // Only the host-neutral skill is published; the pi-automations skill ships in the package only.
    expect(files.filter((f) => f.startsWith("skills/") && !f.startsWith(`${SKILL_OUT}/`) && f !== SKILL_ZIP)).toEqual([]);
    const llms = readFileSync(path.join(out, "llms.txt"), "utf8");
    expect(llms).toContain(`(${SKILL_OUT}/SKILL.md)`);
    expect(llms).not.toContain("skills/pi-automations");
    for (const f of references) expect(llms).toContain(`(${SKILL_OUT}/references/${f})`);
  });

  it("builds with every internal link resolving, and matches the committed copy", () => {
    const { out, files, pages } = build();
    expect(pages).toEqual(
      expect.arrayContaining([
        "index",
        "specification",
        "flowcharts",
        "watch-scripts",
        "adding-support",
        "pi-automations",
        "quickstart-pi",
        "reporting",
        "pi-implementation",
      ]),
    );
    expect(files).toContain("llms.txt");

    const committed = walk(DEFAULT_OUT as string).map((f) => path.relative(DEFAULT_OUT as string, f).split(path.sep).join("/"));
    expect(committed, "site/dist is out of date: run npm run site").toEqual(files);
    const stale = files.filter(
      (f) => readFileSync(path.join(out, f)).compare(readFileSync(path.join(DEFAULT_OUT as string, f))) !== 0,
    );
    expect(stale, "site/dist is out of date: run npm run site").toEqual([]);
  });
});
