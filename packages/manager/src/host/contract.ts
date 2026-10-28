/**
 * The HTTP contract between the manager's server (`server/`) and the browser app (`src/`). Types and
 * constants only, so both builds compile it unchanged.
 *
 *   GET  /api/session                               SessionInfo
 *   GET  /api/models                                ModelList
 *   POST /api/models/refresh                        {}               → ModelList (reads pi's models again)
 *   GET  /api/automations                           AutomationIndex
 *   GET  /api/automations/:id                       AutomationBundle
 *   POST /api/automations/:id/compose               ComposeRequest   → ComposeResult (dry run)
 *   PUT  /api/automations/:id                       SaveRequest      → AutomationBundle
 *   GET  /api/automations/:id/files?path=<dir>      FileListing      ('' is the automation folder)
 *   GET  /api/automations/:id/file?path=<file>      FileContent
 *   PUT  /api/automations/:id/file?path=<file>      FileWriteRequest → FileWriteResult
 *   GET  /api/automations/:id/runs/:run/progress    LiveProgress     (404 once the run has ended)
 *   GET  /api/history                               HistoryPage      (every automation's runs, newest first;
 *                                                                     ?automation=<id>&outcome=<o>&message=1&limit=<n>)
 *   GET  anything else                              the web app (SPA fallback)
 *
 * Every non-2xx body is an `ErrorBody`. POST and PUT must send the session's token in `TOKEN_HEADER`;
 * the server's other request checks are described in the README.
 */

export const MANAGER_KIND = "automation-manager";
export const API_VERSION = 2;

/** Sent on every POST and PUT. Lowercase because that is how node exposes request headers. */
export const TOKEN_HEADER = "x-manager-token";

/** The largest file read or written as text. */
export const MAX_FILE_BYTES = 1_048_576;
/** The largest request body. A 1 MiB file can more than double once it is escaped into JSON. */
export const MAX_REQUEST_BYTES = 4_194_304;

export type EditorTab = "flow" | "instructions" | "files" | "runs" | "source";

// shared shapes

export type Scope = "user" | "repository";
export type AutomationState = "armed" | "off" | "disabled" | "invalid";
export type Outcome = "ok" | "skipped" | "failed" | "missed" | "aborted";
export type Trigger = "schedule" | "manual" | "watch";

/** `"sha256:<hex>"` of the exact bytes on disk. */
export type Revision = string;

export interface Problem {
  /** `AUTOMATION.md`, `flow.mmd`, or a path relative to the automation folder. */
  file: string;
  /** For AUTOMATION.md: the field path the parser names, e.g. `on.schedule.cron`. */
  field?: string;
  /** 1-based, when known. */
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
  /** The parser's own one-line wording — `<field>: <what is wrong> — <what fixes it>` — never paraphrased. */
  message: string;
}

export interface Notice {
  tone: "info" | "warning";
  message: string;
}

export type Hook = { script: string } | { prompt: string };

export interface ScheduleFields {
  cron: string;
  /** IANA zone. Absent means host-local. */
  timezone?: string;
  catchUp: "skip" | "once";
}

/**
 * `on.watch`: a script pi-automations runs every `every`, without a model. A run starts when the
 * script exits 0 having found something new.
 */
export interface WatchFields {
  /** Relative to the automation folder, like a hook script. */
  script: string;
  /** A duration from `1m` to `24h`. */
  every: string;
}

/** The last check of a watch, as the tick recorded it. */
export interface WatchCheckInfo {
  /** ISO; when the check finished. */
  checkedAt: string;
  /** The script's exit code; absent when it never exited, and then `problem` says why. */
  exit?: number;
  problem?: string;
  durationMs: number;
  /** One line of what it printed. */
  said?: string;
  /** ISO; when a check last started a run. */
  firedAt?: string;
}

/**
 * The Draft 0.2 fields the editor changes, plus the body. A save keeps `flow` as the file has it.
 *
 * `name` is read-only in the editor: it must equal the folder name, and renaming a folder is not
 * something a save does.
 */
