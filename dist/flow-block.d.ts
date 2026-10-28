export interface FlowBlock {
    text: string;
    start: number;
    end: number;
}
/** Find the first ```mermaid flowchart/graph block in an AUTOMATION.md body. */
export declare function findFlowBlock(markdown: string): FlowBlock | null;
export declare function setFlowBlock(markdown: string, chart: string | null): string;
