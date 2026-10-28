/**
 * Shared types. Draft 0.2's lists (fields, triggers, hook kinds, states, outcomes, error kinds) are
 * closed. `on.watch` is the one extension, in the `on:` namespace the spec reserves for it.
 */

export type Scope = "user" | "repository";

export interface Root {
  path: string;
  scope: Scope;
  /** `.agents/automations` vs `.pi/automations` (or the `~/.pi/agent/automations` one). */
  kind: "agents" | "pi";
}

export interface Schedule {
  cron: string;
  /** IANA name; undefined means host-local. */
  timezone?: string;
  catchUp: "skip" | "once";
}

export type Hook = { script: string } | { prompt: string };

/**
 * `on.watch`: a script the tick runs every `every`, without a model. A run starts when it exits 0
 * having found something new. See `src/watch.ts`.
 */
export interface Watch {
  script: string;
  /** Raw duration, between 1m and 24h. */
  every: string;
}

export interface Automation {
  name: string;
  description: string;
  enabled: boolean;
  /** Raw `<provider>/<id>[:<thinking>]`. */
  model?: string;
  /** Raw duration string. */
  timeout?: string;
  on: { schedule?: Schedule; watch?: Watch; manual: boolean };
  hooks: { pre: Hook[]; post: Hook[] };
  /** Set only for `flow: strict`; absent is `loose`. */
  flow?: "strict";
  body: string;
}

export interface Located {
  automation: Automation;
  dir: string;
  file: string;
  root: Root;
  /** Repository top level; repository scope only. */
  repoRoot?: string;
  /** `${scope}:${root.path}:${name}` */
  key: string;
}

export type Discovered =
  | { ok: true; located: Located }
  | { ok: false; dir: string; file: string; root: Root; key: string; error: string; problems?: readonly string[] };

export type AutomationState = "invalid" | "disabled" | "off" | "armed";

export interface ResolvedModel {
  provider: string;
  id: string;
  thinking?: string;
  display: string;
}

/**
 * Where a session's transcript is. No `format` means pi's JSONL; an unknown tag is reported, never
 * guessed.
 */
export interface SessionReference {
  file: string;
  id: string;
  format?: string;
}

export interface Status {
  key: string;
  name: string;
  scope: Scope;
  root: Root;
  dir: string;
  state: AutomationState;
  /** Present for invalid and off. */
  reason?: string;
  /** When the reason is several problems (a strict flow), each one; `reason` joins them. */
  problems?: readonly string[];
  automation?: Automation;
  /** The model this automation would use (neutral identity, never a native SDK object). */
  resolvedModel?: ResolvedModel;
  effectiveTimeoutMs: number;
  staggerSec: number;
  /** ISO with offset; armed automations with a schedule only. */
  nextFire?: string;
  /** ISO; when the tick will next run the watch script. Armed automations with a watch only. */
  nextCheck?: string;
  /** What the watch script said the last time it ran, when it has. */
  watch?: WatchState;
  /**
   * ISO; since when a person paused this automation's watch. Schedule and manual runs are
   * unaffected.
   */
  watchPausedAt?: string;
  running?: RunLockInfo;
  /**
   * Tracked on a flowchart: a Mermaid chart in `AUTOMATION.md` (or `flow.mmd`), or named in
   * `config.flowTracking`. A property of the automation, not of whether fm is installed.
   */
  flow?: boolean;
  last?: { outcome: Outcome; at: string; reason?: string; durationMs?: number };
}

export interface TrustRecord {
  key: string;
  dir: string;
  repoRoot: string;
  /** "sha256:<hex>" */
  digest: string;
  armedAt: string;
  lastSeenAt: string;
  /** armedAt + config.consentExpiry, for repository automations only. Ignored for user scope. */
  expiresAt?: string;
  /** Script relative path -> display command decided at arm time. */
  interpreters: Record<string, string>;
  /** Per-file hashes at consent time, so a changed-files notice can name the file that moved. */
  files?: Record<string, string | null>;
}

export interface TrustFile {
  version: 1;
  records: Record<string, TrustRecord>;
}

/** What ran the last tick: the watcher, `pa serve`, or `pa tick` by hand. */
export type TickSource = "job" | "serve" | "cli";

export interface StateFile {
  version: 1;
  lastTickAt?: string;
  /** Who ran the tick at `lastTickAt`. Absent in files written before it was recorded. */
  lastTickBy?: TickSource;
  /** key -> ISO of the last cron instant claimed. */
  claimed: Record<string, string>;
  /** Registered repository roots (absolute) for tick-time discovery. */
  roots: string[];
  /** key -> the last check of that automation's watch. Absent in files written before watches. */
  watches?: Record<string, WatchState>;
  /** key -> ISO of when a person paused that automation's watch. Absent when none is paused. */
  pausedWatches?: Record<string, string>;
  /** key -> run id of the failed run a person dismissed from the triage list. */
  dismissedRuns?: Record<string, string>;
}

/**
 * One finished check of an `on.watch` script. `firedFor` makes a watch start one run per finding.
 */
export interface WatchState {
  checkedAt: string;
  /**
   * ISO; the last check that ran to an exit code, told to the script as `AUTOMATION_LAST_CHECKED`.
   */
  answeredAt?: string;
  /** The script's exit code. Absent when it never exited — then `problem` says why. */
  exit?: number;
  /** Why there is no exit code: a timeout, a script that could not start, no executor. */
  problem?: string;
  durationMs: number;
  /** One line of what it printed, bounded, for the listing. */
  said?: string;
  firedAt?: string;
  /** `sha256:<hex>` of the output that started the last run, while it is still what is found. */
  firedFor?: string;
}

