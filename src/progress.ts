// Where a tracked run has got to, recorded by the run and by whatever it starts. One append-only
// events file per run (`<state>/progress/<runId>.jsonl`), folded into the run record at the end.
// Any process with `AUTOMATION_RUN` can report through `pa step|next|say|note|message`. Writes take
// a short lock and check preconditions inside it, so concurrent writers cannot both move a node;
// retries converge, and `--request-id` makes `say`/`note`/`message` exactly-once. Reads take no
// lock. A finished run leaves a `<runId>.closed` tombstone so stragglers hear RUN_CLOSED; swept
// after a week.

import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { flowOrder, parseChart, successorsOf } from "./chart.js";
import type {
  ChartRenderState,
  EnvironmentOverlay,
  FlowTracking,
  StartFlowTracking,
} from "./core/contracts.js";
import { oneLine } from "./errors.js";
import { planFromAutomation, readFlowPlan } from "./flow-plan.js";
import { withFileLock } from "./locks.js";
import { isReservedNode } from "./nodes.js";
import { paPathOverlay } from "./pa-launcher.js";
import { ensureDir, statePaths } from "./paths.js";
import { stripControls } from "./ui/width.js";
import type {
  RunLink,
  RunMessage,
  RunNote,
  RunProgress,
  RunRecord,
  RunStep,
  StepStatus,
} from "./types.js";

/** How much text one message or note keeps. Longer is cut, with a warning, never refused. */
export const TEXT_MAX = 4000;

/** The states `pa step --status` may set. `pending` and `interrupted` belong to the run. */
export const SETTABLE: readonly StepStatus[] = ["active", "waiting", "done", "failed", "skipped"];

const RUNNING: ReadonlySet<StepStatus> = new Set(["active", "waiting"]);
const SETTLED: ReadonlySet<StepStatus> = new Set(["done", "failed", "skipped", "interrupted"]);

const TOMBSTONE_MS = 7 * 24 * 60 * 60_000;

/** Every way a progress write can be refused, as a stable code a script can branch on. */
export type ProgressCode =
  | "USAGE"
  | "NO_RUN"
  | "UNKNOWN_RUN"
  | "RUN_CLOSED"
  | "NO_CHART"
  | "UNKNOWN_NODE"
  | "AMBIGUOUS_NODE"
  | "AMBIGUOUS_ACTIVE"
  | "NO_ACTIVE"
  | "NOT_AN_EDGE"
  | "BAD_LINK"
  | "LOCK_TIMEOUT"
  | "IO";

export class ProgressError extends Error {
  constructor(
    readonly code: ProgressCode,
    message: string,
    readonly suggestions: string[] = [],
  ) {
    super(message);
  }
}

export interface ProgressNode {
  id: string;
  label: string;
  status: StepStatus;
  /** The last message, or null. Null rather than absent so it fits the chart readers' shape. */
  text: string | null;
  startedAt?: string;
  endedAt?: string;
  successors: string[];
}

export interface ProgressSnapshot {
  run: string;
  key: string;
  name: string;
  chart: string;
  /** `flow: strict`: `pa next` must follow an arrow of the flowchart, except between hooks and the body. */
  strict?: true;
  openedAt: string;
  nodes: ProgressNode[];
  taken: [string, string][];
  notes: RunNote[];
  /** The last `pa message`; a later one replaces it. */
  message?: RunMessage;
  closed: boolean;
  /** How many events have been applied. Moves on every change, so it keys a render cache. */
  revision: number;
}

export interface ProgressResult {
  /** False when the write was a retry of something already recorded, and nothing was appended. */
  changed: boolean;
  warnings: string[];
  snapshot: ProgressSnapshot;
  /** The node the write landed on, when it was about one. */
  node?: ProgressNode;
  /** For `next`: the node it came from. */
  from?: ProgressNode;
}

