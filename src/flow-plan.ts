/** The chart a run is tracked on and the glyphs for its node states. Portable. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { findFlowBlock } from "./flow-block.js";
import { hookLabel, nodeIdFor } from "./nodes.js";
import type { Automation } from "./types.js";

/**
 * The first Mermaid flowchart in `AUTOMATION.md`, else `flow.mmd`, else undefined (not tracked).
 */
export function readFlowPlan(dir: string): string | undefined {
  try {
    const block = findFlowBlock(readFileSync(path.join(dir, "AUTOMATION.md"), "utf8"));
    if (block && block.text.trim() !== "") return block.text;
  } catch {
    // Fall through to the legacy file.
  }
  const file = path.join(dir, "flow.mmd");
  try {
    const text = readFileSync(file, "utf8");
    return text.trim() === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Quote a Mermaid label: generated labels contain `[` and `]`. */
export function mermaidLabel(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}

/** The flowchart for an automation without one: its hooks and body in order. */
export function planFromAutomation(a: Automation): string {
  const lines = ["flowchart TD"];
  const ids: string[] = [];

  a.hooks.pre.forEach((hook, i) => {
    const id = nodeIdFor("pre", i);
    ids.push(id);
    lines.push(`  ${id}[${mermaidLabel(hookLabel(hook, "pre", i))}]`);
  });

  ids.push("body");
  lines.push(`  body[${mermaidLabel(`body: ${a.name}`)}]`);

  a.hooks.post.forEach((hook, i) => {
    const id = nodeIdFor("post", i);
    ids.push(id);
    lines.push(`  ${id}[${mermaidLabel(hookLabel(hook, "post", i))}]`);
  });

  for (let i = 0; i < ids.length - 1; i++) {
    lines.push(`  ${ids[i]} --> ${ids[i + 1]}`);
  }

  return `${lines.join("\n")}\n`;
}

/** Every state a node on a chart can be in. */
export type FlowNodeStatus =
  | "pending"
  | "active"
  | "waiting"
  | "done"
  | "failed"
  | "skipped"
  | "interrupted"
  | "unknown";

/** One character per state, matching fm's own text output. */
export const FLOW_GLYPH: Record<FlowNodeStatus, string> = {
  done: "✓",
  active: "▶",
  waiting: "⏸",
  failed: "✗",
  skipped: "↷",
  interrupted: "‼",
  unknown: "?",
  pending: "·",
};