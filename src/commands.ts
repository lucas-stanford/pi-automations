// The `/automations` commands. Every handler re-discovers first and returns lines.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ms } from "./config.js";
import { describeNext, nextTick } from "./cron.js";
import { installedPaths } from "./detached/index.js";
import { digestOf } from "./digest.js";
import { discover, located } from "./discover.js";
import { runWatchScript } from "./hooks.js";
import { readJson } from "./jsonfile.js";
import { summaryLine } from "./summary.js";
import { formatDuration } from "./duration.js";
import { oneLine } from "./errors.js";
import { renderListing } from "./listing.js";
import { readRecords } from "./records.js";
import { readWatchState } from "./state.js";
import { decideWatch, everyMs } from "./watch.js";
import { isAlive, isRunLockStale, readRunLock, requestCancel } from "./locks.js";
import { foldRunProblems, readFireLogTail } from "./ui/firelog.js";
import { mergeObservedReplay, observedView, replayFireLog, type RunView } from "./ui/run-view.js";
import { PROBLEMS_SHOWN, renderRunningLines } from "./ui/running.js";
import { stripControls, truncateToWidth } from "./ui/width.js";
import { openCommand, renderReport, type FlowSvgFor } from "./report.js";
import { findFmRenderer, fmRender } from "./providers/fm/render.js";
import { chartState, snapshotFromRecord } from "./progress.js";
import { buildStepListLines } from "./ui/graph.js";
import { localStamp } from "./ui/words.js";
import type { CheckFacts } from "./ui/check.js";
import type { WatcherFacts } from "./ui/details.js";
import { setEnabledInPlace } from "./parse.js";
import { ensureDir, statePaths, tildify, findRepoRoot } from "./paths.js";
import { computeStatuses, interpreterMap, timeoutText } from "./status.js";
import type { ModelResolver, RunScript } from "./core/contracts.js";
import type { State } from "./state.js";
import type { Trust } from "./trust.js";
import type { Config, Located, RunRecord, StateFile, Status, WatchState } from "./types.js";

export type Sub =
  | "list"
  | "run"
  | "running"
  | "arm"
  | "disarm"
  | "enable"
  | "disable"
  | "log"
  | "runs"
  | "check"
  | "watch"
  | "edit"
  | "report"
  | "watcher"
  | "help";

export const SUBS: ReadonlySet<string> = new Set([
  "list",
  "run",
  "running",
  "arm",
  "disarm",
  "enable",
  "disable",
  "log",
  "runs",
  "check",
  "watch",
  "edit",
  "report",
  "watcher",
  // The old name for `watcher`, still accepted.
  "detached",
  "help",
]);

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
export function parseArgs(args: string): ParsedArgs {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const flags = new Set<string>();
  const words: string[] = [];

  for (const t of tokens) {
    if (t.startsWith("--")) flags.add(t.slice(2));
    else words.push(t);
  }

  const first = words[0];
  if (first === undefined) return { sub: "list", flags };

  if (!SUBS.has(first)) {
    // `/automations <name>` reads as `check <name>`.
    return { sub: "check", name: first, flags };
  }

  const sub = (first === "detached" ? "watcher" : first) as Sub;
  const rest = words.slice(1);

  if (sub === "watcher") {
    const parsed: ParsedArgs = { sub, flags };
    if (rest[0]) parsed.verb = rest[0];
    return parsed;
  }

  // An automation called "pause" is still reachable as `watch user/pause`.
  if (sub === "watch" && (rest[0] === "pause" || rest[0] === "resume")) {
    const parsed: ParsedArgs = { sub, flags, verb: rest[0] };
    if (rest[1]) parsed.name = rest[1];
    if (rest[2]) parsed.unknown = rest[2];
    return parsed;
  }

  const parsed: ParsedArgs = { sub, flags };
  for (const w of rest) {
    if (/^\d+$/.test(w) && parsed.n === undefined) parsed.n = Number(w);
    else if (parsed.name === undefined) parsed.name = w;
    else parsed.unknown = w;
  }
  return parsed;
}

export type NameMatch =
  | { kind: "one"; status: Status }
  | { kind: "ambiguous"; matches: Status[] }
  | { kind: "none" };

/** Find the automation a person meant (name, `user/` or `repository/` prefix, or key); never guess. */
export function resolveName(statuses: Status[], arg: string): NameMatch {
  const exactKey = statuses.filter((s) => s.key === arg);
  if (exactKey.length === 1) return { kind: "one", status: exactKey[0] as Status };

  let wanted = arg;
  let scope: "user" | "repository" | undefined;
  if (arg.startsWith("user/")) {
    scope = "user";
    wanted = arg.slice("user/".length);
  } else if (arg.startsWith("repository/")) {
    scope = "repository";
    wanted = arg.slice("repository/".length);
  } else if (arg.startsWith("project/")) {
    // The old prefix, still accepted.
    scope = "repository";
    wanted = arg.slice("project/".length);
  }

  const matches = statuses.filter((s) => s.name === wanted && (!scope || s.scope === scope));
  if (matches.length === 1) return { kind: "one", status: matches[0] as Status };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "none" };
}