type Event =
  | {
      t: "open";
      run: string;
      key: string;
      name: string;
      at: string;
      chart: string;
      strict?: true;
    }
  | { t: "step"; node: string; status: StepStatus; text?: string; at: string }
  | { t: "next"; from: string; to: string; text?: string; at: string }
  | { t: "say"; node: string; text: string; rid?: string; at: string }
  | { t: "note"; text: string; links: RunLink[]; rid?: string; at: string }
  | { t: "message"; text: string; links: RunLink[]; rid?: string; at: string }
  | { t: "close"; outcome: string; at: string };

// ------------------------------------------------------------------------------- paths

/** A run id is used as a file name, so it is held to the shape `newRunId` produces and no more. */
export function validRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(runId) && !runId.includes("..");
}

function requireRunId(runId: string | undefined): string {
  if (!runId) {
    throw new ProgressError(
      "NO_RUN",
      "not inside a run — AUTOMATION_RUN is not set (or pass --run <id>)",
    );
  }
  if (!validRunId(runId)) throw new ProgressError("UNKNOWN_RUN", `not a run id: ${runId}`);
  return runId;
}

export function progressFile(stateDir: string, runId: string): string {
  return path.join(statePaths(stateDir).progress, `${runId}.jsonl`);
}

function tombstoneFile(stateDir: string, runId: string): string {
  return path.join(statePaths(stateDir).progress, `${runId}.closed`);
}

function lockFile(stateDir: string, runId: string): string {
  return path.join(statePaths(stateDir).progress, `${runId}.lock`);
}

// ------------------------------------------------------------------------------- folding

function readEvents(file: string): Event[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Event[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch {
    }
  }
  return out;
}

function setStatus(node: ProgressNode, status: StepStatus, at: string): void {
  node.status = status;
  if (RUNNING.has(status)) {
    node.startedAt ??= at;
    delete node.endedAt;
  } else if (SETTLED.has(status)) {
    node.endedAt = at;
  }
}

/** Replay the events into where the run is now. `undefined` when there is no `open`. */
export function foldEvents(events: readonly Event[]): ProgressSnapshot | undefined {
  const open = events[0];
  if (!open || open.t !== "open") return undefined;

  const chart = parseChart(open.chart);
  const nodes = flowOrder(chart).map(
    (n): ProgressNode => ({
      id: n.id,
      label: n.label,
      status: "pending",
      text: null,
      successors: successorsOf(chart, n.id),
    }),
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const snap: ProgressSnapshot = {
    run: open.run,
    key: open.key,
    name: open.name,
    chart: open.chart,
    ...(open.strict ? { strict: true as const } : {}),
    openedAt: open.at,
    nodes,
    taken: [],
    notes: [],
    closed: false,
    revision: events.length,
  };

  for (const e of events.slice(1)) {
    switch (e.t) {
      case "step": {
        const n = byId.get(e.node);
        if (!n) break;
        setStatus(n, e.status, e.at);
        if (e.text !== undefined) n.text = e.text;
        break;
      }
      case "next": {
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from || !to) break;
        if (!SETTLED.has(from.status)) setStatus(from, "done", e.at);
        setStatus(to, "active", e.at);
        if (e.text !== undefined) to.text = e.text;
        if (!snap.taken.some(([a, b]) => a === e.from && b === e.to)) snap.taken.push([e.from, e.to]);
        break;
      }
      case "say": {
        const n = byId.get(e.node);
        if (n) n.text = e.text;
        break;
      }
      case "note":
        snap.notes.push({ ts: e.at, text: e.text, links: e.links });
        break;
      case "message":
        snap.message = { ts: e.at, text: e.text, links: e.links };
        break;
      case "close":
        snap.closed = true;
        // A node still going when the run ended did not finish; saying so is the honest answer.
        for (const n of nodes) if (RUNNING.has(n.status)) setStatus(n, "interrupted", e.at);
        break;
    }
  }
  return snap;
}

export function readProgress(stateDir: string, runId: string): ProgressSnapshot | undefined {
  if (!validRunId(runId)) return undefined;
  return foldEvents(readEvents(progressFile(stateDir, runId)));
}

