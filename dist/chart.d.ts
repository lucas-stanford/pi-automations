export interface ChartNode {
    id: string;
    label: string;
}
export interface ChartEdge {
    from: string;
    to: string;
    label?: string;
}
export interface Chart {
    nodes: ChartNode[];
    edges: ChartEdge[];
    /** Ids of `subgraph id [...]` groups. An arrow to one makes it a node too; it is not a step. */
    subgraphs?: string[];
}
/** Read a flowchart's nodes, in order of first appearance, and its arrows. */
export declare function parseChart(text: string): Chart;
/** The ids reachable in one step from `id`, in chart order and without repeats. */
export declare function successorsOf(chart: Chart, id: string): string[];
/** Each node's strongly connected component: nodes on a loop together share one. Tarjan's. */
export declare function components(ids: string[], edges: [string, string][]): Map<string, number>;
/**
 * The nodes in the order a run goes through them: each after every node with an arrow into it.
 * A loop's nodes stay together, in chart order; ties keep chart order. A shortcut such as
 * `body --> post` therefore no longer pulls `post` ahead of the steps on the longer path.
 */
export declare function flowOrder(chart: Chart): ChartNode[];
