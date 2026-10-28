// The pi runtime: models and sessions from one SDK instance; native models stay private to it.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  AutomationRuntime,
  AutomationSession,
  EnvironmentOverlay,
  RuntimeModelRef,
  RuntimeSessionStart,
  SessionLiveSink,
} from "../../core/contracts.js";
import {
  displayOf,
  selectModel,
  unavailableRuntime,
  type ModelRuntimeLike,
} from "../../model.js";
import { oneLine } from "../../errors.js";
import { importPi } from "../../pi-module.js";
import { lastAssistantText } from "../../session.js";
import type { SessionHandle } from "../../run.js";
import type { ResolvedModel } from "../../types.js";

// ------------------------------------------------------------------------------- the catalog

export function adaptPiRuntime(rt: ModelRuntime): ModelRuntimeLike {
  return {
    providers() {
      return rt.getProviders().map((p) => p.id);
    },

    getModel(provider: string, id: string) {
      return rt.getModel(provider, id);
    },

    async checkAuth(provider: string) {
      try {
        // `checkAuth` resolves to undefined without credentials and to an AuthCheck with them.
        return (await rt.checkAuth(provider)) !== undefined;
      } catch {
        // A provider whose auth check throws is not usable.
        return false;
      }
    },

    defaultModel() {
      const available = rt.getAvailableSnapshot();
      const first = available[0];
      if (!first) return undefined;
      return {
        provider: String(first.provider),
        id: first.id,
        display: displayOf(String(first.provider), first.id),
        raw: first,
      };
    },
  };
}

// Not exported, so one owner's catalog is never paired with another's session opener.
interface PiSessionStart {
  cwd: string;
  model: ResolvedModel;
  native: unknown;
  signal: AbortSignal;
  live?: SessionLiveSink;
}

/** One pi owner: a catalog and a session opener closing over the same `ModelRuntime`. */
export interface PiOwner {
  readonly catalog: ModelRuntimeLike;
  openSession(start: PiSessionStart): Promise<SessionHandle>;
}

/** Create pi's ModelRuntime once, lazily, for both halves of the owner. */
export async function loadPiOwner(agentDir?: string): Promise<PiOwner> {
  const pi = (await importPi()) as typeof import("@earendil-works/pi-coding-agent");
  const runtime = await pi.ModelRuntime.create();

  return {
    catalog: adaptPiRuntime(runtime),
    openSession: (start) => openPiSession(pi, runtime, agentDir, start),
  };
}

// The owner when pi cannot load: the catalog reports why; sessions refuse.
function unavailableServices(reason: string): PiOwner {
  return {
    catalog: unavailableRuntime(reason),
    openSession: () => Promise.reject(hostError(reason)),
  };
}

export async function loadPiRuntime(): Promise<ModelRuntimeLike> {
  return (await loadPiOwner()).catalog;
}

export interface PiModelChoice {
  value: string;
  name?: string;
}

export interface PiModelChoices {
  /** Every model pi has credentials for: the list pi's own model picker shows. */
  available: PiModelChoice[];
  /** `enabledModels` from pi's settings, resolved the way `/scoped-models` resolves them. */
  enabled: PiModelChoice[];
}

/** The models pi can run, read fresh each call. */
export async function listPiModels(cwd: string): Promise<PiModelChoices> {
  const pi = (await importPi()) as typeof import("@earendil-works/pi-coding-agent");
  const runtime = await pi.ModelRuntime.create();
  const choice = (m: { provider: unknown; id: string; name?: string }, thinking?: string): PiModelChoice => ({
    value: `${String(m.provider)}/${m.id}${thinking ? `:${thinking}` : ""}`,
    ...(m.name ? { name: m.name } : {}),
  });
  const available = (await runtime.getAvailable()).map((m) => choice(m));
  const patterns = pi.SettingsManager.create(cwd).getEnabledModels() ?? [];
  let enabled: PiModelChoice[] = [];
  if (patterns.length > 0 && typeof pi.resolveModelScopeWithDiagnostics === "function") {
    const { scopedModels } = await pi.resolveModelScopeWithDiagnostics(patterns, runtime);
    enabled = scopedModels.map((s) => choice(s.model, s.thinkingLevel));
  }
  return { available, enabled };
}

// ------------------------------------------------------------------------------- the session

// Live events, as far as read here. `tool_execution_start` carries `args`.
interface AgentEventLike {
  type: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  message?: unknown;
  toolName?: string;
  args?: unknown;
}

function toolNameOf(e: AgentEventLike): string {
  return e.toolName ?? "tool";
}

function assistantText(message: unknown): string {
  return blockText(message, "text");
}

function thinkingText(message: unknown): string {
  return blockText(message, "thinking");
}

function blockText(message: unknown, want: "text" | "thinking"): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const b = raw as { type?: string; text?: string; thinking?: string };
    if (b?.type !== want) continue;
    const v = want === "text" ? b.text : (b.thinking ?? b.text);
    if (typeof v === "string") parts.push(v);
  }
  return parts.join("");
}