export interface AutomationFields {
  name: string;
  description: string;
  enabled: boolean;
  /** `<provider>/<id>[:<thinking>]`. Absent means the host's default model. */
  model?: string;
  /** A single duration: `90s`, `10m`, `1h`. Absent means the host default. */
  timeout?: string;
  on: { manual: boolean; schedule?: ScheduleFields; watch?: WatchFields };
  hooks: { pre: Hook[]; post: Hook[] };
  /** The Markdown body — the prompt for each run — trimmed, exactly as the parser reads it. */
  body: string;
}

export interface Revisioned {
  text: string;
  revision: Revision;
  bytes: number;
  /** ISO, or null when the file system would not say. */
  updatedAt: string | null;
}

// GET /api/session

export interface SessionInfo {
  kind: typeof MANAGER_KIND;
  apiVersion: typeof API_VERSION;
  /** pi-automations' own version. */
  version: string;
  /** The capability for POST and PUT. Send it as `TOKEN_HEADER`. Never log it. */
  token: string;
  /** The pi-automations state directory, tildified, for display only. */
  stateDir: string;
  /** The Model field's suggestions, with names. Read again with `POST /api/models/refresh`. */
  modelList: ModelList;
  limits: { maxFileBytes: number; maxRequestBytes: number };
}

// GET /api/models

/**
 * One suggestion for the Model field.
 *
 * Suggestions come in the order of `source`: the models enabled in pi's settings (what pi's own
 * `/scoped-models` shows), then models automations already name, then every other model pi can run.
 */
export interface ModelOption {
  /** `<provider>/<id>[:<thinking>]` — exactly what `model:` takes. */
  value: string;
  /** pi's display name for the model, when pi's catalog has one. */
  name?: string;
  source: "enabled" | "automation" | "available";
}

export interface ModelList {
  models: ModelOption[];
  /** When pi's models were last read, ISO. Null until a read succeeds. */
  readAt: string | null;
  /** Why the last read failed. The list then keeps what the previous read found. */
  error?: string;
}

// GET /api/automations

export interface AutomationSummary {
  /** Opaque and URL-safe: `<name>.<8 hex>`. Stable for as long as the key is. */
  id: string;
  /** The automation key: `<scope>:<root path>:<name>`. */
  key: string;
  name: string;
  scope: Scope;
  /** `~/.agents/automations`, or `<repo>/.agents/automations`, tildified. */
  rootLabel: string;
  /** The automation folder, tildified. */
  dir: string;
  state: AutomationState;
  /** Why it is off or invalid, in pi-automations' words. */
  reason?: string;
  description?: string;
  /** Null when AUTOMATION.md does not parse. */
  triggers: { manual: boolean; schedule?: ScheduleFields; watch?: WatchFields } | null;
  /** ISO with offset; armed automations with a schedule only. */
  nextFire?: string;
  /** ISO; when the tick will next run the watch script. Armed automations with a watch only. */
  nextCheck?: string;
  /** The watch script's last check, when it has run. */
  lastCheck?: WatchCheckInfo;
  running?: { runId: string; pid: number; startedAt: string };
  /** On a flowchart (`⋔`): has its own chart, or is named in `config.flowTracking`. */
  tracked: boolean;
  /** Has its own chart: a ```mermaid flowchart in AUTOMATION.md, or an older flow.mmd beside it. */
  hasFlowFile: boolean;
  last?: { outcome: Outcome; at: string; reason?: string; durationMs?: number };
  /** Up to seven, oldest first — enough for a sparkline. */
  recent: Outcome[];
  /** False only when the folder cannot be written at all. */
  editable: boolean;
}

export interface AutomationGroup {
  /** Stable for the life of the root. */
  id: string;
  scope: Scope;
  /** `USER · ~/.agents/automations`, `REPOSITORY · ~/src/app/.agents/automations`. */
  title: string;
  rootLabel: string;
  automations: AutomationSummary[];
}

export interface AutomationIndex {
  groups: AutomationGroup[];
  /** ISO. */
  generatedAt: string;
}

// GET /api/automations/:id

