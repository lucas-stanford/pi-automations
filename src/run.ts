// One run, start to finish. Post hooks always run; every outcome leaves exactly one record.

import { existsSync } from "node:fs";

import { ms } from "./config.js";
import { bodyPrompt, lateLine, runHeader, type InputItem } from "./context.js";
import { previousTick } from "./cron.js";
import { digestOf } from "./digest.js";
import { formatDuration, parseDuration } from "./duration.js";
import { oneLine } from "./errors.js";
import { nodeIdFor } from "./nodes.js";
import { liveFile, LiveWriter } from "./live.js";
import { clipLine, clipOutput } from "./summary.js";
import { runPromptHook, runScriptHook, type RunInfo } from "./hooks.js";
import {
  acquireRunLock,
  cancelRequested,
  clearCancel,
  runLockInfo,
  updateRunLock,
} from "./locks.js";
import { classifyFireError } from "./model.js";
import { RunReporter, OBSERVE_POLL_MS } from "./plugins/lifecycle.js";
import type { RunObservers } from "./plugins/loader.js";
import { prepareLocalWorkspace } from "./providers/workspace.js";
import { appendFireEvent, appendRecord, newRunId } from "./records.js";
import type { State } from "./state.js";
import type { Trust } from "./trust.js";
import type {
  AutomationRuntime,
  FlowTracking,
  FlowTrackingRequest,
  PrepareWorkspace,
  Notify,
  RunContext,
  RunScript,
  RuntimeModelRef,
  StartFlowTracking,
  WorkspaceHandle,
  WorkspaceRequest,
} from "./core/contracts.js";
import type {
  Config,
  ErrorKind,
  FireEvent,
  Hook,
  HookResult,
  Located,
  Outcome,
  RunRecord,
  SessionReference,
  Trigger,
} from "./types.js";

export interface SessionHandle {
  prompt(text: string): Promise<string>;
  file: string;
  id: string;
  format?: string;
  dispose(): Promise<void> | void;
}

export interface FireOptions {
  trigger: Trigger;
  scheduledFor?: string;
  late?: boolean;
  runId?: string;
  now?: () => Date;
  emit?: (e: FireEvent) => void;
  /** Track this run on a flowchart even if the automation would not normally be. */
  forceFlow?: boolean;
}

export interface FireDeps {
  config: Config;
  stateDir: string;
  trust: Trust;
  /** Tick bookkeeping: claiming the covered instant stops catch-up from firing a duplicate. */
  state: State;
  /** Resolves the model and opens the session, so both come from the same SDK instance. */
  runtime: AutomationRuntime;
  prepareWorkspace?: PrepareWorkspace;
  startTracking?: StartFlowTracking;
  /** Runs hook scripts. Required, so a host that composed nothing never spawns processes. */
  runScript: RunScript;
  notify?: Notify;
  platform?: NodeJS.Platform;
  /** Overrides the hook timeout; tests use it to keep a sleeping script cheap. */
  hookTimeoutMs?: number;
  /** Bound for post-record integrations (workspace release, notification). Tests shorten it. */
  providerTimeoutMs?: number;
  /** Plugins told about this run. Their problems go on the record and never change the run. */
  observe?: RunObservers;
}

export const CANCEL_POLL_MS = 500;

/** Not "host stopped": that is what the stale-lock sweep writes. */
export const CANCEL_REASON = "stopped by request";

export async function fire(l: Located, opts: FireOptions, deps: FireDeps): Promise<RunRecord> {
  const runId = opts.runId ?? newRunId((opts.now ?? (() => new Date()))());
  const reporter = deps.observe
    ? new RunReporter(
        deps.observe,
        { runId, key: l.key, name: l.automation.name, scope: l.root.scope, trigger: opts.trigger },
        deps.stateDir,
      )
    : undefined;
  const record = await runOnce(l, { ...opts, runId }, deps, reporter);
  if (reporter) {
    for (const message of await reporter.end(record)) {
      const event: FireEvent = { event: "problem", message, runId };
      opts.emit?.(event);
      try {
        appendFireEvent(deps.stateDir, l.key, event);
      } catch {
      }
    }
  }
  return record;
}

