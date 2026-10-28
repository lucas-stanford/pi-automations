/**
 * The plugin API, version 1 (types only). A plugin is a module named in the person's own
 * `config.json` (`"plugins": [...]`), never in a repository. It default-exports `{ name, setup(api)
 * }` (or just `setup`), called once per process that loads it (`host`, `worker` or `cli`). Every
 * call into a plugin is bounded; a plugin that throws or hangs is reported and otherwise ignored.
 * Import these types with `import type` only.
 */
import type { Hook, HookResult, Outcome, RunLink, RunMessage, RunNote, RunRecord, RunStep, Scope, Trigger } from "../types.js";
export type { Hook, HookResult, Outcome, RunLink, RunMessage, RunNote, RunRecord, RunStep, Scope, Trigger };
/** Which process loaded the plugin. A plugin that only edits does nothing in a `worker`. */
export type PluginWhere = "host" | "worker" | "cli";
/** The run an event is about. */
export interface PluginRun {
    runId: string;
    /** pi-automations' identity for the automation: `<scope>:<root path>:<name>`. */
    key: string;
    name: string;
    scope: Scope;
    trigger: Trigger;
}
export interface RunStartEvent {
    run: PluginRun;
    startedAt: string;
}
/** A node of the run's chart moved, or its message changed. `step` is the node as it is now. */
export interface StepEvent {
    run: PluginRun;
    step: RunStep;
}
/** The run left a note (`pa note "…" --link "label=https://…"`). */
export interface NoteEvent {
    run: PluginRun;
    note: RunNote;
}
/** The run left its message for the reader (`pa message`), or replaced it. Observe only. */
export interface RunMessageEvent {
    run: PluginRun;
    message: RunMessage;
}
/** The run's record has been written; this is it. */
export interface RunEndEvent {
    run: PluginRun;
    record: RunRecord;
}
export interface PluginEvents {
    "run-start": RunStartEvent;
    step: StepEvent;
    note: NoteEvent;
    message: RunMessageEvent;
    "run-end": RunEndEvent;
    /** The loading process is letting the plugin go (pi's session ended). Stop servers, timers. */
    shutdown: undefined;
}
export type PluginEventName = keyof PluginEvents;
/** The automation an action was chosen for. */
export interface ActionTarget {
    key: string;
    name: string;
    scope: Scope;
    dir: string;
    file: string;
}
export interface ActionContext {
    /** Absent only for `pa <action>` given no name. */
    automation?: ActionTarget;
    where: PluginWhere;
    /** False for `pa <action> --no-open`: do the work, but do not open a browser or a window. */
    open: boolean;
}
export interface ActionResult {
    /** One line for the person: shown as a notice in pi and printed by `pa`. */
    message?: string;
    /** Where the action can be seen, when it is somewhere. */
    url?: string;
    /**
     * The action keeps serving after it returns (a local server). `pa` stays in the foreground until
     * Ctrl+C; inside pi it lives as long as pi does.
     */
    keepAlive?: boolean;
}
export interface PluginAction {
    /** `[a-z][a-z0-9-]*`. Also the `pa` verb. `edit` replaces the built-in editor fallback. */
    id: string;
    /** For the `/automations` menu: `Open the dashboard`. */
    label: string;
    /** One sentence: what choosing it will do. */
    description?: string;
    /** A single key for the list. Ignored when a built-in action already uses it. */
    key?: string;
    run(ctx: ActionContext): ActionResult | void | Promise<ActionResult | void>;
}
export interface ChartRenderRequest {
    chart: string;
    /** Each node's status (`pending`, `active`, `done`, …) and the arrows the run took. */
    state: {
        nodes: Readonly<Record<string, string>>;
        taken: readonly (readonly [string, string])[];
    };
    format: "text" | "svg";
    /**
     * How long the host will wait. Rendering is synchronous; a renderer that is slower is dropped.
     */
    timeoutMs: number;
}
/** Draws a chart. `problem` (or a throw) makes the host fall back to fm, then to the step list. */
export type PluginRenderer = (request: ChartRenderRequest) => {
    text: string;
} | {
    problem: string;
};
export interface PluginApi {
    readonly apiVersion: 1;
    readonly where: PluginWhere;
    /** The entry in config.json this plugin was loaded from. */
    readonly entry: string;
    readonly host: HostServices;
    on<E extends PluginEventName>(event: E, handler: (event: PluginEvents[E]) => void | Promise<void>): void;
    addAction(action: PluginAction): void;
    setRenderer(render: PluginRenderer): void;
    /** Report something worth a person's attention, the way a load failure is reported. */
    warn(message: string): void;
}
export interface PiAutomationsPlugin {
    name: string;
    setup(api: PluginApi): void | Promise<void>;
}
/** What a plugin module default-exports. */
export type PluginExport = PiAutomationsPlugin | ((api: PluginApi) => void | Promise<void>);
/** `"sha256:<hex>"` of the exact bytes on disk. */
export type Revision = string;
export type AutomationState = "armed" | "off" | "disabled" | "invalid";
export interface Problem {
    /** `AUTOMATION.md`, `flow.mmd`, or a path relative to the automation folder. */
    file: string;
    /** For AUTOMATION.md: the field path pi names, e.g. `on.schedule.cron`. */
    field?: string;
    line?: number;
    column?: number;
    severity: "error" | "warning" | "info";
    /** pi's own one-line wording, never paraphrased. */
    message: string;
}
export interface Notice {
    tone: "info" | "warning";
    message: string;
}
export interface ScheduleFields {
    cron: string;
    timezone?: string;
    catchUp: "skip" | "once";
}
export interface WatchFields {
    script: string;
    every: string;
}
export interface WatchCheckInfo {
    checkedAt: string;
    exit?: number;
    problem?: string;
    durationMs: number;
    said?: string;
    firedAt?: string;
}
/** The Draft 0.2 fields an editor changes, plus the body. `flow` is kept as written in the file. */
export interface AutomationFields {
    name: string;
    description: string;
    enabled: boolean;
    model?: string;
    timeout?: string;
    on: {
        manual: boolean;
        schedule?: ScheduleFields;
        watch?: WatchFields;
    };
    hooks: {
        pre: Hook[];
        post: Hook[];
    };
    body: string;
}
export interface Revisioned {
    text: string;
    revision: Revision;
    bytes: number;
    updatedAt: string | null;
}
export interface AutomationSummary {
    key: string;
    name: string;
    scope: Scope;
    rootLabel: string;
    dir: string;
    state: AutomationState;
    reason?: string;
    description?: string;
    triggers: {
        manual: boolean;
        schedule?: ScheduleFields;
        watch?: WatchFields;
    } | null;
    nextFire?: string;
    nextCheck?: string;
    lastCheck?: WatchCheckInfo;
    running?: {
        runId: string;
        pid: number;
        startedAt: string;
    };
    /** Has a chart its runs are drawn on: its own, or one config asks pi to generate. */
    tracked: boolean;
    /** Has its own chart: a ```mermaid flowchart in AUTOMATION.md, or an older flow.mmd beside it. */
    hasFlowFile: boolean;
    last?: {
        outcome: Outcome;
        at: string;
        reason?: string;
        durationMs?: number;
    };
    /** Up to seven, oldest first. */
    recent: Outcome[];
    editable: boolean;
}
export interface AutomationGroup {
    id: string;
    scope: Scope;
    title: string;
    rootLabel: string;
    automations: AutomationSummary[];
}
export interface AutomationIndex {
    groups: AutomationGroup[];
    generatedAt: string;
}
/** One run, as a reader shows it. */
export interface RunSummary {
    id: string;
    trigger: Trigger;
    outcome: Outcome;
    reason?: string;
    error?: {
        kind: string;
        message: string;
    };
    scheduledFor?: string;
    startedAt?: string;
    endedAt?: string;
    recordedAt: string;
    durationMs?: number;
    model?: string;
    /** One line: what the run produced, or why it produced nothing. */
    summary: string;
    output?: {
        text: string;
        truncated: boolean;
    };
    hooks: HookResult[];
    /** The flowchart the run was tracked on, where each node got to, and the arrows it took. */
    chart?: string;
    steps?: RunStep[];
    taken?: [string, string][];
    notes?: RunNote[];
    /** The run's one message for its reader (`pa message`). */
    message?: RunMessage;
    /** Why its steps could not be recorded. */
    flow?: {
        problem?: string;
    };
    /** Optional integrations (plugins) that went wrong without changing the run. */
    pluginProblems?: string[];
}
/** One run in the history across every automation: the run, and whose it is. */
export interface HistoryRun extends RunSummary {
    key: string;
    name: string;
}
export interface HistoryQuery {
    /** Only this automation's runs. */
    key?: string;
    outcome?: Outcome;
    /** Only runs that left a message or notes. */
    withMessage?: boolean;
    /** At most this many; the host caps it. */
    limit?: number;
}
export interface FlowInfo {
    source: "automation" | "file" | "config" | "none";
    text: string | null;
    generated: string | null;
    driven: string[];
}
export interface AutomationBundle {
    summary: AutomationSummary;
    fields: AutomationFields | null;
    files: {
        automation: Revisioned;
        flow: Revisioned | null;
    };
    flow: FlowInfo;
    problems: Problem[];
    nextFires: string[];
    /** Newest first, up to twenty. */
    runs: RunSummary[];
    notices: Notice[];
}
/**
 * An edit. `fields` and `automationText` are mutually exclusive; `flowText: null` removes the
 * chart.
 */