export interface HookRun {
  phase: "pre" | "post";
  index: number;
  kind: "script" | "prompt";
  source: string;
  status: "ok" | "skipped" | "failed";
  exit?: number;
  durationMs: number;
  reason?: string;
}

export interface RunSummary {
  id: string;
  trigger: Trigger;
  outcome: Outcome;
  reason?: string;
  error?: { kind: string; message: string };
  scheduledFor?: string;
  startedAt?: string;
  endedAt?: string;
  recordedAt: string;
  durationMs?: number;
  model?: string;
  /** One line describing what the run produced, or why it produced nothing. */
  summary: string;
  /** What the run produced, clipped as the record clips it. */
  output?: { text: string; truncated: boolean };
  hooks: HookRun[];
  /** The Mermaid flowchart the run was drawn on. Absent for a run without one. */
  chart?: string;
  /** Every node of `chart`, in chart order, with where it got to. */
  steps?: RunStep[];
  /** The edges the run actually took, `[from, to]`. */
  taken?: [string, string][];
  /** What the run published and where (`pa note "…" --link "label=https://…"`), oldest first. */
  notes?: RunNote[];
  /** The run's one message for its reader (`pa message "…" --link "label=https://…"`). */
  message?: RunMessage;
  /** Why the run's steps could not be recorded. */
  flow?: { problem?: string };
  /** Plugins that failed while observing this run. They never changed it. */
  pluginProblems?: string[];
}

export type StepStatus = "pending" | "active" | "waiting" | "done" | "failed" | "skipped" | "interrupted";

