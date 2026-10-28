// The AUTOMATION.md parser: eight fields, everything else refused by name. YAML 1.2, so `on` is a
// key.

import path from "node:path";

import { parseDocument } from "yaml";

import { validateCron } from "./cron.js";
import { DURATION_RE, parseDuration } from "./duration.js";
import { AutomationError } from "./errors.js";
import { checkStrictFlow, flowProblemLine } from "./strict-flow.js";
import type { Automation, Hook, Schedule, Watch } from "./types.js";

/** The closed field list. Adding a member is a specification change, not a feature. */
export const FIELDS = ["name", "description", "enabled", "model", "timeout", "on", "hooks", "flow"] as const;
export const FIELD_SET: ReadonlySet<string> = new Set(FIELDS);

/** `flow`: `loose` (the default) or `strict`, where the flowchart sets the body's sections. */
export const FLOWS = ["loose", "strict"] as const;

/** The closed trigger list. `watch` is this host's addition. */
export const TRIGGERS = ["schedule", "manual", "watch"] as const;
export const TRIGGER_SET: ReadonlySet<string> = new Set(TRIGGERS);

/** The closed `on.schedule` key list. */
export const SCHEDULE_KEYS = ["cron", "timezone", "catch-up"] as const;
export const SCHEDULE_KEY_SET: ReadonlySet<string> = new Set(SCHEDULE_KEYS);

/** The closed `on.watch` key list. */
export const WATCH_KEYS = ["script", "every"] as const;
export const WATCH_KEY_SET: ReadonlySet<string> = new Set(WATCH_KEYS);

/** `on.watch.every` bounds: the tick runs once a minute; past a day a cron is better. */
export const WATCH_EVERY_MIN_MS = 60_000;
export const WATCH_EVERY_MAX_MS = 24 * 3_600_000;

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `<provider>/<id>[:<thinking>]`; ids may contain colons, resolved by `splitModelSpec`. */
export const MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[^\s/]+$/i;

export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;

const FIELD_LIST = FIELDS.join(", ");
const TRIGGER_LIST = TRIGGERS.join(", ");

/** Split `---\n<yaml>\n---\n<body>`. Returns undefined when there is no frontmatter at all. */
export function splitFrontmatter(text: string): { yaml: string; body: string } | undefined {
  if (typeof text !== "string") return undefined;

  // A BOM before the opening fence is invisible in an editor; strip it rather than refusing.
  const src = text.replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || (lines[0] as string).trim() !== "---") return undefined;

  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] as string).trim() === "---") {
      return {
        yaml: lines.slice(1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return undefined;
}

/** `Intl.supportedValuesOf("timeZone")` omits `UTC` on some runtimes, so it is special-cased. */
let zoneCache: Set<string> | undefined;
export function isIanaZone(tz: unknown): boolean {
  if (typeof tz !== "string" || tz === "") return false;
  if (tz === "UTC") return true;
  if (!zoneCache) {
    try {
      zoneCache = new Set(Intl.supportedValuesOf("timeZone"));
    } catch {
      zoneCache = new Set();
    }
  }
  if (zoneCache.has(tz)) return true;
  // A runtime with no `supportedValuesOf` still knows its zones; ask the formatter directly.
  if (zoneCache.size === 0) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Normalize `on.schedule`, which is either a bare cron string or a mapping. */
export function normalizeSchedule(v: unknown): Schedule {
  if (typeof v === "string") {
    const problem = validateCron(v);
    if (problem) throw new AutomationError("on.schedule.cron", problem);
    return { cron: v.trim(), catchUp: "skip" };
  }

  if (!isPlainObject(v)) {
    throw new AutomationError(
      "on.schedule",
      `must be a cron string or a mapping of ${SCHEDULE_KEYS.join(", ")}`,
    );
  }

  const unknown = Object.keys(v)
    .filter((k) => !SCHEDULE_KEY_SET.has(k))
    .sort();
  if (unknown.length > 0) {
    throw new AutomationError(
      `on.schedule.${unknown[0]}`,
      `unknown key — on.schedule has ${SCHEDULE_KEYS.join(", ")}`,
    );
  }

  if (!("cron" in v)) {
    throw new AutomationError("on.schedule.cron", 'required — 5 fields, for example "0 7 * * MON-FRI"');
  }
  const problem = validateCron(v.cron);
  if (problem) throw new AutomationError("on.schedule.cron", problem);

  const schedule: Schedule = { cron: String(v.cron).trim(), catchUp: "skip" };

  if ("timezone" in v && v.timezone !== null && v.timezone !== undefined) {
    if (!isIanaZone(v.timezone)) {
      throw new AutomationError(
        "on.schedule.timezone",
        `${JSON.stringify(v.timezone)} is not an IANA zone — try America/Los_Angeles`,
      );
    }
    schedule.timezone = v.timezone as string;
  }

  if ("catch-up" in v && v["catch-up"] !== null && v["catch-up"] !== undefined) {
    const c = v["catch-up"];
    if (c !== "skip" && c !== "once") {
      throw new AutomationError(
        "on.schedule.catch-up",
        `${JSON.stringify(c)} is not skip or once`,
      );
    }
    schedule.catchUp = c;
  }

  return schedule;
}

function normalizeHookList(raw: unknown, phase: "pre" | "post"): Hook[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AutomationError(
      `hooks.${phase}`,
      "must be a list of { script: <path> } or { prompt: <text> }",
    );
  }

  return raw.map((item, i) => {
    const at = `hooks.${phase}[${i}]`;
    if (!isPlainObject(item)) {
      throw new AutomationError(at, "must be { script: <path> } or { prompt: <text> }");
    }
    const keys = Object.keys(item);
    if (keys.length !== 1 || (keys[0] !== "script" && keys[0] !== "prompt")) {
      throw new AutomationError(at, "must be { script: <path> } or { prompt: <text> }");
    }

    if (keys[0] === "prompt") {
      const prompt = item.prompt;
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new AutomationError(`${at}.prompt`, "must be text — an empty prompt asks nothing");
      }
      return { prompt };
    }

    const script = item.script;
    checkScriptPath(script, `${at}.script`);
    return { script: script as string };
  });
}

// A script path is text, relative and inside the folder; symlinks are checked at discovery.
function checkScriptPath(script: unknown, at: string): void {
  if (typeof script !== "string" || script.trim() === "") {
    throw new AutomationError(at, "is empty — give a path relative to the automation directory");
  }
  if (path.isAbsolute(script) || /^[a-zA-Z]:[\\/]/.test(script)) {
    throw new AutomationError(
      at,
      `${JSON.stringify(script)} is absolute — use a path relative to the automation directory`,
    );
  }
  const normalized = path.normalize(script);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.startsWith("../")) {
    throw new AutomationError(
      at,
      `${JSON.stringify(script)} leaves the automation directory — scripts must live inside it`,
    );
  }
}