export function ambiguousLine(name: string, matches: Status[], home: string): string {
  const forms = matches
    .map((m) => `${m.scope}/${m.name} (${tildify(m.dir, home)})`)
    .join(", ");
  return `ambiguous ${JSON.stringify(name)}: ${forms} — use one of these`;
}

export function notFoundLine(name: string): string {
  return `no automation named ${JSON.stringify(name)} — /automations to list`;
}

// ------------------------------------------------------------------ handler context

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
  // Spawns bin/fire.js; injected so tests never start a process.
  spawnFire: (
    args: string[],
    opts: { attached: boolean; located?: Located },
  ) => Promise<number> | number;
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

export async function refresh(deps: CommandDeps): Promise<Refreshed> {
  const found = discover({ cwd: deps.cwd, extraRepoRoots: deps.state.roots, ...(deps.host ? { host: deps.host } : {}) });
  const statuses = await computeStatuses(found, {
    trust: deps.trust,
    config: deps.config,
    stateDir: deps.stateDir,
    now: deps.now(),
    ...(deps.resolveModel ? { resolveModel: deps.resolveModel } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
  deps.trust.save();

  const byKey = new Map<string, Located>();
  for (const l of located(found)) byKey.set(l.key, l);

  const projectRoots = uniqueRoots(
    located(found)
      .filter((l) => l.root.scope === "repository" && l.repoRoot)
      .map((l) => l.repoRoot as string),
    deps.cwd,
    deps.state.roots,
  );

  return { statuses, byKey, projectRoots };
}

function uniqueRoots(fromAutomations: string[], cwd: string, registered: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined) => {
    if (!p) return;
    const r = path.resolve(p);
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };

  // The repository the person is standing in comes first, then anything else that has automations.
  add(findRepoRoot(cwd));
  for (const p of fromAutomations) add(p);
  for (const p of registered) add(p);
  return out;
}

// ------------------------------------------------------------------ handlers

export interface HandlerResult {
  lines: string[];
  /** Non-zero for the CLI. 0 = ok, 2 = refused, 10 = skipped, 20 = failed. */
  exitCode?: number;
  /** Set when the caller should ask the person to confirm arming. */
  consent?: { status: Status; located: Located; preview: string[]; andRun: boolean };
}

/** Stop the exact run the person selected. Writing the request is all this does. */
export function handleStop(
  deps: Pick<CommandDeps, "stateDir">,
  target: Pick<RunView, "key" | "name" | "runId">,
): HandlerResult {
  const reply = (text: string, exitCode = 0): HandlerResult => ({
    lines: [`${target.name}: ${text}`], exitCode,
  });
  if (!target.runId) return reply("run id not available yet — refresh and try again", 2);

  const lock = readRunLock(deps.stateDir, target.key);
  if (!lock || !isAlive(lock.pid)) return reply("not running — no live run process");
  if (lock.key !== target.key || lock.runId !== target.runId) {
    return reply("the selected run has ended; a different run is active — refresh before stopping it", 2);
  }
  // Use liveness here, not the age budget: an overdue process may still need to be stopped.
  if (!requestCancel(deps.stateDir, target.key, target.runId)) {
    return reply("could not write the stop request", 2);
  }
  return reply("stop requested — waiting for the run to finish its post hooks and record its outcome");
}

export async function handleList(deps: CommandDeps, r: Refreshed): Promise<HandlerResult> {
  return {
    lines: renderListing(r.statuses, {
      home: deps.home,
      projectRoots: r.projectRoots,
      now: deps.now(),
      ...(deps.width ? { width: deps.width } : {}),
    }),
  };
}

/** Every run in flight, from the locks, with liveness checked here. */
export function runningViews(deps: CommandDeps, r: Refreshed): RunView[] {
  const now = deps.now();
  const hookTimeoutMs = ms(deps.config, "hookTimeout");
  const views: RunView[] = [];

  for (const s of r.statuses) {
    const lock = readRunLock(deps.stateDir, s.key);
    if (!lock) continue;
    if (!isAlive(lock.pid) || isRunLockStale(lock, hookTimeoutMs, now)) continue;

    const base = observedView(lock);
    const replayed = replayFireLog(base, readFireLogTail(deps.stateDir, s.key), lock.runId);
    views.push(mergeObservedReplay(base, replayed));
  }

  return views;
}

export async function handleRunning(deps: CommandDeps, r: Refreshed): Promise<HandlerResult> {
  return { lines: renderRunningLines(runningViews(deps, r), deps.now()) };
}

/** How the HTML report gets a flowchart: fm when available, else the step list. */
export function reportFlowArt(deps: CommandDeps): FlowSvgFor | undefined {
  const bin = findFmRenderer(deps.config.fmPath);

  return (record: RunRecord) => {
    const snap = snapshotFromRecord(record);
    if (!snap) return undefined;
    if (bin) {
      const svg = fmRender(bin, { plan: snap.chart, state: chartState(snap), format: "svg" });
      if ("text" in svg) return { svg: svg.text };
    }
    return { md: buildStepListLines(snap.nodes, 120).join("\n") };
  };
}
/** The consent preview: everything the person is agreeing to, scripts first. */
export function consentPreview(
  s: Status,
  l: Located,
  deps: CommandDeps,
  title = "Arm",
): string[] {
  const a = l.automation;
  const lines: string[] = [];
  lines.push(`${title} ${a.name}  from ${tildify(l.root.path, deps.home)}`);
  lines.push(`description   ${a.description}`);

  if (a.on.schedule) {
    const bits = [a.on.schedule.cron];
    if (a.on.schedule.timezone) bits.push(a.on.schedule.timezone);
    bits.push(`catch-up ${a.on.schedule.catchUp}`);
    const next = describeNext(a.on.schedule, deps.now(), s.staggerSec);
    lines.push(`schedule      ${bits.join(" · ")}      next ${next}`);
  }
  if (a.on.watch) {
    // The watch script runs unattended, so show its command like a hook's.
    const cmd = interpreterMap(l, deps.platform)[a.on.watch.script];
    lines.push(
      `watch         ${a.on.watch.script} every ${a.on.watch.every}${cmd ? `        → ${cmd}` : ""}`,
    );
  }
  if (a.on.manual) lines.push("manual        allowed");

  lines.push(`model         ${s.resolvedModel?.display ?? a.model ?? "host default"}`);
  lines.push(`timeout       ${timeoutText(s, deps.config)}`);

  const interpreters = interpreterMap(l, deps.platform);
  for (const phase of ["pre", "post"] as const) {
    a.hooks[phase].forEach((hook, i) => {
      if ("script" in hook) {
        const cmd = interpreters[hook.script];
        lines.push(
          `${phase.padEnd(4)} [${i}] script  ${hook.script}${cmd ? `        → ${cmd}` : ""}`,
        );
      } else {
        lines.push(`${phase.padEnd(4)} [${i}] prompt  ${JSON.stringify(truncate(hook.prompt, 60))}`);
      }
    });
  }

  lines.push("");
  lines.push(
    "This arms a schedule on this machine with your credentials. Scripts run with your permissions.",
  );
  return lines;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export async function handleArm(
  deps: CommandDeps,
  r: Refreshed,
  name: string | undefined,
  andRun = false,
): Promise<HandlerResult> {
  if (!name) return { lines: ["arm needs a name — /automations arm <name>"], exitCode: 2 };

  const match = resolveName(r.statuses, name);
  if (match.kind === "none") return { lines: [notFoundLine(name)], exitCode: 2 };
  if (match.kind === "ambiguous") {
    return { lines: [ambiguousLine(name, match.matches, deps.home)], exitCode: 2 };
  }

  const s = match.status;
  if (s.state === "invalid") return { lines: [`${s.name}: ${s.reason ?? "invalid"}`], exitCode: 2 };
  if (s.state === "disabled") {
    return {
      lines: [`${s.name}: enabled: false in the file — it is inert on every host`],
      exitCode: 2,
    };
  }
  if (s.state === "armed" && !andRun) return { lines: [`${s.name} is already armed`] };

  const l = r.byKey.get(s.key);
  if (!l) return { lines: [notFoundLine(name)], exitCode: 2 };

  return {
    lines: [],
    consent: {
      status: s,
      located: l,
      preview: consentPreview(s, l, deps, andRun ? "Arm and run" : "Arm"),
      andRun,
    },
  };
}

/** Called once the person has accepted the preview. */
export function applyArm(deps: CommandDeps, l: Located): string[] {
  let digest: string;
  try {
    digest = digestOf(l);
  } catch (e) {
    return [oneLine(e)];
  }

  deps.trust.arm(
    l,
    digest,
    interpreterMap(l, deps.platform),
    deps.now(),
    ms(deps.config, "consentExpiry"),
  );

  if (l.repoRoot) {
    const repoRoot = l.repoRoot;
    deps.state.update((state) => state.registerRoot(repoRoot));
  }

  const schedule = l.automation.on.schedule;
  const next = schedule ? ` · next ${describeNext(schedule, deps.now(), 0)}` : "";
  return [`${l.automation.name} armed${next}`];
}

export async function handleDisarm(
  deps: CommandDeps,
  r: Refreshed,
  name: string | undefined,
): Promise<HandlerResult> {
  if (!name) return { lines: ["disarm needs a name — /automations disarm <name>"], exitCode: 2 };

  const match = resolveName(r.statuses, name);
  if (match.kind === "none") return { lines: [notFoundLine(name)], exitCode: 2 };
  if (match.kind === "ambiguous") {
    return { lines: [ambiguousLine(name, match.matches, deps.home)], exitCode: 2 };
  }

  const s = match.status;
  deps.trust.disarm({ key: s.key });
  return { lines: [`${s.name} disarmed — it stays listed, and will not run`] };
}

export async function handleEnable(
  deps: CommandDeps,
  r: Refreshed,
  name: string | undefined,
  enabled: boolean,
): Promise<HandlerResult> {
  const verb = enabled ? "enable" : "disable";
  if (!name) return { lines: [`${verb} needs a name — /automations ${verb} <name>`], exitCode: 2 };

  const match = resolveName(r.statuses, name);
  if (match.kind === "none") return { lines: [notFoundLine(name)], exitCode: 2 };
  if (match.kind === "ambiguous") {
    return { lines: [ambiguousLine(name, match.matches, deps.home)], exitCode: 2 };
  }

  const s = match.status;
  if (s.scope === "repository") {
    // Writing into a repository would leave an uncommitted change in a file the team shares.
    return {
      lines: [
        "enabled is set in the file — edit and commit; /automations disarm keeps it off on this machine",
      ],
      exitCode: 2,
    };
  }

  // Consent that held before this one-line edit still holds after it.
  const l = r.byKey.get(s.key);
  const wasArmed = l !== undefined && deps.trust.offReason(l, deps.now()) === undefined;

  const file = path.join(s.dir, "AUTOMATION.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { lines: [`${s.name}: cannot read AUTOMATION.md — ${oneLine(e)}`], exitCode: 2 };
  }

  const next = setEnabledInPlace(text, enabled);
  if (next === text && !enabled) {
    return { lines: [`${s.name} is already disabled`] };
  }
  try {
    writeFileSync(file, next);
  } catch (e) {
    return { lines: [`${s.name}: cannot write AUTOMATION.md — ${oneLine(e)}`], exitCode: 2 };
  }
  if (wasArmed && l) {
    try {
      deps.trust.repin(l);
    } catch {
      deps.trust.disarm(l);
    }
  }

  if (enabled && !wasArmed) {
    return { lines: [`${s.name} enabled — not armed yet: /automations arm ${s.name}`] };
  }
  return { lines: [`${s.name} ${enabled ? "enabled" : "disabled"}`] };
}

export async function handleLog(
  deps: CommandDeps,
  r: Refreshed,
  name: string | undefined,
  n = 10,
  json = false,
): Promise<HandlerResult> {
  if (!name) return { lines: ["log needs a name — /automations log <name> [n]"], exitCode: 2 };

  const match = resolveName(r.statuses, name);
  if (match.kind === "none") return { lines: [notFoundLine(name)], exitCode: 2 };
  if (match.kind === "ambiguous") {
    return { lines: [ambiguousLine(name, match.matches, deps.home)], exitCode: 2 };
  }

  const records = readRecords(deps.stateDir, match.status.key, n);
  const key = match.status.key;
  const fireTail = readFireLogTail(deps.stateDir, key);

  // Provider faults live in the fire log, not the record; fold them back in by run id.
  const problemsFor = (rec: RunRecord): string[] =>
    rec.id ? foldRunProblems(fireTail, rec.id) : [];

  if (json) {
    return {
      lines: records.map((rec) => {
        const problems = problemsFor(rec);
        // Only when there are any, so an ordinary record is unchanged.
        return JSON.stringify(problems.length > 0 ? { ...rec, problems } : rec);
      }),
    };
  }
  if (records.length === 0) return { lines: [`${match.status.name} has not run yet`] };

  return {
    lines: records.flatMap((rec) => {
      const problems = problemsFor(rec);
      const shown = problems.slice(0, PROBLEMS_SHOWN);
      const width = deps.width ?? 96;
      return [
        logLine(rec),
        ...shown.map((p) => truncateToWidth(`${" ".repeat(18)}provider: ${p}`, width)),
        ...(problems.length > shown.length
          ? [
              truncateToWidth(
                `${" ".repeat(18)}and ${problems.length - shown.length} more`,
                width,
              ),
            ]
          : []),
        ...(rec.pluginProblems ?? []).map((p) => truncateToWidth(`${" ".repeat(18)}${p}`, width)),
        ...noteLogLines(rec, width),
      ];
    }),
  };
}

/** What a run published: its message, then each note, each with its links in full. URLs are never cut. */
export function noteLogLines(rec: RunRecord, width: number): string[] {
  const out: string[] = [];
  const items = [...(rec.message ? [{ word: "message", ...rec.message }] : []), ...(rec.notes ?? []).map((n) => ({ word: "note", ...n }))];
  for (const item of items) {
    out.push(truncateToWidth(`${" ".repeat(18)}${item.word}: ${stripControls(item.text.replace(/\s+/g, " ")).trim()}`, width));
    for (const l of item.links) out.push(stripControls(`${" ".repeat(24)}${l.label ? `${l.label}: ` : ""}${l.url}`));
  }
  return out;
}

export { localStamp };

/** An automation's last `n` runs, oldest first, each with what a provider reported about it. */
export function logRuns(deps: Pick<CommandDeps, "stateDir">, key: string, n = 10): { record: RunRecord; problems: string[] }[] {
  const records = readRecords(deps.stateDir, key, n);
  const fireTail = readFireLogTail(deps.stateDir, key);
  return records.map((record) => ({ record, problems: record.id ? foldRunProblems(fireTail, record.id) : [] }));
}

/** Everything the check page shows about one automation, gathered once. */
export function checkFacts(deps: CommandDeps, r: Refreshed, s: Status, watcher?: WatcherFacts): CheckFacts {
  const l = r.byKey.get(s.key);
  const now = deps.now();
  let digest: string | undefined;
  let interpreters: Record<string, string> | undefined;
  if (l) {
    try {
      digest = digestOf(l);
    } catch (e) {
      digest = oneLine(e);
    }
    try {
      interpreters = interpreterMap(l, deps.platform);
    } catch {
      interpreters = undefined;
    }
  }
  const nextRuns: string[] = [];
  const schedule = l?.automation.on.schedule;
  if (schedule) {
    let cursor = now;
    for (let i = 0; i < 3; i++) {
      const next = nextTick(schedule, cursor);
      if (!next) break;
      nextRuns.push(next.toISOString());
      cursor = next;
    }
  }
  return {
    status: s,
    now,
    home: deps.home,
    config: deps.config,
    records: readRecords(deps.stateDir, s.key, 7),
    ...(interpreters ? { interpreters } : {}),
    ...(digest ? { digest } : {}),
    nextRuns,
    ...(watcher ? { watcher } : {}),
  };
}

export function logLine(rec: RunRecord): string {
  const at = rec.endedAt ?? rec.startedAt ?? rec.recordedAt;
  const when = localStamp(at);
  const duration =
    rec.startedAt && rec.endedAt
      ? formatDuration(Date.parse(rec.endedAt) - Date.parse(rec.startedAt))
      : "—";

  // What happened; the session file path is in `--json`.
  return [
    when.padEnd(16),
    rec.outcome.padEnd(8),
    duration.padEnd(7),
    summaryLine(rec, 96),
  ]
    .join("  ")
    .trimEnd();
}

export async function handleCheck(
  deps: CommandDeps,
  r: Refreshed,
  name: string | undefined,
): Promise<HandlerResult> {
  if (!name) {
    const lines = r.statuses
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => `${s.name}  ${s.state}${s.reason ? `  — ${s.reason}` : ""}`);
    return { lines: lines.length ? lines : ["no automations found"] };
  }

  const match = resolveName(r.statuses, name);
  if (match.kind === "none") return { lines: [notFoundLine(name)], exitCode: 2 };
  if (match.kind === "ambiguous") {
    return { lines: [ambiguousLine(name, match.matches, deps.home)], exitCode: 2 };
  }

  const s = match.status;
  const l = r.byKey.get(s.key);
  const lines: string[] = [];
  lines.push(`${s.name}  ${s.state}`);
  if (s.problems && s.problems.length > 0) {
    const [field] = (s.reason ?? "").split(":", 1);
    lines.push(`  reason        ${field}: ${s.problems.length} problem${s.problems.length === 1 ? "" : "s"}`);
    for (const p of s.problems) lines.push(`    ${p}`);
  } else if (s.reason) lines.push(`  reason        ${s.reason}`);
  lines.push(`  scope         ${s.scope}`);
  lines.push(`  directory     ${tildify(s.dir, deps.home)}`);
  lines.push(`  key           ${s.key}`);

  if (l) {
    lines.push(`  model         ${s.resolvedModel?.display ?? l.automation.model ?? "host default"}`);
    lines.push(`  timeout       ${timeoutText(s, deps.config)}`);
    lines.push(`  stagger       ${s.staggerSec}s`);

    try {
      lines.push(`  digest        ${digestOf(l)}`);
    } catch (e) {
      lines.push(`  digest        ${oneLine(e)}`);
    }

    const interpreters = interpreterMap(l, deps.platform);
    for (const [script, cmd] of Object.entries(interpreters)) {
      lines.push(`  interpreter   ${script} → ${cmd}`);
    }

    const schedule = l.automation.on.schedule;
    if (schedule) {
      lines.push(`  schedule      ${schedule.cron}${schedule.timezone ? ` · ${schedule.timezone}` : ""}`);
      let cursor = deps.now();
      for (let i = 0; i < 3; i++) {
        const next = nextTick(schedule, cursor);
        if (!next) break;
        const shifted = new Date(next.getTime() + s.staggerSec * 1000);
        lines.push(`  next          ${shifted.toISOString()}  (${shifted.toLocaleString()})`);
        cursor = next;
      }
    }

    const watch = l.automation.on.watch;
    if (watch) {
      lines.push(`  watch         ${watch.script} every ${watch.every}`);
      lines.push(...watchDetail(s, deps.now()).map((line) => `  ${line}`));
    }
  }

  return { lines };
}

/** `watch`: list watches, dry-run one, or pause/resume its checks. */
export async function handleWatch(
  deps: CommandDeps,
  r: Refreshed,
  name: string | undefined,
  verb?: string,
): Promise<HandlerResult> {
  const now = deps.now();

  if (verb === "pause" || verb === "resume") return pauseOrResume(deps, r, name, verb, now);

  if (!name) {
    const watching = r.statuses
      .filter((s) => s.automation?.on.watch)
      .sort((a, b) => a.name.localeCompare(b.name));
    const lines = [backgroundLine(deps.stateDir, now)];
    if (watching.length === 0) {
      lines.push("no automation has a watch — add on.watch with script and every");
      return { lines };
    }
    for (const s of watching) {
      const w = s.automation?.on.watch;
      if (!w) continue;
      lines.push("");
      lines.push(`${s.name}  ${s.state}${s.reason ? `  — ${s.reason}` : ""}`);
      lines.push(`  watch         ${w.script} every ${w.every}`);
      lines.push(...watchDetail(s, now).map((line) => `  ${line}`));
    }
    return { lines };
  }

  const match = resolveName(r.statuses, name);
  if (match.kind === "none") return { lines: [notFoundLine(name)], exitCode: 2 };
  if (match.kind === "ambiguous") {
    return { lines: [ambiguousLine(name, match.matches, deps.home)], exitCode: 2 };
  }

  const s = match.status;
  const l = r.byKey.get(s.key);
  const watch = l?.automation.on.watch;
  if (!l || !watch) {
    return { lines: [`${s.name}: has no watch — add on.watch with script and every`], exitCode: 2 };
  }
  if (s.state === "invalid") return { lines: [`${s.name}: ${s.reason ?? "invalid"}`], exitCode: 2 };
  // A repository's script runs only after consent; a dry run is still a run of it.
  const off = deps.trust.offReason(l, now);
  if (off !== undefined) {
    return { lines: [`${s.name}: ${off} — its watch script runs only once it is armed`], exitCode: 2 };
  }

  const prev = readWatchState(deps.stateDir, s.key);
  const check = await runWatchScript(l, {
    config: deps.config,
    ...(deps.runScript ? { runScript: deps.runScript } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(prev?.answeredAt ? { lastChecked: prev.answeredAt } : {}),
  });
  const decision = decideWatch(prev, check, now);

  const lines = [
    `${s.name}: ran ${watch.script} in ${formatDuration(check.durationMs)} — nothing was started or recorded`,
    `  result        ${check.problem ?? `exit ${check.exit}`}`,
    `  a tick would  ${decision.fire ? "start a run: it found something new" : `not start a run: ${decision.because}`}`,
  ];
  const out = check.stdout.trim() === "" ? [] : check.stdout.replace(/\s+$/, "").split(/\r?\n/);
  if (out.length > 0) {
    lines.push("  output");
    for (const line of out.slice(0, 20)) lines.push(`    ${line}`);
    if (out.length > 20) lines.push(`    … ${out.length - 20} more lines`);
  }
  const err = check.stderr.replace(/\s+$/, "").split(/\r?\n/).filter(Boolean);
  if (err.length > 0 && check.exit !== 0) {
    lines.push("  stderr");
    for (const line of err.slice(-5)) lines.push(`    ${line}`);
  }
  if (s.state === "disabled") lines.push("  this automation is disabled, so no tick runs this check");
  if (s.watchPausedAt) lines.push(`  this watch is paused, so no tick runs this check — watch resume ${s.name}`);

  // Like a run: 0 would start one, 10 nothing to start, 20 could not check.
  return { lines, exitCode: decision.fire ? 0 : check.problem !== undefined ? 20 : 10 };
}

async function pauseOrResume(
  deps: CommandDeps,
  r: Refreshed,
  name: string | undefined,
  verb: "pause" | "resume",
  now: Date,
): Promise<HandlerResult> {
  if (!name) return { lines: [`watch ${verb} needs a name — watch ${verb} <name>`], exitCode: 2 };
  const match = resolveName(r.statuses, name);
  if (match.kind === "none") return { lines: [notFoundLine(name)], exitCode: 2 };
  if (match.kind === "ambiguous") {
    return { lines: [ambiguousLine(name, match.matches, deps.home)], exitCode: 2 };
  }
  const s = match.status;
  const a = s.automation;
  if (!a?.on.watch) return { lines: [`${s.name}: has no watch to ${verb}`], exitCode: 2 };

  let changed = false;
  deps.state.update((state) => {
    changed = verb === "pause" ? state.pauseWatch(s.key, now) : state.resumeWatch(s.key);
  });

  if (verb === "pause") {
    if (!changed) {
      const since = deps.state.watchPausedAt(s.key);
      return { lines: [`${s.name}: its watch was already paused${since ? ` since ${clockAgo(since, now)}` : ""}`] };
    }
    const still = [a.on.schedule ? "its schedule" : "", a.on.manual ? "running it by hand" : ""].filter(Boolean);
    return {
      lines: [
        `${s.name}: watch paused — no more checks until you resume it${still.length ? `; ${still.join(" and ")} still work${still.length > 1 ? "" : "s"}` : ""}`,
      ],
    };
  }

  if (!changed) return { lines: [`${s.name}: its watch was not paused`] };
  const next = s.watch && Date.parse(s.watch.checkedAt) + everyMs(a.on.watch) > now.getTime()
    ? `next check ${clockAgo(new Date(Date.parse(s.watch.checkedAt) + everyMs(a.on.watch)).toISOString(), now)}`
    : "it checks at the next tick";
  const lines = [`${s.name}: watch resumed — ${next}`];
  if (!installedPaths(deps.stateDir)) lines.push(backgroundLine(deps.stateDir, now));
  return { lines };
}

/** The lines that say how one watch is doing: its last check, its last run, its next check. */
function watchDetail(s: Status, now: Date): string[] {
  const lines: string[] = [];
  const w: WatchState | undefined = s.watch;
  if (w) {
    const result = w.problem !== undefined ? w.problem : `exit ${w.exit}`;
    lines.push(
      `last check    ${clockAgo(w.checkedAt, now)} · ${result} · ${formatDuration(w.durationMs)}${w.said ? ` · ${w.said}` : ""}`,
    );
    lines.push(`last started  ${w.firedAt ? clockAgo(w.firedAt, now) : "never"}`);
  } else {
    lines.push("last check    never");
  }
  if (s.watchPausedAt) lines.push(`paused        since ${clockAgo(s.watchPausedAt, now)} — watch resume ${s.name} starts it again`);
  if (s.running) lines.push("next check    after the run that is going now");
  else if (s.watchPausedAt) lines.push("next check    none — paused");
  else if (s.state !== "armed") lines.push(`next check    none — ${s.state}`);
  else if (s.nextCheck) {
    const due = Date.parse(s.nextCheck) <= now.getTime();
    lines.push(`next check    ${due ? "at the next tick" : clockAgo(s.nextCheck, now)}`);
  }
  return lines;
}

/** `2026-10-07 12:05 (4m ago)` / `12:10 (in 1m)` */
function clockAgo(iso: string, now: Date): string {
  const at = new Date(iso);
  const ms = at.getTime() - now.getTime();
  const span = formatDuration(Math.abs(ms)) || "0s";
  const clock = at.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${clock} (${ms >= 0 ? `in ${span}` : `${span} ago`})`;
}

/** Nothing checks a watch until the watcher is on, so say that first. */
function backgroundLine(dir: string, now: Date): string {
  const job = installedPaths(dir);
  if (!job) {
    return "watcher off — nothing runs these checks until you start it: pa watcher start, or w in /automations";
  }
  const last = readJson<StateFile>(statePaths(dir).state)?.lastTickAt;
  const age = last ? `last tick ${formatDuration(Math.max(0, now.getTime() - Date.parse(last)))} ago` : "no tick yet";
  return `watcher on: ${job.jobName} (${job.method}) · ${age}`;
}

export async function handleRun(
  deps: CommandDeps,
  r: Refreshed,
  name: string | undefined,
  /** `flow: true` tracks this run on a flowchart even if the automation would not normally be. */
  opts: { flow?: boolean } = {},
): Promise<HandlerResult> {
  if (!name) return { lines: ["run needs a name — /automations run <name>"], exitCode: 2 };

  const match = resolveName(r.statuses, name);
  if (match.kind === "none") return { lines: [notFoundLine(name)], exitCode: 2 };
  if (match.kind === "ambiguous") {
    return { lines: [ambiguousLine(name, match.matches, deps.home)], exitCode: 2 };
  }

  const s = match.status;

  if (s.running) {
    return { lines: [`still running since ${s.running.startedAt}`], exitCode: 10 };
  }
  if (s.state === "invalid") {
    return { lines: [`${s.name}: ${s.reason ?? "invalid"}`], exitCode: 2 };
  }
  if (s.state === "disabled") {
    // enabled: false is the whole-automation switch, so a manual run is refused too.
    return {
      lines: [`${s.name}: enabled: false — remove it or set it true to run this automation`],
      exitCode: 2,
    };
  }
  if (!s.automation?.on.manual) {
    return {
      lines: [`${s.name}: has no manual trigger — add "manual: true" under on:`],
      exitCode: 2,
    };
  }

  // An unconsented automation shows the preview so it can be armed and run in one step.
  if (s.state === "off") {
    const l = r.byKey.get(s.key);
    if (!l) return { lines: [notFoundLine(name)], exitCode: 2 };
    return {
      lines: [],
      consent: {
        status: s,
        located: l,
        preview: consentPreview(s, l, deps, "Arm and run"),
        andRun: true,
      },
    };
  }

  const l = r.byKey.get(s.key);
  const args = [s.key, "--manual", ...(opts.flow ? ["--flow"] : [])];
  const code = await deps.spawnFire(args, {
    attached: true,
    ...(l ? { located: l } : {}),
  });
  return { lines: [], exitCode: code };
}

export async function handleReport(
  deps: CommandDeps,
  r: Refreshed,
  open: boolean,
): Promise<HandlerResult> {
  const now = deps.now();
  const recordsByKey: Record<string, RunRecord[]> = {};
  for (const s of r.statuses) {
    recordsByKey[s.key] = readRecords(deps.stateDir, s.key, 20);
  }

  const html = renderReport(r.statuses, recordsByKey, deps.config, now, {
    home: deps.home,
    flowSvgFor: reportFlowArt(deps),
  });

  const dir = statePaths(deps.stateDir).reports;
  ensureDir(dir);
  const file = path.join(dir, `${now.toISOString().slice(0, 10)}.html`);

  try {
    writeFileSync(file, html);
  } catch (e) {
    return { lines: [`could not write the report — ${oneLine(e)}`], exitCode: 2 };
  }

  const lines = [file];
  if (open) {
    const cmd = openCommand(file, deps.platform);
    try {
      const { spawn } = await import("node:child_process");
      spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch {
      lines.push("could not open it automatically");
    }
  }
  return { lines };
}

/** The command list, including what `e` does here and every plugin action. */
export function helpLines(plugins: { edit?: string; actions?: readonly { id: string; label: string }[] } = {}): string[] {
  const col = (left: string, right: string) => `${left.padEnd(32)}${right}`;
  return [
    "/automations                    list every automation, grouped by scope",
    "/automations run <name>         run one now",
    "/automations running            every run in flight, with its steps",
    "/automations arm <name>         arm it, after the consent preview",
    "/automations disarm <name>      withdraw consent; it stays listed",
    "/automations enable <name>      set enabled: true in a user automation",
    "/automations disable <name>     set enabled: false in a user automation",
    "/automations runs <name> [n]    the last n runs, with their notes and links",
    "/automations log <name> [n]     the same as runs",
    "/automations check [name]       re-check everything, or show one in detail",
    "/automations watch [name]       every watch and its last check, or run one check now",
    "/automations watch pause <name> stop its checks until resumed; its schedule and manual runs still work",
    "/automations watch resume <name>",
    col("/automations edit <name>", plugins.edit ?? "open its AUTOMATION.md in your editor"),
    ...(plugins.actions ?? []).filter((a) => a.id !== "edit").map((a) => col(`/automations ${a.id} <name>`, a.label)),
    "/automations report [--open]    write an HTML report",
    "/automations watcher <verb>     start | stop | status — the watcher, which fires schedules",
    "                                and runs watch checks, with pi open or closed",
    "/automations help               this list",
  ];
}