async function runOnce(
  l: Located,
  opts: FireOptions & { runId: string },
  deps: FireDeps,
  reporter: RunReporter | undefined,
): Promise<RunRecord> {
  const clock = opts.now ?? (() => new Date());
  const started = clock();
  const runId = opts.runId;
  const emit = opts.emit ?? (() => {});
  // Record an integration diagnostic in the fire log without changing the outcome.
  let saidPersistFailed = false;
  const problem = (message: string) => {
    const event: FireEvent = { event: "problem", message, runId };
    emit(event);
    try {
      appendFireEvent(deps.stateDir, l.key, event);
    } catch (e) {
      // Reported once on the channel, never appended: appending is what just failed.
      if (saidPersistFailed) return;
      saidPersistFailed = true;
      emit({
        event: "problem",
        message: `could not record a diagnostic: ${oneLine(e)}`,
        runId,
      });
    }
  };

  const run: RunInfo = {
    runId,
    trigger: opts.trigger,
    late: opts.late ?? false,
    ...(opts.scheduledFor ? { scheduledFor: opts.scheduledFor } : {}),
  };

  emit({
    event: "start",
    runId,
    key: l.key,
    trigger: run.trigger,
    late: run.late,
    ...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
  });

  const timeoutMs = parseDuration(l.automation.timeout ?? "") ?? ms(deps.config, "defaultTimeout");
  const postHooks = l.automation.hooks.post.length;

  const base = (): RunRecord => ({
    id: runId,
    key: l.key,
    name: l.automation.name,
    scope: l.root.scope,
    root: l.root.path,
    trigger: run.trigger,
    late: run.late,
    recordedAt: clock().toISOString(),
    outcome: "ok",
    ...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
  });

  const finishEarly = (outcome: Outcome, reason: string): RunRecord => {
    const rec: RunRecord = { ...base(), outcome, reason, ...pluginProblems(reporter) };
    appendRecord(deps.stateDir, rec, deps.config.retention);
    emit({ event: "record", record: rec });
    return rec;
  };

  // --- one instance only -------------------------------------------------------------------
  const lock = acquireRunLock(
    deps.stateDir,
    runLockInfo({
      key: l.key,
      runId,
      timeoutMs,
      postHooks,
      trigger: run.trigger,
      now: started,
      ...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
    }),
  );

  if (!lock.ok) {
    return finishEarly("skipped", `still running since ${lock.held.startedAt}`);
  }

  let session: SessionHandle | undefined;
  let live: LiveWriter | undefined;
  let workspace: WorkspaceHandle | undefined;
  let closeFlow: (() => void) | undefined;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Stop requests are a polled file: on Windows SIGTERM kills the child and strands the lock.
  let cancelled = false;
  const cancelPoll = setInterval(() => {
    if (cancelled) return;
    if (!cancelRequested(deps.stateDir, l.key, run.runId)) return;
    cancelled = true;
    controller.abort();
  }, CANCEL_POLL_MS);
  cancelPoll.unref?.();
  const observePoll = reporter ? setInterval(() => reporter.poll(), OBSERVE_POLL_MS) : undefined;
  observePoll?.unref?.();

  try {
    // --- re-checks, because arm time was not now ------------------------------------------
    if (l.root.scope === "repository" && l.repoRoot && !existsSync(l.repoRoot)) {
      deps.trust.disarm(l);
      return finishEarly("skipped", `repository not found: ${l.repoRoot}`);
    }

    if (!deps.trust.record(l)) {
      return finishEarly("skipped", "not armed");
    }

    const { changed, files } = deps.trust.changedSinceArmed(l);
    if (changed) {
      deps.trust.disarm(l);
      return finishEarly(
        "skipped",
        files.length
          ? `changed since armed: ${files.join(", ")}`
          : "changed since armed",
      );
    }

    try {
      digestOf(l);
    } catch (e) {
      return finishEarly("skipped", oneLine(e));
    }

    // --- model -------------------------------------------------------------------------------
    let model: RuntimeModelRef;
    try {
      model = await deps.runtime.resolveModel(l.automation.model);
    } catch (e) {
      return finishEarly("skipped", oneLine(e));
    }

    const context = runContextFor(l, run, deps);

    let prepared: Awaited<ReturnType<PrepareWorkspace>>;
    try {
      prepared = await (deps.prepareWorkspace ?? prepareLocalWorkspace)(
        workspaceRequestFor(l, context, deps),
      );
    } catch (e) {
      // A throwing provider is a failed preparation and produces the same single record.
      prepared = {
        ok: false,
        failure: {
          kind: "workspace-preparation",
          detail: `the workspace provider failed: ${oneLine(e)}`,
        },
      };
    }
    if (!prepared.ok) {
      // Refuse a run whose requested isolation cannot be prepared, before claiming its instant.
      const ended = clock();
      const refusal: RunRecord = {
        ...base(),
        ...pluginProblems(reporter),
        startedAt: started.toISOString(),
        endedAt: ended.toISOString(),
        recordedAt: ended.toISOString(),
        outcome: "failed",
        error: {
          kind: "host",
          message: workspaceRefusalMessage({
            key: l.key,
            ...(prepared.failure.repository !== undefined
              ? { repository: prepared.failure.repository }
              : {}),
            ...(prepared.failure.intendedPath !== undefined
              ? { intended: prepared.failure.intendedPath }
              : {}),
            detail: prepared.failure.detail,
          }),
        },
      };

      // Persist first, so nobody is pointed at a history that does not mention this run yet.
      appendRecord(deps.stateDir, refusal, deps.config.retention);
      emit({ event: "record", record: refusal });
      if (deps.config.notifyOnFailed) await deliver(deps, refusal, problem);

      return refusal;
    }

    workspace = prepared.workspace;
    const cwd = workspace.cwd;

    // Claim the covered instant only now, so a manual run suppresses catch-up for it.
    claimCoveredInstant(l, opts, started, deps);

    const record: RunRecord = {
      ...base(),
      startedAt: started.toISOString(),
      model: model.display,
      timeout: formatDuration(timeoutMs),
      hooks: [],
      pid: process.pid,
    };

    reporter?.start(started.toISOString());

    const items: InputItem[] = [];
    let outcome: Outcome = "ok";
    let reason: string | undefined;
    let error: { kind: ErrorKind; message: string } | undefined;

    const header = runHeader(l, run, started);
    const late = lateLine(run, started, l.automation.on.schedule?.timezone);

    const flowProblems: string[] = [];
    const flow = containTracking(deps.startTracking, {
      context,
      automation: l.automation,
      config: deps.config,
      ...(opts.forceFlow ? { force: true } : {}),
      onProblem: (m: string) => flowProblems.push(m),
    });
    const flowRun = flow?.start();
    if (flowRun) {
      closeFlow = () => {
        flow?.end("failed");
      };
      if (flow?.charted !== false) emit({ event: "flow", run: flowRun });
    }
    const guide = flowRun ? flow?.guide?.() : undefined;

    /** The session opens on first use, so a pre hook that stops the run never opens one. */
    const oneTurn = async (text: string): Promise<string> => {
      if (!session) {
        emit({ event: "body-start", model: model.display, cwd });

        // Subagents inherit AUTOMATION_RUN/AUTOMATION_NODE; the runtime applies them, not core.
        const overlay = flow && flowRun ? flow.environment("body") : undefined;

        live = new LiveWriter(liveFile(deps.stateDir, l.key));
        session = await deps.runtime.startSession({
          cwd,
          model,
          signal: controller.signal,
          live,
          context,
          ...(overlay ? { env: overlay } : {}),
        });

        // Publish the session file via the event and the lock.
        const file = session.file;
        const id = session.id;
        if (file !== "" && id !== "") {
          const reference: SessionReference = {
            file,
            id,
            ...(session.format ? { format: session.format } : {}),
          };
          emit({ event: "session", ...reference });
          updateRunLock(deps.stateDir, l.key, { session: reference });
        }
      }
      return session.prompt(text);
    };

    /** Every hook gets the run's progress identity so its work shows on the chart. */
    const flowIdentity =
      flow && flowRun
        ? {
            flow: {
              environment: (node: string) => flow.environment(node),
            },
          }
        : {};

    const hookOpts = {
      config: deps.config,
      runScript: deps.runScript,
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.hookTimeoutMs !== undefined ? { timeoutMs: deps.hookTimeoutMs } : {}),
      ...flowIdentity,
    };

    const postHookOpts = hookOpts;
    // `timeout` bounds the pre hooks, so the run's timeout or a stop ends a running pre script.
    const preHookOpts = { ...hookOpts, signal: controller.signal };

    // --- pre hooks ---------------------------------------------------------------------------
    for (const [i, hook] of l.automation.hooks.pre.entries()) {
      if (controller.signal.aborted) {
        if (cancelled) {
          outcome = "aborted";
          reason = CANCEL_REASON;
        } else {
          outcome = "failed";
          error = { kind: "timeout", message: `run timed out after ${formatDuration(timeoutMs)}` };
        }
        break;
      }

      emit({ event: "hook-start", phase: "pre", index: i, source: sourceOf(hook) });
      flow?.next(nodeIdFor("pre", i), sourceOf(hook));

      const r = await runOneHook(hook, "pre", i, undefined, {
        l,
        run,
        opts: preHookOpts,
        oneTurn: (text) => oneTurn(bodyPrompt(text, header, items, late)),
      });

      record.hooks?.push(r.result);
      items.push({
        index: i,
        source: r.result.source,
        status: r.result.status,
        output: r.output,
        ...(r.result.truncated ? { truncated: true } : {}),
      });
      emit({ event: "hook-end", result: r.result });
      if (r.output) flow?.say(r.output);

      // Ended by the run's timeout or a stop: that is the outcome, not a hook failure.
      if (r.result.status === "failed" && controller.signal.aborted) {
        if (cancelled) {
          outcome = "aborted";
          reason = CANCEL_REASON;
        } else {
          outcome = "failed";
          error = { kind: "timeout", message: `run timed out after ${formatDuration(timeoutMs)}` };
        }
        flow?.mark(nodeIdFor("pre", i), "failed", reason ?? error?.message);
        break;
      }

      if (r.result.status === "skipped") {
        outcome = "skipped";
        reason = r.result.reason;
        flow?.mark(nodeIdFor("pre", i), "skipped", r.result.reason);
        break;
      }
      if (r.result.status === "failed") {
        outcome = "failed";
        error = { kind: "hook", message: r.result.reason ?? "hook failed" };
        flow?.mark(nodeIdFor("pre", i), "failed", r.result.reason);
        break;
      }
    }

    // --- body --------------------------------------------------------------------------------
    let bodyOutput = "";
    if (outcome === "ok") {
      flow?.next("body", model.display);
      try {
        bodyOutput = await oneTurn(bodyPrompt(l.automation.body, header, items, late, guide));
        emit({ event: "body-end", chars: bodyOutput.length });
        flow?.say(bodyOutput);
        flow?.mark("body", "done");
      } catch (e) {
        // A stop request arrives as an abort, like a timeout, but the outcome is `aborted`.
        if (cancelled) {
          outcome = "aborted";
          reason = CANCEL_REASON;
          flow?.mark("body", "failed", CANCEL_REASON);
        } else {
          outcome = "failed";
          const kind = timedOut ? "timeout" : classifyFireError(e);
          error = {
            kind,
            message:
              kind === "timeout" ? `run timed out after ${formatDuration(timeoutMs)}` : oneLine(e),
          };
          flow?.mark("body", "failed", error.message);
        }
      }
    }

    // --- post hooks — always ------------------------------------------------------------------

    // An aborted prompt can resolve instead of throwing, so check for a stop here too.
    if (cancelled && outcome === "ok") {
      outcome = "aborted";
      reason = CANCEL_REASON;
      flow?.mark("body", "failed", CANCEL_REASON);
    }

    for (const [i, hook] of l.automation.hooks.post.entries()) {
      emit({ event: "hook-start", phase: "post", index: i, source: sourceOf(hook) });
      flow?.step(nodeIdFor("post", i), sourceOf(hook));

      // The session is gone after a timeout or a stop; record that a post prompt could not run.
      if ("prompt" in hook && (timedOut || cancelled || !session)) {
        const reasonForHook = timedOut
          ? "run timed out before post prompt"
          : cancelled
            ? "run was stopped before post prompt"
            : "no session was opened, so there was nothing to ask";
        const result: HookResult = {
          phase: "post",
          index: i,
          kind: "prompt",
          source: "prompt",
          status: "failed",
          durationMs: 0,
          reason: reasonForHook,
        };
        record.hooks?.push(result);
        emit({ event: "hook-end", result });
        continue;
      }

      const r = await runOneHook(hook, "post", i, bodyOutput, {
        l,
        run,
        opts: postHookOpts,
        oneTurn: (text) => oneTurn(text),
        outcomeForPost: { outcome, ...(reason ?? error?.kind ? { reason: reason ?? error?.kind } : {}) },
      });

      // A failing post hook is recorded but does not change the outcome.
      record.hooks?.push(r.result);
      emit({ event: "hook-end", result: r.result });
      flow?.mark(
        nodeIdFor("post", i),
        r.result.status === "failed" ? "failed" : "done",
        r.result.reason,
      );
    }

    const ended = clock();
    record.endedAt = ended.toISOString();
    record.recordedAt = ended.toISOString();
    record.outcome = outcome;
    if (reason) record.reason = reason;
    if (error) record.error = error;
    if (session) {
      record.session = {
        file: session.file,
        id: session.id,
        ...(session.format ? { format: session.format } : {}),
      };
    }
    const produced = clipOutput(bodyOutput);
    if (produced) record.output = produced;

    const progress = flow?.end(outcome === "failed" ? "failed" : outcome === "aborted" ? "cancelled" : "ok");
    if (progress) {
      if (progress.chart) {
        record.chart = progress.chart;
        record.steps = progress.steps;
        if (progress.taken.length > 0) record.taken = progress.taken;
      }
      if (progress.notes.length > 0) record.notes = progress.notes;
      if (progress.message) record.message = progress.message;
    }
    if (flowProblems.length > 0) record.flow = { problem: flowProblems[0] as string };
    if (observePoll) clearInterval(observePoll);
    reporter?.finish(progress);
    const problems = reporter ? await reporter.settle() : [];
    if (problems.length > 0) record.pluginProblems = problems;

    appendRecord(deps.stateDir, record, deps.config.retention);
    emit({ event: "record", record });

    // Only failures notify; a skipped run is usually the automation working as written.
    if (record.outcome === "failed" && deps.config.notifyOnFailed) {
      await deliver(deps, record, problem);
    }

    return record;
  } finally {
    clearTimeout(timer);
    clearInterval(cancelPoll);
    if (observePoll) clearInterval(observePoll);
    closeFlow?.();
    live?.close();
    // Spend the stop request so the next run is not stopped by it.
    clearCancel(deps.stateDir, l.key);
    if (session) {
      const closing = session;
      await bounded(
        "session disposal",
        Promise.resolve().then(() => closing.dispose()),
        deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS,
        problem,
      );
    }
    try {
      // Release this run's workspace once, bounded; a failure is a diagnostic.
      await bounded(
        "workspace release",
        workspace?.release(),
        deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS,
        problem,
      );
    } finally {
      lock.release();
    }
  }
}