/** Normalize `on.watch`, which is always `{ script, every }`. */
export function normalizeWatch(v: unknown): Watch {
  if (!isPlainObject(v)) {
    throw new AutomationError(
      "on.watch",
      "must be { script: <path>, every: <duration> } — for example script: scripts/watch.js and every: 5m",
    );
  }

  const unknown = Object.keys(v)
    .filter((k) => !WATCH_KEY_SET.has(k))
    .sort();
  if (unknown.length > 0) {
    throw new AutomationError(
      `on.watch.${unknown[0]}`,
      `unknown key — on.watch has ${WATCH_KEYS.join(", ")}`,
    );
  }

  if (v.script === undefined || v.script === null) {
    throw new AutomationError(
      "on.watch.script",
      "required — the script that looks for work, relative to the automation directory",
    );
  }
  checkScriptPath(v.script, "on.watch.script");

  if (v.every === undefined || v.every === null) {
    throw new AutomationError("on.watch.every", "required — how often to run the script, for example 5m");
  }
  const every = v.every;
  const everyMs = typeof every === "string" ? parseDuration(every) : undefined;
  if (typeof every !== "string" || everyMs === undefined) {
    throw new AutomationError(
      "on.watch.every",
      `${JSON.stringify(every)} is not a duration — use 1m, 5m, 1h`,
    );
  }
  if (everyMs < WATCH_EVERY_MIN_MS) {
    throw new AutomationError(
      "on.watch.every",
      `${every} is shorter than a minute — use 1m or more`,
    );
  }
  if (everyMs > WATCH_EVERY_MAX_MS) {
    throw new AutomationError(
      "on.watch.every",
      `${every} is longer than 24h — use on.schedule for anything rarer`,
    );
  }

  return { script: v.script as string, every };
}

