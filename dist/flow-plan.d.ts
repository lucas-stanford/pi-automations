import type { Automation } from "./types.js";
/**
 * The first Mermaid flowchart in `AUTOMATION.md`, else `flow.mmd`, else undefined (not tracked).
 */
export declare function readFlowPlan(dir: string): string | undefined;
/** Quote a Mermaid label: generated labels contain `[` and `]`. */
export declare function mermaidLabel(text: string): string;
/** The flowchart for an automation without one: its hooks and body in order. */
export declare function planFromAutomation(a: Automation): string;
/** Every state a node on a chart can be in. */
export type FlowNodeStatus = "pending" | "active" | "waiting" | "done" | "failed" | "skipped" | "interrupted" | "unknown";
/** One character per state, matching fm's own text output. */
export declare const FLOW_GLYPH: Record<FlowNodeStatus, string>;