function pluginProblems(reporter: RunReporter | undefined): { pluginProblems?: string[] } {
  const known = reporter?.problemsSoFar() ?? [];
  return known.length > 0 ? { pluginProblems: known } : {};
}

// Where the body runs: repository root, the automation folder, or a worktree (`config.worktree`).

/** A short cause for a workspace failure, so a clipped summary still tells failures apart. */
function workspaceCause(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes("enoent") && d.includes("git")) return "git is not installed";
  if (d.includes("already exists")) return "the worktree path already exists";
  if (d.includes("not a git repository")) return "not a git repository";
  if (d.includes("not a valid object name") || d.includes("invalid reference"))
    return "the repository has no usable HEAD";
  if (d.includes("permission denied") || d.includes("eacces")) return "permission denied";
  if (d.includes("is already checked out")) return "that commit is already checked out";
  const stripped = detail.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"');
  return clipLine(stripped.replace(/\s+/g, " ").trim(), 44);
}

/** The one-line refusal: cause, fix, then repository, path and git's line. */
export function workspaceRefusalMessage(args: {
  key: string;
  repository?: string;
  intended?: string;
  detail: string;
}): string {
  const detail = clipLine(args.detail.replace(/\s+/g, " ").trim(), 160);
  const what = args.repository ? ` for ${args.repository}` : "";
  const where = args.intended ? ` at ${args.intended}` : "";
  return (
    `workspace: ${workspaceCause(detail)} — remove it from config.worktree to run in` +
    ` the checkout — could not prepare the git worktree${what}${where}: ${detail}` +
    ` (${JSON.stringify(args.key)})`
  );
}