export function chartState(snap: ProgressSnapshot): ChartRenderState {
  const nodes: Record<string, string> = {};
  for (const n of snap.nodes) nodes[n.id] = n.status;
  return { nodes, taken: snap.taken.map(([a, b]) => [a, b] as [string, string]) };
}

export function progressOf(snap: ProgressSnapshot): RunProgress {
  return {
    chart: snap.chart,
    steps: snap.nodes.map(
      (n): RunStep => ({
        id: n.id,
        label: n.label,
        status: n.status,
        ...(n.text !== null ? { text: n.text } : {}),
        ...(n.startedAt ? { startedAt: n.startedAt } : {}),
        ...(n.endedAt ? { endedAt: n.endedAt } : {}),
      }),
    ),
    taken: snap.taken.map(([a, b]) => [a, b] as [string, string]),
    notes: snap.notes.map((n) => ({ ...n, links: n.links.map((l) => ({ ...l })) })),
    ...(snap.message ? { message: { ...snap.message, links: snap.message.links.map((l) => ({ ...l })) } } : {}),
  };
}

/** Put what a run reported onto its record. Empty lists, and a chart it never had, are left off. */
export function withProgress(rec: RunRecord, progress: RunProgress): RunRecord {
  return {
    ...rec,
    ...(progress.chart ? { chart: progress.chart, steps: progress.steps } : {}),
    ...(progress.taken.length > 0 ? { taken: progress.taken } : {}),
    ...(progress.notes.length > 0 ? { notes: progress.notes } : {}),
    ...(progress.message ? { message: progress.message } : {}),
  };
}

/** A finished run's progress rebuilt from its record, so history draws like a live run. */
export function snapshotFromRecord(rec: RunRecord): ProgressSnapshot | undefined {
  if (!rec.chart || !rec.steps) return undefined;
  const chart = parseChart(rec.chart);
  const steps = new Map(rec.steps.map((s) => [s.id, s]));
  const ids = [...flowOrder(chart).map((n) => n.id), ...rec.steps.map((s) => s.id)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  const labels = new Map(chart.nodes.map((n) => [n.id, n.label]));
  return {
    run: rec.id,
    key: rec.key,
    name: rec.name,
    chart: rec.chart,
    openedAt: rec.startedAt ?? rec.recordedAt,
    nodes: ids.map((id): ProgressNode => {
      const s = steps.get(id);
      return {
        id,
        label: s?.label ?? labels.get(id) ?? id,
        status: s?.status ?? "pending",
        text: s?.text ?? null,
        ...(s?.startedAt ? { startedAt: s.startedAt } : {}),
        ...(s?.endedAt ? { endedAt: s.endedAt } : {}),
        successors: successorsOf(chart, id),
      };
    }),
    taken: (rec.taken ?? []).map(([a, b]) => [a, b] as [string, string]),
    notes: rec.notes ?? [],
    ...(rec.message ? { message: rec.message } : {}),
    closed: true,
    revision: 0,
  };
}

// ------------------------------------------------------------------------------- writing

function commit(file: string, events: readonly Event[], event: Event): ProgressSnapshot {
  appendFileSync(file, `${JSON.stringify(event)}\n`);
  return foldEvents([...events, event]) as ProgressSnapshot;
}

// Strip control characters (except tab and newline) and cap at TEXT_MAX.
function clamp(raw: string, warnings: string[]): string {
  const text = stripControls(raw, true);
  if (text.length <= TEXT_MAX) return text;
  warnings.push(`text was ${text.length} characters; kept the first ${TEXT_MAX}`);
  return text.slice(0, TEXT_MAX);
}

function loadOpen(stateDir: string, runId: string): { file: string; events: Event[]; snap: ProgressSnapshot } {
  const file = progressFile(stateDir, runId);
  const events = readEvents(file);
  const snap = foldEvents(events);
  if (!snap) {
    let closed = false;
    try {
      statSync(tombstoneFile(stateDir, runId));
      closed = true;
    } catch {
    }
    if (closed) throw new ProgressError("RUN_CLOSED", `run ${runId} has ended; its progress is in its run record`);
    throw new ProgressError("UNKNOWN_RUN", `no run ${runId} here`);
  }
  if (snap.closed) throw new ProgressError("RUN_CLOSED", `run ${runId} has ended`);
  return { file, events, snap };
}

function underLock<T>(stateDir: string, runId: string, fn: () => T): T {
  try {
    return withFileLock(lockFile(stateDir, runId), fn);
  } catch (e) {
    if (e instanceof ProgressError) throw e;
    if ((e as { code?: string })?.code === "LOCK_TIMEOUT") {
      throw new ProgressError("LOCK_TIMEOUT", oneLine(e));
    }
    throw new ProgressError("IO", oneLine(e));
  }
}

function requireChart(snap: ProgressSnapshot): void {
  if (snap.nodes.length === 0) {
    throw new ProgressError(
      "NO_CHART",
      "this run has no flowchart, so it has no nodes to move — only `pa note`, `pa message` and `pa status` work here",
    );
  }
}

function describe(n: { id: string; label: string }): string {
  return n.label !== n.id ? `${n.id} ("${n.label}")` : n.id;
}

function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n] as number;
}