export interface Config {
  /** Duration. How late a tick may be and still count as on time. */
  grace: string;
  /** Duration (days allowed). How far back `catch-up: once` will look. */
  catchUpWindow: string;
  defaultTimeout: string;
  maxTimeout: string;
  hookTimeout: string;
  hookMaxOutputBytes: number;
  staggerMaxSeconds: number;
  consentExpiry: string;
  retention: { maxLinesPerAutomation: number; keepLines: number };
  notifyOnFailed: boolean;
  /** key -> fire inside a temporary git worktree. */
  worktree: Record<string, boolean>;
  /** key -> record this automation's steps on its flowchart. An own chart turns it on by itself. */
  flowTracking: Record<string, boolean>;
  /** Explicit path to the fm binary that draws charts (`fm render`), when it is not on PATH. */
  fmPath?: string;
  /**
   * Plugins to load, in order: `manager` or an absolute path. Read from the person's own config
   * only.
   */
  plugins?: string[];
  /**
   * Directory of `@earendil-works/pi-coding-agent`, for a machine where a background run cannot find
   * pi.
   */
  piModule?: string;
}

export type ConfigDurationField =
  | "grace"
  | "catchUpWindow"
  | "defaultTimeout"
  | "maxTimeout"
  | "hookTimeout"
  | "consentExpiry";

export type Outcome = "ok" | "skipped" | "failed" | "missed" | "aborted";
export type ErrorKind = "timeout" | "model-unavailable" | "hook" | "agent" | "host";
export type Trigger = "schedule" | "manual" | "watch";

export interface HookResult {
  phase: "pre" | "post";
  index: number;
  kind: "script" | "prompt";
  /** Script relative path, or "prompt". */
  source: string;
  status: "ok" | "skipped" | "failed";
  exit?: number;
  durationMs: number;
  reason?: string;
  outputBytes?: number;
  truncated?: boolean;
}

export interface RunRecord {
  id: string;
  key: string;
  name: string;
  scope: Scope;
  root: string;
  trigger: Trigger;
  scheduledFor?: string;
  late: boolean;
  recordedAt: string;
  startedAt?: string;
  endedAt?: string;
  outcome: Outcome;
  /** skipped / missed / aborted. */
  reason?: string;
  error?: { kind: ErrorKind; message: string };
  model?: string;
  timeout?: string;
  hooks?: HookResult[];
  /** What the body answered, bounded. The session file is the complete copy. */
  output?: { text: string; truncated?: boolean };
  session?: SessionReference;
  /** The Mermaid chart this run was tracked on, plus what it reported while it went. */
  chart?: string;
  steps?: RunStep[];
  taken?: [string, string][];
  /** Run-level notes, oldest first — what the run published and where. */
  notes?: RunNote[];
  /** The run's one message for the reader (`pa message`): what happened, what needs them, links. */
  message?: RunMessage;
  /** Why this run's steps could not be recorded, when tracking was asked for and went wrong. */
  flow?: { problem?: string };
  /** Plugins that failed or timed out while observing this run. They never change its outcome. */
  pluginProblems?: string[];
  count?: number;
  pid?: number;
}

/** Where a node of a tracked run's chart got to. */
export type StepStatus =
  | "pending"
  | "active"
  | "waiting"
  | "done"
  | "failed"
  | "skipped"
  | "interrupted";

export interface RunStep {
  id: string;
  label: string;
  status: StepStatus;
  /** The last message attached to the node. */
  text?: string;
  startedAt?: string;
  endedAt?: string;
}

/** A link a note points at. Always http or https. */
export interface RunLink {
  label?: string;
  url: string;
}

export interface RunNote {
  ts: string;
  text: string;
  links: RunLink[];
}

/** A run's message to its reader. Shaped like a note; a run keeps only its last one. */
export type RunMessage = RunNote;

/** What a tracked run reported, folded at its end into the record. */
export interface RunProgress {
  chart: string;
  steps: RunStep[];
  taken: [string, string][];
  notes: RunNote[];
  message?: RunMessage;
}

export interface RunLockInfo {
  pid: number;
  runId: string;
  key: string;
  startedAt: string;
  timeoutMs: number;
  postHooks: number;
  trigger: Trigger;
  scheduledFor?: string;
  /**
   * The session this run's body opened. Also on the lock, because a scheduled run has no listener.
   */
  session?: SessionReference;
}

export type FireEvent =
  | {
      event: "start";
      runId: string;
      key: string;
      trigger: Trigger;
      scheduledFor?: string;
      late: boolean;
    }
  /**
   * The run is tracked, and `run` is its progress id. Emitted once, after the progress store opens.
   */
  | { event: "flow"; run: string }
  | { event: "hook-start"; phase: "pre" | "post"; index: number; source: string }
  | { event: "hook-end"; result: HookResult }
  | { event: "body-start"; model: string; cwd: string }
  /** The body's session is open. Emitted once, after the session starts. */
  | ({ event: "session" } & SessionReference)
  | { event: "body-end"; chars: number }
  | { event: "record"; record: RunRecord }
  /**
   * An optional integration failed without changing the run. Can follow `record`, so `record` is
   * not the end of the stream.
   */
  | {
      event: "problem";
      message: string;
      /**
       * Which run this belongs to. When absent (older logs), readers fall back to the window after
       * `start`.
       */
      runId?: string;
    };

export interface DetachedFile {
  platform: NodeJS.Platform;
  jobName: string;
  nodePath: string;
  packageDir: string;
  tickPath: string;
  shimPath?: string;
  installedAt: string;
  method: "schtasks" | "launchd" | "systemd" | "crontab";
}