// Bound for post-record integrations, so a hung one cannot hold the run lock.
const PROVIDER_TIMEOUT_MS = 15_000;

// Wait for an optional integration, bounded; the rejection handler is attached first.
async function bounded(
  what: string,
  work: Promise<unknown> | undefined,
  ms: number,
  problem: (message: string) => void,
): Promise<void> {
  if (!work) return;

  let told = false;
  const tell = (message: string) => {
    if (told) return;
    told = true;
    problem(message);
  };

  const finished = work.then(
    () => true,
    (e: unknown) => {
      tell(`${what} failed: ${oneLine(e)}`);
      return true;
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  const inTime = await Promise.race([finished, expired]);
  clearTimeout(timer);
  if (!inTime) tell(`${what} did not finish within ${formatDuration(ms)}`);
}

// Every tracker call, contained: a throwing tracker only loses tracking, never the record.
function containTracking(
  start: StartFlowTracking | undefined,
  request: FlowTrackingRequest,
): FlowTracking | undefined {
  if (!start) return undefined;

  const note = (call: string, e: unknown) => {
    request.onProblem?.(`flow ${call}: ${oneLine(e)}`);
  };

  let tracking: FlowTracking | undefined;
  try {
    tracking = start(request);
  } catch (e) {
    note("factory", e);
    return undefined;
  }
  if (!tracking) return undefined;

  const t = tracking;
  let failed = false;
  let started = false;
  let ended = false;
  const guard = <T>(call: string, fn: () => T, fallback: T): T => {
    if (failed) return fallback;
    try {
      return fn();
    } catch (e) {
      failed = true;
      note(call, e);
      return fallback;
    }
  };

  return {
    start: () => {
      const run = guard("start", () => t.start(), undefined);
      if (!run) failed = true;
      else started = true;
      return run;
    },
    next: (node, message) => guard("next", () => t.next(node, message), undefined),
    step: (node, message) => guard("step", () => t.step(node, message), undefined),
    mark: (node, status, message) => guard("mark", () => t.mark(node, status, message), undefined),
    say: (text, node) => guard("say", () => t.say(text, node), undefined),
    end: (status) => {
      if (!started || ended) return undefined;
      ended = true;
      try {
        return t.end(status) ?? undefined;
      } catch (e) {
        note("end", e);
        return undefined;
      }
    },
    environment: (node) => guard("environment", () => t.environment(node), {}),
    guide: () => guard("guide", () => t.guide?.(), undefined),
    get charted() {
      try {
        return t.charted;
      } catch {
        return false;
      }
    },
  };
}

/** Hand a failed record to the notifier: bounded, and never able to change the outcome. */
async function deliver(
  deps: FireDeps,
  record: RunRecord,
  problem: (message: string) => void,
): Promise<void> {
  if (!deps.notify) return;
  const notify = deps.notify;
  // Turns a synchronous throw into a rejection on the same bounded path.
  await bounded(
    "notification",
    Promise.resolve().then(() => notify(record)),
    deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS,
    problem,
  );
}

function runContextFor(l: Located, run: RunInfo, deps: FireDeps): RunContext {  return Object.freeze({
    runId: run.runId,
    key: l.key,
    name: l.automation.name,
    scope: l.root.scope,
    trigger: run.trigger,
    ...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
    late: run.late,
    automationDir: l.dir,
    rootDir: l.root.path,
    ...(l.repoRoot ? { repositoryRoot: l.repoRoot } : {}),
    stateDir: deps.stateDir,
  });
}

function workspaceRequestFor(l: Located, context: RunContext, deps: FireDeps): WorkspaceRequest {
  const base = l.root.scope === "repository" && l.repoRoot ? l.repoRoot : l.dir;
  return {
    context,
    baseCwd: base,
    ...(l.repoRoot ? { repositoryRoot: l.repoRoot } : {}),
    isolated: deps.config.worktree[l.key] === true,
  };
}

function sourceOf(hook: Hook): string {
  return "script" in hook ? hook.script : "prompt";
}

// Claim the instant this run covers so catch-up cannot duplicate it. Never fails the run.
function claimCoveredInstant(
  l: Located,
  opts: FireOptions,
  started: Date,
  deps: FireDeps,
): void {
  try {
    const schedule = l.automation.on.schedule;
    if (!schedule) return;

    const covered = opts.scheduledFor
      ? new Date(opts.scheduledFor)
      : previousTick(schedule, started);

    if (!covered || Number.isNaN(covered.getTime())) return;
    deps.state.claimPersisted(l.key, covered.toISOString());
  } catch {
  }
}

async function runOneHook(
  hook: Hook,
  phase: "pre" | "post",
  index: number,
  stdin: string | undefined,
  ctx: {
    l: Located;
    run: RunInfo;
    opts: Parameters<typeof runScriptHook>[6];
    oneTurn: (text: string) => Promise<string>;
    outcomeForPost?: { outcome: Outcome; reason?: string };
  },
): Promise<{ result: HookResult; output: string }> {
  if ("script" in hook) {
    const r = await runScriptHook(
      ctx.l,
      hook,
      phase,
      index,
      ctx.run,
      stdin,
      ctx.opts,
      ctx.outcomeForPost,
    );
    return { result: r.result, output: r.output };
  }
  return runPromptHook(hook, phase, index, ctx.oneTurn);
}
