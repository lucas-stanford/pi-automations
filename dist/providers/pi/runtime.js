// The pi runtime: models and sessions from one SDK instance; native models stay private to it.
import { displayOf, selectModel, unavailableRuntime, } from "../../model.js";
import { oneLine } from "../../errors.js";
import { importPi } from "../../pi-module.js";
import { lastAssistantText } from "../../session.js";
// ------------------------------------------------------------------------------- the catalog
export function adaptPiRuntime(rt) {
    return {
        providers() {
            return rt.getProviders().map((p) => p.id);
        },
        getModel(provider, id) {
            return rt.getModel(provider, id);
        },
        async checkAuth(provider) {
            try {
                // `checkAuth` resolves to undefined without credentials and to an AuthCheck with them.
                return (await rt.checkAuth(provider)) !== undefined;
            }
            catch {
                // A provider whose auth check throws is not usable.
                return false;
            }
        },
        defaultModel() {
            const available = rt.getAvailableSnapshot();
            const first = available[0];
            if (!first)
                return undefined;
            return {
                provider: String(first.provider),
                id: first.id,
                display: displayOf(String(first.provider), first.id),
                raw: first,
            };
        },
    };
}
/** Create pi's ModelRuntime once, lazily, for both halves of the owner. */
export async function loadPiOwner(agentDir) {
    const pi = (await importPi());
    const runtime = await pi.ModelRuntime.create();
    return {
        catalog: adaptPiRuntime(runtime),
        openSession: (start) => openPiSession(pi, runtime, agentDir, start),
    };
}
// The owner when pi cannot load: the catalog reports why; sessions refuse.
function unavailableServices(reason) {
    return {
        catalog: unavailableRuntime(reason),
        openSession: () => Promise.reject(hostError(reason)),
    };
}
export async function loadPiRuntime() {
    return (await loadPiOwner()).catalog;
}
/** The models pi can run, read fresh each call. */
export async function listPiModels(cwd) {
    const pi = (await importPi());
    const runtime = await pi.ModelRuntime.create();
    const choice = (m, thinking) => ({
        value: `${String(m.provider)}/${m.id}${thinking ? `:${thinking}` : ""}`,
        ...(m.name ? { name: m.name } : {}),
    });
    const available = (await runtime.getAvailable()).map((m) => choice(m));
    const patterns = pi.SettingsManager.create(cwd).getEnabledModels() ?? [];
    let enabled = [];
    if (patterns.length > 0 && typeof pi.resolveModelScopeWithDiagnostics === "function") {
        const { scopedModels } = await pi.resolveModelScopeWithDiagnostics(patterns, runtime);
        enabled = scopedModels.map((s) => choice(s.model, s.thinkingLevel));
    }
    return { available, enabled };
}
function toolNameOf(e) {
    return e.toolName ?? "tool";
}
function assistantText(message) {
    return blockText(message, "text");
}
function thinkingText(message) {
    return blockText(message, "thinking");
}
function blockText(message, want) {
    const content = message?.content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const raw of content) {
        const b = raw;
        if (b?.type !== want)
            continue;
        const v = want === "text" ? b.text : (b.thinking ?? b.text);
        if (typeof v === "string")
            parts.push(v);
    }
    return parts.join("");
}
// Open a fresh pi session on the runtime that resolved the model: no history, no inherited model.
async function openPiSession(pi, runtime, agentDir, { cwd, model, native, signal, live }) {
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
            model: native,
            ...(model.thinking ? { thinkingLevel: model.thinking } : {}),
        });
        const session = created.session;
        const onAbort = () => {
            void session.abort();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const handle = {
            get file() {
                return session.sessionFile ?? "";
            },
            get id() {
                return session.sessionId;
            },
            async prompt(text) {
                // prompt() resolves to void; collect the reply from events, subscribing before prompting.
                let collected = "";
                const unsubscribe = session.subscribe((event) => {
                    const e = event;
                    if (e?.type === "agent_end") {
                        const text = lastAssistantText(e.messages);
                        if (text)
                            collected = text;
                    }
                    // The live view exists because pi writes its session file only when a turn completes.
                    if (!live)
                        return;
                    try {
                        if (e?.type === "message_update") {
                            const partial = assistantText(e.message);
                            if (partial)
                                live.partial(partial);
                            // Show reasoning: a model can think for a while before any text.
                            else
                                live.thinking(thinkingText(e.message));
                        }
                        else if (e?.type === "message_end") {
                            live.message(e.message);
                        }
                        else if (e?.type === "tool_execution_start") {
                            // Only the start; the result arrives with `message_end`.
                            live.tool(toolNameOf(e), e.args);
                        }
                    }
                    catch {
                    }
                });
                try {
                    await session.prompt(text);
                }
                finally {
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
/** What a session start says when the model did not come from this runtime. */
export const FOREIGN_MODEL_MESSAGE = "this model was resolved by a different runtime — resolve and start the session with the same one";
/** One automation per pi worker makes the env overlay safe; a second session is refused. */
export const OVERLAPPING_SESSION_MESSAGE = "this worker already has a session open — one automation per pi worker, so a second session cannot start here";
// Module scope: several runtime instances may share one `process.env`.
let sessionOpenInWorker = false;
function hostError(message) {
    return Object.assign(new Error(message), { kind: "host" });
}
// Apply an env overlay and return the exact undo (absent keys are deleted).
function applyOverlay(overlay) {
    if (!overlay)
        return () => { };
    const previous = new Map();
    for (const [key, value] of Object.entries(overlay)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
    }
    let undone = false;
    return () => {
        // Restore exactly once, so a later value set by something else is not undone.
        if (undone)
            return;
        undone = true;
        for (const [key, value] of previous) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    };
}
/** A pi-backed {@link AutomationRuntime}. The SDK loads on the first `resolveModel`. */
export function createPiRuntime(options = {}) {
    const load = options.loadServices ?? (() => loadPiOwner(options.agentDir));
    const owned = new WeakMap();
    // The catalog, created once; a load failure is cached as a catalog that reports why.
    let ownerOnce;
    const owner = () => {
        ownerOnce ??= load().catch((e) => unavailableServices(oneLine(e)));
        return ownerOnce;
    };
    const resolveModel = async (spec) => {
        const selected = await selectModel(spec, (await owner()).catalog);
        const ref = Object.freeze({ ...selected.identity });
        owned.set(ref, selected.native);
        return ref;
    };
    const startSession = async (start) => {
        // Refuse a foreign reference before it can reach the SDK.
        if (!owned.has(start.model))
            throw hostError(FOREIGN_MODEL_MESSAGE);
        if (start.signal.aborted)
            throw abortError();
        // Also before the overlay, so refusing leaves the first session's environment untouched.
        if (sessionOpenInWorker)
            throw hostError(OVERLAPPING_SESSION_MESSAGE);
        const model = {
            provider: start.model.provider,
            id: start.model.id,
            display: start.model.display,
            ...(start.model.thinking !== undefined ? { thinking: start.model.thinking } : {}),
        };
        // The overlay goes on before the SDK spawns anything, and is restored if startup fails.
        const restore = applyOverlay(start.env);
        sessionOpenInWorker = true;
        let handle;
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
        }
        catch (e) {
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
            prompt: (text) => handle.prompt(text),
            dispose: async () => {
                try {
                    await handle.dispose();
                }
                finally {
                    restore();
                    sessionOpenInWorker = false;
                }
            },
        };
    };
    return { resolveModel, startSession };
}
function abortError() {
    return Object.assign(new Error("run was stopped before the session was ready"), {
        name: "AbortError",
    });
}
//# sourceMappingURL=runtime.js.map