export interface AutomationDraft {
    fields?: AutomationFields;
    automationText?: string;
    flowText?: string | null;
}
export interface ComposeResult {
    automationText: string;
    flowText: string | null;
    flowFileText: string | null;
    fields: AutomationFields | null;
    valid: boolean;
    problems: Problem[];
    nextFires: string[];
    generatedFlow: string | null;
    driven: string[];
    changed: {
        automation: boolean;
        flow: boolean;
    };
}
export interface SaveRequest extends AutomationDraft {
    /**
     * The revisions the edit started from. If either has moved on disk nothing is written
     * (`conflict`).
     */
    base: {
        automation: Revision;
        flow: Revision | null;
    };
    allowInvalid?: boolean;
}
export type FileLanguage = "markdown" | "mermaid" | "javascript" | "typescript" | "json" | "yaml" | "toml" | "shell" | "powershell" | "python" | "text";
export interface FileEntry {
    name: string;
    path: string;
    kind: "file" | "dir";
    bytes: number;
    updatedAt: string | null;
    role?: "automation" | "flow" | "hook-script";
}
export interface FileListing {
    path: string;
    entries: FileEntry[];
    skipped: Array<{
        name: string;
        reason: string;
    }>;
}
export interface FileContent {
    path: string;
    text: string;
    bom: boolean;
    revision: Revision;
    bytes: number;
    updatedAt: string | null;
    language: FileLanguage;
    role?: "automation" | "flow" | "hook-script";
}
export interface FileWriteRequest {
    text: string;
    base: Revision | null;
    bom?: boolean;
}
/** Where a running run is now. */
export interface LiveProgress {
    runId: string;
    key: string;
    name: string;
    /** Empty for a run without a chart, which keeps notes only. */
    chart: string;
    steps: RunStep[];
    taken: [string, string][];
    notes: RunNote[];
    message?: RunMessage;
    closed: boolean;
}
export interface ModelChoice {
    /** `<provider>/<id>[:<thinking>]`. */
    value: string;
    name?: string;
}
export interface ModelCatalog {
    /** The models enabled in pi's settings, resolved as pi resolves them. */
    enabled: ModelChoice[];
    /** Every model pi can run. */
    available: ModelChoice[];
    /** The models automations already name. */
    used: string[];
    /** Why pi's models could not be read; the lists are then what is known without pi. */
    error?: string;
}
export type HostErrorCode = "bad-request" | "not-found" | "conflict" | "invalid" | "too-large" | "unsupported" | "use-monitor";
/**
 * What a host service throws when it refuses. Tell it apart by `code`; the class is not importable.
 */
