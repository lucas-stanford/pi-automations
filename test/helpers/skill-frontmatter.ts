import { parse as parseYaml } from "yaml";

import { splitFrontmatter } from "../../src/parse.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSkillFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const parts = splitFrontmatter(text);
  if (!parts) throw new Error("Skill is missing frontmatter");
  const data: unknown = parseYaml(parts.yaml);
  if (!isRecord(data)) throw new Error("Skill frontmatter must be a mapping");
  return { data, body: parts.body };
}