export function resolveNode(snap: ProgressSnapshot, ref: string): ProgressNode {
  const byId = snap.nodes.find((n) => n.id === ref);
  if (byId) return byId;
  const byLabel = snap.nodes.filter((n) => n.label === ref);
  if (byLabel.length === 1) return byLabel[0] as ProgressNode;
  if (byLabel.length > 1) {
    throw new ProgressError(
      "AMBIGUOUS_NODE",
      `"${ref}" is the label of ${byLabel.length} nodes; use an id`,
      byLabel.map((n) => n.id),
    );
  }
  const want = ref.toLowerCase();
  const close = snap.nodes
    .map((n) => {
      const id = n.id.toLowerCase();
      const label = n.label.toLowerCase();
      const score =
        id.includes(want) || want.includes(id) || label.includes(want)
          ? 0
          : Math.min(distance(id, want), distance(label, want));
      return { n, score };
    })
    .filter((x) => x.score <= 2)
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((x) => describe(x.n));
  const suggestions = close.length > 0 ? close : snap.nodes.map(describe);
  throw new ProgressError("UNKNOWN_NODE", `no node "${ref}" on this run's chart`, suggestions);
}

/** The node a write is about when none was named: `AUTOMATION_NODE`, else the one running node. */
function defaultNode(snap: ProgressSnapshot, envNode: string | undefined, what: string): ProgressNode {
  if (envNode && envNode.trim() !== "") return resolveNode(snap, envNode.trim());
  const running = snap.nodes.filter((n) => RUNNING.has(n.status));
  if (running.length === 1) return running[0] as ProgressNode;
  if (running.length > 1) {
    throw new ProgressError(
      "AMBIGUOUS_ACTIVE",
      `${running.length} nodes are running; say which one with ${what}`,
      running.map(describe),
    );
  }
  throw new ProgressError("NO_ACTIVE", `no node is running; say which one with ${what}`);
}

function nodeIn(snap: ProgressSnapshot, node: ProgressNode): ProgressNode {
  return snap.nodes.find((n) => n.id === node.id) ?? node;
}

/** Strict flow: a move must follow an arrow, unless both ends are hooks or the body (the run's own). */
function requireEdge(from: ProgressNode, to: ProgressNode): void {
  if ((isReservedNode(from.id) && isReservedNode(to.id)) || from.successors.includes(to.id)) return;
  const next = from.successors;
  throw new ProgressError(
    "NOT_AN_EDGE",
    next.length > 0
      ? `the chart has no arrow ${from.id} → ${to.id}; from ${from.id} it goes to ${next.join(" or ")}`
      : `the chart has no arrow ${from.id} → ${to.id}; nothing follows ${from.id}`,
    next,
  );
}