export interface HostError extends Error {
    code: HostErrorCode;
    problems?: Problem[];
    /** For `conflict`: what is on disk now. */
    current?: {
        automation?: Revision;
        flow?: Revision | null;
        file?: Revision | null;
    };
}
/**
 * The host's own operations. Every write is checked against what is on disk and parsed as a run
 * would.
 */
export interface HostServices {
    readonly version: string;
    /** The state directory, tildified, for display. */
    readonly stateDirLabel: string;
    readonly maxFileBytes: number;
    /** Every automation the host can see, grouped by root, in the order `/automations` shows them. */
    index(): Promise<AutomationIndex>;
    /** One automation: its files, fields, problems, next scheduled times and last twenty runs. */
    bundle(key: string): Promise<AutomationBundle>;
    /** Parse an AUTOMATION.md as pi would, without touching disk. */
    validate(text: string, name: string): {
        fields: AutomationFields | null;
        problems: Problem[];
    };
    /** What a save of this draft would write, and what is wrong with it. Writes nothing. */
    compose(key: string, draft: AutomationDraft): Promise<ComposeResult>;
    /**
     * Write a draft. Refuses with `conflict` when the files moved since `base`, `invalid` when it
     * does not parse.
     */
    save(key: string, request: SaveRequest): Promise<AutomationBundle>;
    listFiles(key: string, path: string): Promise<FileListing>;
    readFile(key: string, path: string): Promise<FileContent>;
    /**
     * Write a file in the automation folder. `AUTOMATION.md` and `flow.mmd` are `use-monitor`: use
     * `save`.
     */
    writeFile(key: string, path: string, request: FileWriteRequest): Promise<{
        file: FileContent;
        summary: AutomationSummary;
    }>;
    /** The automation's run records, newest first. */
    runs(key: string, limit?: number): Promise<RunRecord[]>;
    /** Runs across every automation the host can see, newest first, filtered, at most `limit`. */
    history(query?: HistoryQuery): Promise<HistoryRun[]>;
    /** A running run's progress, or undefined once it has ended (its record has it then). */
    progress(runId: string): LiveProgress | undefined;
    /** pi's models, read again on every call. */
    models(): Promise<ModelCatalog>;
}
