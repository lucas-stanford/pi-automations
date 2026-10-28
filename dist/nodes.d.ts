import type { Hook } from "./types.js";
/** `pre0` · `body` · `post0` — the id of one step of a run. */
export declare function nodeIdFor(phase: "pre" | "body" | "post", index?: number): string;
/** `pre0`, `body`, `post0`…: the ids kept for the hooks and the body. Every other node is a step. */
export declare function isReservedNode(id: string): boolean;
/** What a hook is called on screen: `pre[0] counts.js`, or `pre[0] prompt`. */
export declare function hookLabel(hook: Hook, phase: "pre" | "post", index: number): string;
/** The same, from an already-resolved source name — what a `hook-start` event carries. */
export declare function hookLabelFor(phase: "pre" | "post", index: number, source: string): string;