/** Open a run's progress, once, before anything reports. Refuses an existing file. */
export function openProgress(
  stateDir: string,
  args: { runId: string; key: string; name: string; chart: string; strict?: boolean; now?: Date },
): ProgressSnapshot {
  const runId = requireRunId(args.runId);
  const dir = statePaths(stateDir).progress;
  ensureDir(dir);
  sweepTombstones(stateDir, args.now ?? new Date());

  const open: Event = {
    t: "open",
    run: runId,
    key: args.key,
    name: args.name,
    at: (args.now ?? new Date()).toISOString(),
    chart: args.chart,
    ...(args.strict ? { strict: true as const } : {}),
  };
  const fd = openSync(progressFile(stateDir, runId), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(open)}\n`);
  } finally {
    closeSync(fd);
  }
  return foldEvents([open]) as ProgressSnapshot;
}

export function progressStep(
  stateDir: string,
  runIdIn: string | undefined,
  args: { node: string; status?: StepStatus; text?: string; now?: Date },
): ProgressResult {
  const runId = requireRunId(runIdIn);
  const status = args.status ?? "active";
  if (!SETTABLE.includes(status)) {
    throw new ProgressError("USAGE", `--status must be one of ${SETTABLE.join("|")}`);
  }
  return underLock(stateDir, runId, () => {
    const { file, events, snap } = loadOpen(stateDir, runId);
    requireChart(snap);
    const node = resolveNode(snap, args.node);
    const warnings: string[] = [];
    const text = args.text !== undefined ? clamp(args.text, warnings) : undefined;
    const same = node.status === status && (text === undefined || node.text === text);
    if (same) return { changed: false, warnings, snapshot: snap, node };
    const at = (args.now ?? new Date()).toISOString();
    const after = commit(file, events, { t: "step", node: node.id, status, ...(text !== undefined ? { text } : {}), at });
    return { changed: true, warnings, snapshot: after, node: nodeIn(after, node) };
  });
}

export function progressNext(
  stateDir: string,
  runIdIn: string | undefined,
  args: { to: string; from?: string; envNode?: string; text?: string; now?: Date },
): ProgressResult {
  const runId = requireRunId(runIdIn);
  return underLock(stateDir, runId, () => {
    const { file, events, snap } = loadOpen(stateDir, runId);
    requireChart(snap);
    const to = resolveNode(snap, args.to);
    const from = args.from !== undefined ? resolveNode(snap, args.from) : defaultNode(snap, args.envNode, "--from");
    if (from.id === to.id) throw new ProgressError("USAGE", `next ${to.id} cannot come from itself`);
    if (snap.strict) requireEdge(from, to);
    const warnings: string[] = [];
    const text = args.text !== undefined ? clamp(args.text, warnings) : undefined;

    // A retry of a move already made: the arrow is taken, `from` has settled and `to` has started.
    const taken = snap.taken.some(([a, b]) => a === from.id && b === to.id);
    if (taken && SETTLED.has(from.status) && to.status !== "pending" && (text === undefined || to.text === text)) {
      return { changed: false, warnings, snapshot: snap, node: to, from };
    }
    const at = (args.now ?? new Date()).toISOString();
    const after = commit(file, events, { t: "next", from: from.id, to: to.id, ...(text !== undefined ? { text } : {}), at });
    return { changed: true, warnings, snapshot: after, node: nodeIn(after, to), from: nodeIn(after, from) };
  });
}

export function progressSay(
  stateDir: string,
  runIdIn: string | undefined,
  args: { text: string; node?: string; envNode?: string; requestId?: string; now?: Date },
): ProgressResult {
  const runId = requireRunId(runIdIn);
  if (args.text.trim() === "") throw new ProgressError("USAGE", "say needs some text");
  return underLock(stateDir, runId, () => {
    const { file, events, snap } = loadOpen(stateDir, runId);
    requireChart(snap);
    const node = args.node !== undefined ? resolveNode(snap, args.node) : defaultNode(snap, args.envNode, "--node");
    const warnings: string[] = [];
    const text = clamp(args.text, warnings);
    if (args.requestId && events.some((e) => e.t === "say" && e.rid === args.requestId)) {
      return { changed: false, warnings, snapshot: snap, node };
    }
    const at = (args.now ?? new Date()).toISOString();
    const after = commit(file, events, { t: "say", node: node.id, text, ...(args.requestId ? { rid: args.requestId } : {}), at });
    return { changed: true, warnings, snapshot: after, node: nodeIn(after, node) };
  });
}

/**
 * One link from the command line: `URL` or `label=URL`, split on the first `=` only when an http(s)
 * URL follows. The parsed `href` is kept, so control characters are percent-encoded.
 */
export function parseLink(raw: string): RunLink {
  const text = raw.trim();
  const eq = text.indexOf("=");
  let label: string | undefined;
  let url = text;
  if (eq > 0 && /^https?:\/\//i.test(text.slice(eq + 1).trim())) {
    label = stripControls(text.slice(0, eq)).trim();
    url = text.slice(eq + 1).trim();
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProgressError("BAD_LINK", `not a URL: ${raw} — use https://… or "label=https://…"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProgressError("BAD_LINK", `only http and https links are kept: ${raw}`);
  }
  return { ...(label ? { label } : {}), url: parsed.href };
}

