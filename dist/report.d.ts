import type { Config, RunRecord, Status } from "./types.js";
/**
 * How the report gets a flowchart: SVG, a step list, or nothing. Injected, so this never spawns.
 */
export type FlowSvgFor = (record: RunRecord) => {
    svg?: string;
    md?: string;
} | undefined;
export declare function renderReport(statuses: Status[], recordsByKey: Record<string, RunRecord[]>, config: Config, now: Date, opts: {
    home: string;
    projectRoots?: string[];
    flowSvgFor?: FlowSvgFor;
}): string;
/** The command that opens a file. Not `cmd /c start`, which would interpret `&` in a path. */
export declare function openCommand(file: string, platform?: NodeJS.Platform): {
    file: string;
    args: string[];
};
