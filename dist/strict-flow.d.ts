export interface FlowProblem {
    /** 1-based line in the text the caller numbered from `firstLine`; absent for chart-wide problems. */
    line?: number;
    /** `<what is wrong> — <what fixes it>`. */
    text: string;
}
/** A label or heading as a reader sees it: entities decoded, no markup, no quotes, single spaces. */
export declare function plainText(text: string): string;
/**
 * Check a body against its flowchart. `firstLine` is the number of the body's first line in the
 * file, so problems point at the file. Returns every problem, in a stable order.
 */
export declare function checkStrictFlow(body: string, firstLine?: number): FlowProblem[];
/** One problem as a line: `line 12: <what> — <fix>`. */
export declare function flowProblemLine(p: FlowProblem): string;