export function progressNote(
  stateDir: string,
  runIdIn: string | undefined,
  args: { text: string; links?: readonly string[]; requestId?: string; now?: Date },
): ProgressResult {
  return writeLinked("note", stateDir, runIdIn, args);
}

/** The run's one message for its reader. A later message replaces this one. */
export function progressMessage(
  stateDir: string,
  runIdIn: string | undefined,
  args: { text: string; links?: readonly string[]; requestId?: string; now?: Date },
): ProgressResult {
  return writeLinked("message", stateDir, runIdIn, args);
}

function writeLinked(
  kind: "note" | "message",
  stateDir: string,
  runIdIn: string | undefined,
  args: { text: string; links?: readonly string[]; requestId?: string; now?: Date },
): ProgressResult {
  const runId = requireRunId(runIdIn);
  if (args.text.trim() === "") throw new ProgressError("USAGE", `${kind} needs some text`);
  // Every link is checked before anything is written: one bad link refuses the whole call.
  const links = (args.links ?? []).map(parseLink);
  return underLock(stateDir, runId, () => {
    const { file, events, snap } = loadOpen(stateDir, runId);
    const warnings: string[] = [];
    const text = clamp(args.text, warnings);
    if (args.requestId && events.some((e) => e.t === kind && e.rid === args.requestId)) {
      return { changed: false, warnings, snapshot: snap };
    }
    const at = (args.now ?? new Date()).toISOString();
    const after = commit(file, events, { t: kind, text, links, ...(args.requestId ? { rid: args.requestId } : {}), at });
    return { changed: true, warnings, snapshot: after };
  });
}

export function progressStatus(stateDir: string, runIdIn: string | undefined): ProgressSnapshot {
  const runId = requireRunId(runIdIn);
  const snap = readProgress(stateDir, runId);
  if (snap) return snap;
  try {
    statSync(tombstoneFile(stateDir, runId));
  } catch {
    throw new ProgressError("UNKNOWN_RUN", `no run ${runId} here`);
  }
  throw new ProgressError("RUN_CLOSED", `run ${runId} has ended; its progress is in its run record`);
}

/** Close a run's progress and return the fold. Removing the file is best effort. */
export function closeProgress(
  stateDir: string,
  runId: string,
  outcome: string,
  now: Date = new Date(),
): RunProgress | undefined {
  if (!validRunId(runId)) return undefined;
  if (!existsSync(progressFile(stateDir, runId))) return undefined;
  return underLock(stateDir, runId, () => {
    const file = progressFile(stateDir, runId);
    const events = readEvents(file);
    const before = foldEvents(events);
    if (!before) return undefined;
    const close: Event = { t: "close", outcome, at: now.toISOString() };
    let snap = before;
    if (!before.closed) {
      try {
        snap = commit(file, events, close);
      } catch {
        snap = foldEvents([...events, close]) as ProgressSnapshot;
      }
    }
    try {
      writeFileSync(tombstoneFile(stateDir, runId), JSON.stringify({ run: runId, outcome, at: close.at }));
    } catch {
    }
    try {
      rmSync(file, { force: true });
    } catch {
    }
    return progressOf(snap);
  });
}

