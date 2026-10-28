import type { Automation, Schedule, Watch } from "./types.js";
/** The closed field list. Adding a member is a specification change, not a feature. */
export declare const FIELDS: readonly ["name", "description", "enabled", "model", "timeout", "on", "hooks", "flow"];
export declare const FIELD_SET: ReadonlySet<string>;
/** `flow`: `loose` (the default) or `strict`, where the flowchart sets the body's sections. */
export declare const FLOWS: readonly ["loose", "strict"];
/** The closed trigger list. `watch` is this host's addition. */
export declare const TRIGGERS: readonly ["schedule", "manual", "watch"];
export declare const TRIGGER_SET: ReadonlySet<string>;
/** The closed `on.schedule` key list. */
export declare const SCHEDULE_KEYS: readonly ["cron", "timezone", "catch-up"];
export declare const SCHEDULE_KEY_SET: ReadonlySet<string>;
/** The closed `on.watch` key list. */
export declare const WATCH_KEYS: readonly ["script", "every"];
export declare const WATCH_KEY_SET: ReadonlySet<string>;
/** `on.watch.every` bounds: the tick runs once a minute; past a day a cron is better. */
export declare const WATCH_EVERY_MIN_MS = 60000;
export declare const WATCH_EVERY_MAX_MS: number;
export declare const NAME_RE: RegExp;
/** `<provider>/<id>[:<thinking>]`; ids may contain colons, resolved by `splitModelSpec`. */
export declare const MODEL_RE: RegExp;
export declare const NAME_MAX = 64;
export declare const DESCRIPTION_MAX = 1024;
/** Split `---\n<yaml>\n---\n<body>`. Returns undefined when there is no frontmatter at all. */
export declare function splitFrontmatter(text: string): {
    yaml: string;
    body: string;
} | undefined;
export declare function isIanaZone(tz: unknown): boolean;
/** Normalize `on.schedule`, which is either a bare cron string or a mapping. */
export declare function normalizeSchedule(v: unknown): Schedule;
/** Normalize `on.watch`, which is always `{ script, every }`. */
export declare function normalizeWatch(v: unknown): Watch;
/** Parse and validate one AUTOMATION.md; throws a one-line `AutomationError`. */
export declare function parseAutomation(text: string, dirName: string): Automation;
/** Flip `enabled:` with a one-line edit, keeping formatting, comments and line endings. */
export declare function setEnabledInPlace(text: string, enabled: boolean): string;
