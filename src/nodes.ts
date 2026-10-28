// Step ids shared by the flowchart, the run and the run page. No imports.

import type { Hook } from "./types.js";

/** `pre0` · `body` · `post0` — the id of one step of a run. */
export function nodeIdFor(phase: "pre" | "body" | "post", index?: number): string {
  return phase === "body" ? "body" : `${phase}${index}`;
}

/** `pre0`, `body`, `post0`…: the ids kept for the hooks and the body. Every other node is a step. */
export function isReservedNode(id: string): boolean {
  return id === "body" || /^(pre|post)\d+$/.test(id);
}

/** What a hook is called on screen: `pre[0] counts.js`, or `pre[0] prompt`. */
export function hookLabel(hook: Hook, phase: "pre" | "post", index: number): string {
  return `${phase}[${index}] ${"script" in hook ? hook.script : "prompt"}`;
}

/** The same, from an already-resolved source name — what a `hook-start` event carries. */
export function hookLabelFor(phase: "pre" | "post", index: number, source: string): string {
  return `${phase}[${index}] ${source}`;
}