/** Fold an abandoned run's progress into the `aborted` record the lock sweeper wrote for it. */
export function foldAbandoned(stateDir: string, rec: RunRecord, now: Date = new Date()): RunRecord {
  try {
    const progress = closeProgress(stateDir, rec.id, rec.outcome, now);
    return progress ? withProgress(rec, progress) : rec;
  } catch {
    return rec;
  }
}

/** Remove week-old tombstones and events files whose run already closed. */
export function sweepTombstones(stateDir: string, now: Date = new Date()): void {
  const dir = statePaths(stateDir).progress;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".closed")) continue;
    const file = path.join(dir, name);
    try {
      rmSync(path.join(dir, `${name.slice(0, -".closed".length)}.jsonl`), { force: true });
    } catch {
    }
    try {
      if (now.getTime() - statSync(file).mtimeMs > TOMBSTONE_MS) rmSync(file, { force: true });
    } catch {
    }
  }
}

// --- the run's own tracker

/** The environment that lets anything a run starts report to it (no node without a chart). */
export function progressEnvironment(args: {
  runId: string;
  stateDir: string;
  node?: string;
}): EnvironmentOverlay {
  return Object.freeze({
    ...paPathOverlay(args.stateDir),
    AUTOMATION_RUN: args.runId,
    AUTOMATION_STATE_DIR: args.stateDir,
    ...(args.node !== undefined ? { AUTOMATION_NODE: args.node } : {}),
  });
}

// The run's own moves. Unknown nodes are skipped; other failures go quiet after one report.
class ProgressTracker implements FlowTracking {
  private active: string | undefined;
  private started = false;
  private quiet = false;
  private known = new Set<string>();
  charted: boolean;

  constructor(
    private readonly stateDir: string,
    private readonly runId: string,
    private readonly key: string,
    private readonly name: string,
    private readonly chart: string | undefined,
    private readonly onProblem?: (message: string) => void,
    private readonly strict = false,
  ) {
    this.charted = chart !== undefined;
  }

  private fail(what: string, e: unknown): void {
    if (this.quiet) return;
    this.quiet = true;
    this.onProblem?.(`progress ${what}: ${e instanceof ProgressError ? `${e.code} ${e.message}` : oneLine(e)}`);
  }

  private live(node: string): boolean {
    return this.started && !this.quiet && this.known.has(node);
  }

  start(): string | undefined {
    try {
      const snap = openProgress(this.stateDir, {
        runId: this.runId,
        key: this.key,
        name: this.name,
        chart: this.chart ?? "",
        ...(this.strict ? { strict: true } : {}),
      });
      if (this.chart !== undefined && snap.nodes.length === 0) {
        this.onProblem?.("progress: the flowchart has no nodes, so only notes are kept");
      }
      this.charted = snap.nodes.length > 0;
      for (const n of snap.nodes) this.known.add(n.id);
      this.started = true;
      return this.runId;
    } catch (e) {
      this.fail("open", e);
      return undefined;
    }
  }

  next(node: string, message?: string): void {
    if (!this.live(node)) return;
    try {
      if (this.active && this.known.has(this.active)) {
        progressNext(this.stateDir, this.runId, {
          to: node,
          from: this.active,
          ...(message !== undefined ? { text: message } : {}),
        });
      } else {
        progressStep(this.stateDir, this.runId, { node, ...(message !== undefined ? { text: message } : {}) });
      }
      this.active = node;
    } catch (e) {
      this.fail("next", e);
    }
  }

  step(node: string, message?: string): void {
    if (!this.live(node)) return;
    try {
      progressStep(this.stateDir, this.runId, { node, ...(message !== undefined ? { text: message } : {}) });
      this.active = node;
    } catch (e) {
      this.fail("step", e);
    }
  }

