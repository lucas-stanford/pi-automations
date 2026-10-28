import type { ChartRenderState, RenderChart } from "../../core/contracts.js";
/** Does this binary draw charts? An older fm has no `render`, and `fm` on PATH may be unrelated. */
export declare function canRender(bin: string): boolean;
/**
 * The fm to use: `fmPath`, `FM_BIN`, then PATH; probed once per process. `fmPath` never falls back.
 */
export declare function findFmRenderer(explicit?: string, opts?: {
    cache?: boolean;
}): string | undefined;
/** Forget what was probed. Tests use this. */
export declare function resetFmRendererCache(): void;
/** Draw one chart with one fm. */
export declare function fmRender(bin: string, args: {
    plan: string;
    state: ChartRenderState;
    format: "text" | "svg";
    timeoutMs?: number;
}): {
    text: string;
} | {
    problem: string;
};
/** A `RenderChart` bound to whichever fm `find` answers with, asked on every call. */
export declare function fmRenderer(find: () => string | undefined): RenderChart;
