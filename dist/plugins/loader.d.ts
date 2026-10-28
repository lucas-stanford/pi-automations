import type { ActionContext, ActionResult, ChartRenderRequest, HostServices, PluginAction, PluginEventName, PluginEvents, PluginRenderer, PluginWhere } from "./types.js";
/** How long any one call into a plugin may take. */
export declare const PLUGIN_CALL_MS = 5000;
/** Verbs a plugin action may not take over: `pa run` is always this package's `run`. */
export declare const RESERVED_VERBS: ReadonlySet<string>;
export interface RegisteredAction {
    plugin: string;
    action: PluginAction;
}
/** The events a run reports to its observers. */
export type RunEventName = Exclude<PluginEventName, "shutdown">;
/** Who is told about a run; `problems` are load failures for the record. */
export interface RunObservers {
    readonly observing: boolean;
    readonly problems: readonly string[];
    emit<E extends RunEventName>(event: E, payload: PluginEvents[E]): Promise<string[]>;
}
export interface LoadedPlugins extends RunObservers {
    /** `name (entry)` of each plugin that loaded. */
    readonly loaded: readonly {
        entry: string;
        name: string;
    }[];
    /** Everything worth telling the person: load failures, refused registrations, `api.warn`. */
    readonly warnings: readonly string[];
    readonly actions: readonly RegisteredAction[];
    action(id: string): RegisteredAction | undefined;
    readonly renderer: {
        plugin: string;
        render: PluginRenderer;
    } | undefined;
    /** Run an action, bounded. A failure or a timeout is a `problem` to show, never a throw. */
    runAction(id: string, ctx: ActionContext): Promise<{
        result?: ActionResult;
        problem?: string;
    }>;
    /** Tell every plugin the process is letting it go. Bounded. */
    shutdown(): Promise<void>;
}
export interface LoadPluginsOptions {
    entries: readonly string[];
    where: PluginWhere;
    /** Built on first use, so a plugin that never asks costs nothing. */
    host: () => HostServices;
    timeoutMs?: number;
    home?: string;
    /** Where `manager` and any other bundled name resolve. Defaults to this package. */
    packageRoot?: string;
}
/** The module file a `plugins` entry names. */
export declare function resolvePluginEntry(entry: string, opts?: {
    home?: string;
    packageRoot?: string;
}): string;
/** `p`, or a rejection once `ms` have passed. The timer never holds the process open. */
export declare function bounded<T>(p: Promise<T> | T, ms: number, what: string): Promise<T>;
export declare function loadPlugins(opts: LoadPluginsOptions): Promise<LoadedPlugins>;
/** The plugin renderer's chart, or undefined for fm. A slow renderer is dropped for the process. */
export declare function pluginChartRenderer(current: () => LoadedPlugins["renderer"], onProblem: (message: string) => void, ms?: number): (args: {
    plan: string;
    state: ChartRenderRequest["state"];
    format: "text" | "svg";
}) => {
    text: string;
} | undefined;
/** No plugins: what every caller gets when `plugins` is not set. */
export declare const NO_PLUGINS: LoadedPlugins;