  mark(node: string, status: "done" | "failed" | "skipped", message?: string): void {
    if (!this.live(node)) return;
    try {
      progressStep(this.stateDir, this.runId, { node, status, ...(message !== undefined ? { text: message } : {}) });
    } catch (e) {
      this.fail("mark", e);
    }
  }

  say(text: string, node?: string): void {
    const target = node ?? this.active;
    const trimmed = text.trim();
    if (!target || trimmed === "" || !this.live(target)) return;
    try {
      progressSay(this.stateDir, this.runId, { text: trimmed, node: target });
    } catch (e) {
      this.fail("say", e);
    }
  }

  end(status: "ok" | "failed" | "cancelled"): RunProgress | undefined {
    if (!this.started) return undefined;
    try {
      return closeProgress(this.stateDir, this.runId, status);
    } catch (e) {
      this.quiet = false;
      this.fail("close", e);
      return undefined;
    }
  }

  /** Name a node only when the chart has it, so defaulted `pa` calls find the running node. */
  environment(node: string): EnvironmentOverlay {
    return progressEnvironment({ runId: this.runId, stateDir: this.stateDir, ...(this.known.has(node) ? { node } : {}) });
  }

  guide(): string | undefined {
    if (!this.started) return undefined;
    return this.charted && this.chart !== undefined ? progressGuide(this.chart, this.strict) : notesGuide();
  }
}

/** Follow a run: notes always; chart moves when tracked. */
export const progressTracking: StartFlowTracking = (request) => {
  const own = readFlowPlan(request.context.automationDir);
  const optedIn = request.config.flowTracking[request.context.key] === true;
  const chart = own ?? (optedIn || request.force ? planFromAutomation(request.automation) : undefined);
  return new ProgressTracker(
    request.context.stateDir,
    request.context.runId,
    request.context.key,
    request.context.name,
    chart,
    request.onProblem,
    own !== undefined && request.automation.flow === "strict",
  );
};

// Bodies ask for receipts in plain words; this ties those words to the commands.
const RECEIPTS_LINE =
  "When the instructions ask you to record what you published or to leave a message, use these commands.";

export function notesGuide(): string {
  return [
    "<notes>",
    RECEIPTS_LINE,
    'If you publish anything or leave something for the reader, record it with `pa note "what it is" --link "label=https://…"` (AUTOMATION_RUN is already set).',
    messageLine(),
    "If `pa` fails, carry on.",
    "</notes>",
  ].join("\n");
}

/** One sentence: leave the reader one message with links before finishing. */
function messageLine(): string {
  return 'Before you finish, leave the reader ONE message: `pa message "what happened / what needs you" --link "label=https://…"`. Links matter most; a later message replaces the earlier one.';
}

export function progressGuide(chart: string, strict = false): string {
  const ids = flowOrder(parseChart(chart)).map((n) => n.id);
  return [
    "<progress>",
    "This run is tracked on its flowchart. Report where you are with `pa` (AUTOMATION_RUN is already set):",
    '- `pa step <node> [-m "text"] [--status active|waiting|done|failed|skipped]` — set one node (default active)',
    '- `pa next <to> --from <node> [-m "text"]` — finish <node> and start <to>',
    '- `pa say "text" [--node <node>]` — add an update to a node',
    '- `pa note "text" --link "label=https://…"` — a note on the run\'s record, with the links you published',
    "- `pa status` — where the run is; any command takes `--json`",
    `Nodes: ${ids.join(", ")} (or their exact labels).`,
    ...(strict
      ? ["Each `##` section is one step: start it with `pa next <id> --from <the step before>`, following the chart's arrows."]
      : []),
    "Subagents inherit AUTOMATION_RUN; set AUTOMATION_NODE=<its node> for each so its `pa say`/`pa next` land there.",
    RECEIPTS_LINE,
    messageLine(),
    "If `pa` fails, carry on.",
    "</progress>",
  ].join("\n");
}