/** Parse and validate one AUTOMATION.md; throws a one-line `AutomationError`. */
export function parseAutomation(text: string, dirName: string): Automation {
  const split = splitFrontmatter(text);
  if (!split) {
    throw new AutomationError(
      "frontmatter",
      "missing — AUTOMATION.md starts with a --- line, then YAML, then another --- line",
    );
  }

  const front = parseFrontmatterYaml(split.yaml);

  const body = split.body.trim();
  if (body === "") {
    throw new AutomationError(
      "body",
      "missing — the Markdown body after the frontmatter is the prompt for each run",
    );
  }

  // 1. Unknown fields, all of them, in one line.
  const unknown = Object.keys(front)
    .filter((k) => !FIELD_SET.has(k))
    .sort();
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? "unknown field" : "unknown fields";
    throw new AutomationError(unknown.join(", "), `${label} — Draft 0.2 has ${FIELD_LIST}`);
  }

  // 2. name
  const name = front.name;
  if (name === undefined || name === null) {
    throw new AutomationError(
      "name",
      `required — ≤${NAME_MAX} chars, lowercase letters, digits and hyphens, same as the directory name`,
    );
  }
  if (typeof name !== "string") {
    throw new AutomationError("name", "must be a string — lowercase letters, digits and hyphens");
  }
  if (name.length > NAME_MAX) {
    throw new AutomationError("name", `is ${name.length} characters — the maximum is ${NAME_MAX}`);
  }
  if (!NAME_RE.test(name)) {
    throw new AutomationError(
      "name",
      `${JSON.stringify(name)} is not a valid name — use lowercase letters, digits and single hyphens`,
    );
  }
  if (name !== dirName) {
    throw new AutomationError(
      "name",
      `${JSON.stringify(name)} does not match the directory name ${JSON.stringify(dirName)} — they must be the same`,
    );
  }

  // 3. description
  const description = front.description;
  if (description === undefined || description === null) {
    throw new AutomationError(
      "description",
      `required — ≤${DESCRIPTION_MAX} chars saying what this automation does`,
    );
  }
  if (typeof description !== "string") {
    throw new AutomationError(
      "description",
      `must be a string — ≤${DESCRIPTION_MAX} chars saying what this automation does`,
    );
  }
  if (description.length > DESCRIPTION_MAX) {
    throw new AutomationError(
      "description",
      `is ${description.length} characters — the maximum is ${DESCRIPTION_MAX}`,
    );
  }

  // 4. enabled: only booleans; "no" and "off" are YAML 1.1 habits.
  let enabled = true;
  if ("enabled" in front && front.enabled !== null && front.enabled !== undefined) {
    if (typeof front.enabled !== "boolean") {
      throw new AutomationError(
        "enabled",
        `${JSON.stringify(front.enabled)} is not true or false — enabled is a boolean`,
      );
    }
    enabled = front.enabled;
  }

  // 5. model: shape only; resolution happens at arm time and on every discovery.
  let model: string | undefined;
  if ("model" in front && front.model !== null && front.model !== undefined) {
    if (typeof front.model !== "string" || !MODEL_RE.test(front.model)) {
      throw new AutomationError(
        "model",
        `${JSON.stringify(front.model)} is not <provider>/<id>[:<thinking>] — for example anthropic/claude-sonnet-4-5:low`,
      );
    }
    model = front.model;
  }

  // 6. timeout: grammar only; the host maximum is checked in status.ts.
  let timeout: string | undefined;
  if ("timeout" in front && front.timeout !== null && front.timeout !== undefined) {
    if (typeof front.timeout !== "string" || !DURATION_RE.test(front.timeout)) {
      throw new AutomationError(
        "timeout",
        `${JSON.stringify(front.timeout)} is not a duration — use 90s, 10m, 1h`,
      );
    }
    timeout = front.timeout;
  }

  // 7. on
  const on = parseOn(front.on);

  // 8. hooks
  const hooks = parseHooks(front.hooks);

  // 9. flow, and in strict mode the body against its chart: every problem at once.
  const flow = parseFlow(front.flow);
  if (flow === "strict") {
    const problems = checkStrictFlow(split.body, split.yaml.split("\n").length + 3).map(flowProblemLine);
    if (problems.length > 0) throw new AutomationError("flow", problems.join("; "), problems);
  }

  const automation: Automation = {
    name,
    description,
    enabled,
    on,
    hooks,
    body,
  };
  if (model !== undefined) automation.model = model;
  if (timeout !== undefined) automation.timeout = timeout;
  if (flow === "strict") automation.flow = flow;
  return automation;
}

function parseFlow(raw: unknown): (typeof FLOWS)[number] {
  if (raw === undefined || raw === null) return "loose";
  if (raw !== "loose" && raw !== "strict") {
    throw new AutomationError("flow", `${JSON.stringify(raw)} is not loose or strict`);
  }
  return raw;
}