// Open a fresh pi session on the runtime that resolved the model: no history, no inherited model.
async function openPiSession(
  pi: typeof import("@earendil-works/pi-coding-agent"),
  runtime: ModelRuntime,
  agentDir: string | undefined,
  { cwd, model, native, signal, live }: PiSessionStart,
): Promise<SessionHandle> {
  {
    const dir = agentDir ?? pi.getAgentDir();

    const loader = new pi.DefaultResourceLoader({ cwd, agentDir: dir });
    await loader.reload();

    const created = await pi.createAgentSession({
      cwd,
      agentDir: dir,
      resourceLoader: loader,
      sessionManager: pi.SessionManager.create(cwd),
      modelRuntime: runtime,
      model: native as never,
      ...(model.thinking ? { thinkingLevel: model.thinking as never } : {}),
    });

    const session = created.session;

    const onAbort = () => {
      void session.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const handle: SessionHandle = {
      get file() {
        return session.sessionFile ?? "";
      },
      get id() {
        return session.sessionId;
      },

      async prompt(text: string): Promise<string> {
        // prompt() resolves to void; collect the reply from events, subscribing before prompting.
        let collected = "";
        const unsubscribe = session.subscribe((event: unknown) => {
          const e = event as AgentEventLike;

          if (e?.type === "agent_end") {
            const text = lastAssistantText(e.messages);
            if (text) collected = text;
          }

          // The live view exists because pi writes its session file only when a turn completes.
          if (!live) return;
          try {
            if (e?.type === "message_update") {
              const partial = assistantText(e.message);
              if (partial) live.partial(partial);
              // Show reasoning: a model can think for a while before any text.
              else live.thinking(thinkingText(e.message));
            } else if (e?.type === "message_end") {
              live.message(e.message);
            } else if (e?.type === "tool_execution_start") {
              // Only the start; the result arrives with `message_end`.
              live.tool(toolNameOf(e), e.args);
            }
          } catch {
          }
        });

        try {
          await session.prompt(text);
        } finally {
          unsubscribe();
        }
        return collected;
      },

      dispose() {
        signal.removeEventListener("abort", onAbort);
        session.dispose();
      },
    };

    return handle;
  }
}

// ------------------------------------------------------------------------------- the runtime

export interface PiRuntimeOptions {
  agentDir?: string;
  // How this runtime's pi owner is obtained. Injected by tests; production loads the SDK lazily.
  loadServices?: () => Promise<PiOwner>;
}

/** What a session start says when the model did not come from this runtime. */
export const FOREIGN_MODEL_MESSAGE =
  "this model was resolved by a different runtime — resolve and start the session with the same one";

/** One automation per pi worker makes the env overlay safe; a second session is refused. */
export const OVERLAPPING_SESSION_MESSAGE =
  "this worker already has a session open — one automation per pi worker, so a second session cannot start here";

// Module scope: several runtime instances may share one `process.env`.
let sessionOpenInWorker = false;

function hostError(message: string): Error & { kind: "host" } {
  return Object.assign(new Error(message), { kind: "host" as const });
}

// Apply an env overlay and return the exact undo (absent keys are deleted).
function applyOverlay(overlay: EnvironmentOverlay | undefined): () => void {
  if (!overlay) return () => {};

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overlay)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  let undone = false;
  return () => {
    // Restore exactly once, so a later value set by something else is not undone.
    if (undone) return;
    undone = true;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A pi-backed {@link AutomationRuntime}. The SDK loads on the first `resolveModel`. */
export function createPiRuntime(options: PiRuntimeOptions = {}): AutomationRuntime {
  const load = options.loadServices ?? (() => loadPiOwner(options.agentDir));

  const owned = new WeakMap<RuntimeModelRef, unknown>();

  // The catalog, created once; a load failure is cached as a catalog that reports why.
  let ownerOnce: Promise<PiOwner> | undefined;
  const owner = (): Promise<PiOwner> => {
    ownerOnce ??= load().catch((e: unknown) => unavailableServices(oneLine(e)));
    return ownerOnce;
  };

  const resolveModel = async (spec: string | undefined): Promise<RuntimeModelRef> => {
    const selected = await selectModel(spec, (await owner()).catalog);

    const ref = Object.freeze({ ...selected.identity }) as RuntimeModelRef;
    owned.set(ref, selected.native);
    return ref;
  };

  const startSession = async (start: RuntimeSessionStart): Promise<AutomationSession> => {
    // Refuse a foreign reference before it can reach the SDK.
    if (!owned.has(start.model)) throw hostError(FOREIGN_MODEL_MESSAGE);
    if (start.signal.aborted) throw abortError();

    // Also before the overlay, so refusing leaves the first session's environment untouched.
    if (sessionOpenInWorker) throw hostError(OVERLAPPING_SESSION_MESSAGE);

    const model: ResolvedModel = {
      provider: start.model.provider,
      id: start.model.id,
      display: start.model.display,
      ...(start.model.thinking !== undefined ? { thinking: start.model.thinking } : {}),
    };

    // The overlay goes on before the SDK spawns anything, and is restored if startup fails.
    const restore = applyOverlay(start.env);
    sessionOpenInWorker = true;

    let handle: SessionHandle;
    try {
      handle = await (await owner()).openSession({
        cwd: start.cwd,
        model,
        native: owned.get(start.model),
        signal: start.signal,
        ...(start.live ? { live: start.live } : {}),
      });
      if (start.signal.aborted) {
        await handle.dispose();
        throw abortError();
      }
    } catch (e) {
      restore();
      sessionOpenInWorker = false;
      throw e;
    }

    return {
      get file() {
        return handle.file;
      },
      get id() {
        return handle.id;
      },
      ...(handle.format ? { format: handle.format } : {}),
      prompt: (text: string) => handle.prompt(text),
      dispose: async () => {
        try {
          await handle.dispose();
        } finally {
          restore();
          sessionOpenInWorker = false;
        }
      },
    };
  };

  return { resolveModel, startSession };
}

function abortError(): Error {
  return Object.assign(new Error("run was stopped before the session was ready"), {
    name: "AbortError",
  });
}