export interface RunStep {
  id: string;
  label: string;
  status: StepStatus;
  /** The last message attached to the node. */
  text?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface RunLink {
  label?: string;
  /** Always http or https. */
  url: string;
}

export interface RunNote {
  /** ISO. */
  ts: string;
  /** Markdown. */
  text: string;
  links: RunLink[];
}

/** A run's message to its reader. Shaped like a note; a run keeps only its last one. */
export type RunMessage = RunNote;

/** Where a running run is now: what the record will keep once it ends. */
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

export interface FlowInfo {
  /**
   * Where the run's chart comes from. `automation`: the first ```mermaid flowchart in
   * AUTOMATION.md's body · `file`: a flow.mmd beside it, the older layout (ignored when
   * AUTOMATION.md has a chart) · `config`: tracked by config with the generated chart · `none`.
   */
  source: "automation" | "file" | "config" | "none";
  /** The automation's own chart as written, from AUTOMATION.md or flow.mmd. Null when it has none. */
  text: string | null;
  /** The chart pi-automations generates from the CURRENT fields when there is no chart of its own. Null if invalid. */
  generated: string | null;
  /** The reserved node ids pi-automations moves, in run order: `pre0…`, `body`, `post0…`. A chart needs all of them. */
  driven: string[];
}

export interface AutomationBundle {
  summary: AutomationSummary;
  /** Null when AUTOMATION.md does not parse; `problems` says why and `files.automation` has the text. */
  fields: AutomationFields | null;
  files: {
    automation: Revisioned;
    /** flow.mmd, when one exists. The chart itself, wherever it lives, is `flow.text`. */
    flow: Revisioned | null;
  };
  flow: FlowInfo;
  problems: Problem[];
  /** Up to three ISO instants. Empty without a schedule. */
  nextFires: string[];
  /** Newest first, up to twenty. */
  runs: RunSummary[];
  /** E.g. repository scope: "saving returns this automation to off until you arm it again". */
  notices: Notice[];
}

// GET /api/history

/** How many runs History answers by default, and at most. */
export const HISTORY_LIMIT = 200;
export const HISTORY_MAX = 500;

/** One run in History: the run, and the automation it belongs to. */
export interface HistoryRun extends RunSummary {
  automation: { id: string; name: string };
}

export interface HistoryPage {
  /** Newest first. */
  runs: HistoryRun[];
  limit: number;
  /** More runs matched than `limit`. */
  more: boolean;
}

// compose and save

/**
 * An edit to an automation. Everything is optional; what is absent is left exactly as it is.
 *
 * `fields` and `automationText` are two ways to say the same thing and are mutually exclusive:
 * `fields` is written INTO the existing YAML (comments, key order and quoting survive), while
 * `automationText` replaces the file verbatim.
 */
export interface MonitorDraft {
  fields?: AutomationFields;
  automationText?: string;
  /**
   * The new chart. The save writes it into AUTOMATION.md as a ```mermaid block — replacing the
   * chart there, or adding one after the title — and deletes an older flow.mmd, so the chart ends
   * up in one place. `null` removes the chart (the block, and any flow.mmd). An empty string is
   * refused — use null.
   */
  flowText?: string | null;
}

export type ComposeRequest = MonitorDraft;

export interface ComposeResult {
  /** Exactly what a save would write to AUTOMATION.md, the chart included. */
  automationText: string;
  /** The run's chart after a save, wherever it lives; null when the automation would have none. */
  flowText: string | null;
  /** flow.mmd after a save: its text when it stays, null when it would not exist. */
  flowFileText: string | null;
  /** `automationText` parsed back, when it parses. */
  fields: AutomationFields | null;
  /** AUTOMATION.md parses under Draft 0.2. */
  valid: boolean;
  problems: Problem[];
  nextFires: string[];
  /** The generated chart for the composed fields, for an automation without a chart of its own. */
  generatedFlow: string | null;
  driven: string[];
  /** `flow`: flow.mmd would be deleted (folded into AUTOMATION.md, or removed with the chart). */
  changed: { automation: boolean; flow: boolean };
}

export interface SaveRequest extends MonitorDraft {
  /**
   * The revisions this edit started from: AUTOMATION.md's, and flow.mmd's or null when there is
   * none. If either has moved on disk, nothing is written: 409.
   */
  base: { automation: Revision; flow: Revision | null };
  /** Write an AUTOMATION.md that does not parse. Without this an invalid draft is 422. */
  allowInvalid?: boolean;
}

// files

export type FileLanguage =
  | "markdown"
  | "mermaid"
  | "javascript"
  | "typescript"
  | "json"
  | "yaml"
  | "toml"
  | "shell"
  | "powershell"
  | "python"
  | "text";

export interface FileEntry {
  name: string;
  /** Relative to the automation folder, `/`-separated. */
  path: string;
  kind: "file" | "dir";
  /** 0 for a directory. */
  bytes: number;
  updatedAt: string | null;
  /** What this file is to the automation, when it is something. `hook-script`: a hook's or the watch's script. */
  role?: "automation" | "flow" | "hook-script";
}

export interface FileListing {
  /** '' is the automation folder. */
  path: string;
  /** Directories first, then files; each alphabetical, case-insensitively. */
  entries: FileEntry[];
  /** What was deliberately left out, and why: a skipped folder, a symbolic link, the entry cap. */
  skipped: Array<{ name: string; reason: string }>;
}

export interface FileContent {
  path: string;
  /** Strict UTF-8, without a byte-order mark. `bom` says whether the file had one. */
  text: string;
  bom: boolean;
  revision: Revision;
  bytes: number;
  updatedAt: string | null;
  language: FileLanguage;
  role?: "automation" | "flow" | "hook-script";
}

/**
 * Write one file. `AUTOMATION.md` and `flow.mmd` at the folder root are refused here with
 * `use-monitor`: they go through `PUT /api/automations/:id`, which validates them.
 */
export interface FileWriteRequest {
  text: string;
  /** The revision this edit started from, or null to create a file that must not exist yet. */
  base: Revision | null;
  /** Re-add a byte-order mark. Defaults to whatever the file had. */
  bom?: boolean;
}

export interface FileWriteResult {
  file: FileContent;
  /** The automation after the write — a hook script edit can change its state. */
  summary: AutomationSummary;
}

// errors

export type ErrorCode =
  | "bad-request"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "invalid"
  | "too-large"
  | "unsupported"
  | "use-monitor"
  | "internal";

export interface ErrorBody {
  error: string;
  code: ErrorCode;
  /** 422: why the draft is invalid. */
  problems?: Problem[];
  /** 409: what is on disk now. */
  current?: { automation?: Revision; flow?: Revision | null; file?: Revision | null };
}