function parseOn(raw: unknown): Automation["on"] {
  if (raw === undefined || raw === null) {
    throw new AutomationError("on", `required — at least one trigger (${TRIGGER_LIST})`);
  }
  if (!isPlainObject(raw)) {
    throw new AutomationError("on", `must be a mapping of trigger types (${TRIGGER_LIST})`);
  }

  const keys = Object.keys(raw);
  if (keys.length === 0) {
    throw new AutomationError("on", `needs at least one trigger — ${TRIGGER_LIST}`);
  }

  const unknown = keys.filter((k) => !TRIGGER_SET.has(k)).sort();
  if (unknown.length > 0) {
    throw new AutomationError(`on.${unknown[0]}`, `this host implements ${TRIGGER_LIST}`);
  }

  const on: Automation["on"] = { manual: false };

  if ("manual" in raw && raw.manual !== null && raw.manual !== undefined) {
    if (raw.manual !== true) {
      throw new AutomationError(
        "on.manual",
        `${JSON.stringify(raw.manual)} is not true — write "manual: true", or remove it to disallow manual runs`,
      );
    }
    on.manual = true;
  }

  if ("schedule" in raw && raw.schedule !== null && raw.schedule !== undefined) {
    on.schedule = normalizeSchedule(raw.schedule);
  }

  if ("watch" in raw && raw.watch !== null && raw.watch !== undefined) {
    on.watch = normalizeWatch(raw.watch);
  }

  if (!on.schedule && !on.watch && !on.manual) {
    throw new AutomationError("on", `needs at least one trigger — ${TRIGGER_LIST}`);
  }

  return on;
}

function parseHooks(raw: unknown): Automation["hooks"] {
  if (raw === undefined || raw === null) return { pre: [], post: [] };
  if (!isPlainObject(raw)) {
    throw new AutomationError("hooks", "must be a mapping with pre and post lists");
  }

  const unknown = Object.keys(raw)
    .filter((k) => k !== "pre" && k !== "post")
    .sort();
  if (unknown.length > 0) {
    throw new AutomationError(`hooks.${unknown[0]}`, "unknown key — hooks has pre, post");
  }

  return {
    pre: normalizeHookList(raw.pre, "pre"),
    post: normalizeHookList(raw.post, "post"),
  };
}

/** YAML 1.2 keeps `on` a string key; `uniqueKeys` makes a duplicated key an error. */
function parseFrontmatterYaml(yamlText: string): Record<string, unknown> {
  const doc = parseDocument(yamlText, {
    version: "1.2",
    uniqueKeys: true,
    schema: "core",
  });

  if (doc.errors.length > 0) {
    const first = doc.errors[0] as { message: string };
    let message = String(first.message).split("\n")[0] ?? "could not be parsed";
    // An unquoted cron starting with `*` parses as a YAML alias; name the real cause.
    if (/alias|anchor/i.test(message) && /^\s*(cron|schedule)\s*:\s*\*/m.test(yamlText)) {
      message += " — quote the cron expression";
    }
    throw new AutomationError("frontmatter", message);
  }

  const value = doc.toJS({ maxAliasCount: 100 });
  if (value === null || value === undefined) {
    throw new AutomationError(
      "frontmatter",
      "is empty — Draft 0.2 needs at least name, description and on",
    );
  }
  if (!isPlainObject(value)) {
    throw new AutomationError("frontmatter", "must be a YAML mapping of fields");
  }
  return value;
}

/** Flip `enabled:` with a one-line edit, keeping formatting, comments and line endings. */
export function setEnabledInPlace(text: string, enabled: boolean): string {
  const split = splitFrontmatter(text);
  if (!split) return text;

  const usesCrlf = /\r\n/.test(text);
  const eol = usesCrlf ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  // Frontmatter spans line 0 (`---`) to the closing fence.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] as string).trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return text;

  const value = enabled ? "true" : "false";

  for (let i = 1; i < close; i++) {
    const line = lines[i] as string;
    const m = /^(enabled\s*:)([^#]*)(#.*)?$/.exec(line);
    if (!m) continue;
    const comment = m[3] ? ` ${m[3]}` : "";
    lines[i] = `${m[1]} ${value}${comment}`;
    return lines.join(eol);
  }

  // No `enabled` line. `true` is already the default, so adding it would be noise.
  if (enabled) return text;

  for (let i = 1; i < close; i++) {
    if (/^name\s*:/.test(lines[i] as string)) {
      lines.splice(i + 1, 0, `enabled: ${value}`);
      return lines.join(eol);
    }
  }

  lines.splice(1, 0, `enabled: ${value}`);
  return lines.join(eol);
}
