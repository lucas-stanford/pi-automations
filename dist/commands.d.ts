import { type RunView } from "./ui/run-view.js";
import { type FlowSvgFor } from "./report.js";
import { localStamp } from "./ui/words.js";
import type { CheckFacts } from "./ui/check.js";
import type { WatcherFacts } from "./ui/details.js";
import type { ModelResolver, RunScript } from "./core/contracts.js";
import type { State } from "./state.js";
import type { Trust } from "./trust.js";
import type { Config, Located, RunRecord, Status } from "./types.js";
export type Sub = "list" | "run" | "running" | "arm" | "disarm" | "enable" | "disable" | "log" | "runs" | "check" | "watch" | "edit" | "report" | "watcher" | "help";
export declare const SUBS: ReadonlySet<string>;
export interface ParsedArgs {
    sub: Sub;
    name?: string;
    flags: Set<string>;
    n?: number;
    /** For `watcher start|stop|status`, and `watch pause|resume <name>`. */
    verb?: string;
    /** Anything that was not a known subcommand, flag or number. */
    unknown?: string;
}
/** `/automations run daily-briefing --json` */
export declare function parseArgs(args: string): ParsedArgs;
export type NameMatch = {
    kind: "one";
    status: Status;
} | {
    kind: "ambiguous";
    matches: Status[];
} | {
    kind: "none";
};
/** Find the automation a person meant (name, `user/` or `repository/` prefix, or key); never guess. */
export declare function resolveName(statuses: Status[], arg: string): NameMatch;
export declare function ambiguousLine(name: string, matches: Status[], home: string): string;
export declare function notFoundLine(name: string): string;
export interface CommandDeps {
    config: Config;
    stateDir: string;
    trust: Trust;
    state: State;
    /** How a listing re-checks models, or nothing when this host cannot reach them. */
    resolveModel?: ModelResolver;
    now: () => Date;
    home: string;
    host?: import("./paths.js").HostRoots;
    cwd: string;
    spawnFire: (args: string[], opts: {
        attached: boolean;
        located?: Located;
    }) => Promise<number> | number;
    /** How `watch <name>` runs a watch script once. Without one, it says it cannot. */
    runScript?: RunScript;
    platform?: NodeJS.Platform;
    width?: number;
}
export interface Refreshed {
    statuses: Status[];
    byKey: Map<string, Located>;
    projectRoots: string[];
}
export declare function refresh(deps: CommandDeps): Promise<Refreshed>;
export interface HandlerResult {
    lines: string[];
    /** Non-zero for the CLI. 0 = ok, 2 = refused, 10 = skipped, 20 = failed. */
    exitCode?: number;
    /** Set when the caller should ask the person to confirm arming. */
    consent?: {
        status: Status;
        located: Located;
        preview: string[];
        andRun: boolean;
    };
}
/** Stop the exact run the person selected. Writing the request is all this does. */
export declare function handleStop(deps: Pick<CommandDeps, "stateDir">, target: Pick<RunView, "key" | "name" | "runId">): HandlerResult;
export declare function handleList(deps: CommandDeps, r: Refreshed): Promise<HandlerResult>;
/** Every run in flight, from the locks, with liveness checked here. */
export declare function runningViews(deps: CommandDeps, r: Refreshed): RunView[];
export declare function handleRunning(deps: CommandDeps, r: Refreshed): Promise<HandlerResult>;
/** How the HTML report gets a flowchart: fm when available, else the step list. */
export declare function reportFlowArt(deps: CommandDeps): FlowSvgFor | undefined;
/** The consent preview: everything the person is agreeing to, scripts first. */
export declare function consentPreview(s: Status, l: Located, deps: CommandDeps, title?: string): string[];
export declare function handleArm(deps: CommandDeps, r: Refreshed, name: string | undefined, andRun?: boolean): Promise<HandlerResult>;
/** Called once the person has accepted the preview. */
export declare function applyArm(deps: CommandDeps, l: Located): string[];
export declare function handleDisarm(deps: CommandDeps, r: Refreshed, name: string | undefined): Promise<HandlerResult>;
export declare function handleEnable(deps: CommandDeps, r: Refreshed, name: string | undefined, enabled: boolean): Promise<HandlerResult>;
export declare function handleLog(deps: CommandDeps, r: Refreshed, name: string | undefined, n?: number, json?: boolean): Promise<HandlerResult>;
/** What a run published: its message, then each note, each with its links in full. URLs are never cut. */
export declare function noteLogLines(rec: RunRecord, width: number): string[];
export { localStamp };
/** An automation's last `n` runs, oldest first, each with what a provider reported about it. */
export declare function logRuns(deps: Pick<CommandDeps, "stateDir">, key: string, n?: number): {
    record: RunRecord;
    problems: string[];
}[];
/** Everything the check page shows about one automation, gathered once. */
export declare function checkFacts(deps: CommandDeps, r: Refreshed, s: Status, watcher?: WatcherFacts): CheckFacts;
export declare function logLine(rec: RunRecord): string;
export declare function handleCheck(deps: CommandDeps, r: Refreshed, name: string | undefined): Promise<HandlerResult>;
/** `watch`: list watches, dry-run one, or pause/resume its checks. */
export declare function handleWatch(deps: CommandDeps, r: Refreshed, name: string | undefined, verb?: string): Promise<HandlerResult>;
export declare function handleRun(deps: CommandDeps, r: Refreshed, name: string | undefined, 
/** `flow: true` tracks this run on a flowchart even if the automation would not normally be. */
opts?: {
    flow?: boolean;
}): Promise<HandlerResult>;
export declare function handleReport(deps: CommandDeps, r: Refreshed, open: boolean): Promise<HandlerResult>;
/** The command list, including what `e` does here and every plugin action. */
export declare function helpLines(plugins?: {
    edit?: string;
    actions?: readonly {
        id: string;
        label: string;
    }[];
}): string[];
