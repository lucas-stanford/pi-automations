// Script and prompt hooks. Pre-hook output is data for the body; post hooks always run.
import path from "node:path";
import { ms } from "./config.js";
import { formatDuration } from "./duration.js";
import { resolveInterpreter } from "./interpreters.js";
import { nodeIdFor } from "./nodes.js";
import { WATCH_TIMEOUT_MAX_MS } from "./watch.js";
/** Credential-like names, never passed to a hook, a watch script or a job file. */
export const SECRET_NAME = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/i;
/** The hook environment. Defined by this host; Draft 0.2 does not specify one. */
export function hookEnv(l, run, phase, index, outcome, reason, 
/** The run's progress identity, given to every hook so its work shows on the chart. */
flow) {
    const env = {
        AUTOMATION_NAME: l.automation.name,
        AUTOMATION_KEY: l.key,
        AUTOMATION_SCOPE: l.root.scope,
        AUTOMATION_DIR: l.dir,
        AUTOMATION_ROOT: l.root.path,
        AUTOMATION_RUN_ID: run.runId,
        AUTOMATION_TRIGGER: run.trigger,
        AUTOMATION_LATE: run.late ? "true" : "false",
        AUTOMATION_PHASE: phase,
        AUTOMATION_HOOK_INDEX: String(index),
    };
    if (l.repoRoot)
        env.AUTOMATION_REPO_ROOT = l.repoRoot;
    if (run.scheduledFor)
        env.AUTOMATION_SCHEDULED_FOR = run.scheduledFor;
    if (phase === "post" && outcome)
        env.AUTOMATION_OUTCOME = outcome;
    if (phase === "post" && reason)
        env.AUTOMATION_REASON = reason;
    /** The tracker's own overlay for this hook's node, so concurrent hooks do not collide. */
    if (flow)
        Object.assign(env, flow.environment(nodeIdFor(phase, index)));
    return env;
}
/** Only the first non-empty line counts: exactly `skip`, or starting with `skip:`. */
export function detectSkip(answer) {
    const first = answer
        .split("\n")
        .map((s) => s.trim())
        .find((s) => s !== "");
    if (!first)
        return { skip: false };
    const lower = first.toLowerCase();
    if (lower === "skip")
        return { skip: true };
    if (lower.startsWith("skip:")) {
        const reason = first.slice(first.indexOf(":") + 1).trim();
        return reason ? { skip: true, reason } : { skip: true };
    }
    return { skip: false };
}
/** Run one script hook to completion, or to its timeout. */
export async function runScriptHook(l, hook, phase, index, run, stdin, opts, outcomeForPost) {
    const started = Date.now();
    const base = {
        phase,
        index,
        kind: "script",
        source: hook.script,
    };
    const fail = (reason, extra = {}) => ({
        result: { ...base, status: "failed", durationMs: Date.now() - started, reason, ...extra },
        output: "",
        stderr: "",
    });
    // --- policy: which interpreter, what environment, what bounds --------------------------------
    const abs = path.resolve(l.dir, hook.script);
    const interp = opts.which
        ? resolveInterpreter(abs, opts.platform, opts.which, hook.script)
        : resolveInterpreter(abs, opts.platform, undefined, hook.script);
    if (!interp.ok)
        return fail(`${hook.script} ${interp.reason}`);
    const timeoutMs = opts.timeoutMs ?? ms(opts.config, "hookTimeout");
    const maxOut = opts.config.hookMaxOutputBytes;
    // Credential-like names removed, hook table added; nothing else is inherited.
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined)
            continue;
        if (SECRET_NAME.test(name))
            continue;
        env[name] = value;
    }
    Object.assign(env, hookEnv(l, run, phase, index, outcomeForPost?.outcome, outcomeForPost?.reason, opts.flow));
    // A configured script with nowhere to run is a composition fault, not `ok` or `skipped`.
    if (typeof opts.runScript !== "function") {
        return fail(`${phase}[${index}] ${hook.script} could not run — this host composed no script executor`);
    }
    // --- mechanics: someone else's job -----------------------------------------------------------
    let raw;
    try {
        raw = await opts.runScript({
            file: interp.file,
            args: interp.args,
            cwd: l.dir,
            env,
            ...(stdin !== undefined ? { stdin } : {}),
            timeoutMs,
            maxOutputBytes: maxOut,
            ...(opts.signal ? { signal: opts.signal } : {}),
        });
    }
    catch (e) {
        // An executor that throws despite the contract still becomes an ordinary failed hook.
        return fail(`${hook.script} could not run — ${e.message}`);
    }
    // --- policy again: what the outcome MEANS -----------------------------------------------------
    const durationMs = Date.now() - started;
    const ran = readScriptExecution(raw);
    if (!ran) {
        return fail(`${hook.script} — its executor returned a completion this cannot read: ${describeExecution(raw)}`);
    }
    const bounded = {
        outputBytes: ran.outputBytes,
        ...(ran.truncated ? { truncated: true } : {}),
    };
    if (ran.end === "start-failed") {
        return fail(`${hook.script} could not start — ${ran.message}`);
    }
    if (ran.end === "timeout") {
        return {
            result: {
                ...base,
                status: "failed",
                durationMs,
                reason: `hook timeout after ${formatDuration(timeoutMs)}`,
                ...bounded,
            },
            output: ran.stdout,
            stderr: ran.stderr,
        };
    }
    if (ran.end === "cancelled") {
        return {
            result: {
                ...base,
                status: "failed",
                durationMs,
                reason: `${phase}[${index}] ${hook.script} was stopped`,
                ...bounded,
            },
            output: ran.stdout,
            stderr: ran.stderr,
        };
    }
    // Every remaining decoded shape is `end: "exit"`.
    const exit = ran.exit;
    const common = { ...base, status: "ok", durationMs, exit, ...bounded };
    if (exit === 0) {
        return { result: common, output: ran.stdout, stderr: ran.stderr };
    }
    // A failing pre hook stops the run; a failing post hook is recorded only.
    const lastErrLine = ran.stderr.trim().split("\n").filter(Boolean).pop();
    const reason = `${phase}[${index}] ${hook.script} exited ${exit}` + (lastErrLine ? `: ${lastErrLine}` : "");
    return {
        result: { ...common, status: phase === "pre" ? "skipped" : "failed", reason },
        output: ran.stdout,
        stderr: ran.stderr,
    };
}
/** Decode an untyped provider result completely before core reads any field from it. */
function readScriptExecution(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const v = value;
    if (typeof v["stdout"] !== "string" ||
        typeof v["stderr"] !== "string" ||
        typeof v["outputBytes"] !== "number" ||
        !Number.isInteger(v["outputBytes"]) ||
        v["outputBytes"] < 0 ||
        typeof v["truncated"] !== "boolean") {
        return undefined;
    }
    const output = {
        stdout: v["stdout"],
        stderr: v["stderr"],
        outputBytes: v["outputBytes"],
        truncated: v["truncated"],
    };
    if (v["end"] === "exit" && typeof v["exit"] === "number" && Number.isInteger(v["exit"])) {
        const signal = typeof v["signal"] === "string" && v["signal"] !== "" ? { signal: v["signal"] } : {};
        return { end: "exit", exit: v["exit"], ...signal, ...output };
    }
    if (v["end"] === "timeout")
        return { end: "timeout", ...output };
    if (v["end"] === "cancelled")
        return { end: "cancelled", ...output };
    if (v["end"] === "start-failed" && typeof v["message"] === "string") {
        return { end: "start-failed", message: v["message"], ...output };
    }
    return undefined;
}
/** Describe an unreadable completion by its shape only, never quoting the child's output. */
function describeExecution(ran) {
    if (typeof ran !== "object" || ran === null)
        return `${typeof ran}`;
    const r = ran;
    const end = typeof r.end === "string" ? JSON.stringify(r.end.slice(0, 80)) : `${typeof r.end}`;
    return `end=${end}, exit=${r.exit === undefined ? "missing" : typeof r.exit}`;
}
/** Run one prompt hook by asking the session. */
export async function runPromptHook(hook, phase, index, oneTurn) {
    const started = Date.now();
    const base = {
        phase,
        index,
        kind: "prompt",
        source: "prompt",
    };
    let answer;
    try {
        answer = await oneTurn(hook.prompt);
    }
    catch (e) {
        return {
            result: {
                ...base,
                status: "failed",
                durationMs: Date.now() - started,
                reason: e.message?.split("\n")[0] ?? String(e),
            },
            output: "",
        };
    }
    const durationMs = Date.now() - started;
    const outputBytes = Buffer.byteLength(answer, "utf8");
    // Only a PRE prompt can stop the run. A post prompt answering "skip" has nothing left to stop.
    if (phase === "pre") {
        const { skip, reason } = detectSkip(answer);
        if (skip) {
            return {
                result: {
                    ...base,
                    status: "skipped",
                    durationMs,
                    outputBytes,
                    ...(reason ? { reason } : {}),
                },
                output: answer,
            };
        }
    }
    return { result: { ...base, status: "ok", durationMs, outputBytes }, output: answer };
}
/** What a watch script is told: the hook identity, plus `LAST_CHECKED` for "what changed since". */
export function watchEnv(l, lastChecked) {
    const env = {
        AUTOMATION_NAME: l.automation.name,
        AUTOMATION_KEY: l.key,
        AUTOMATION_SCOPE: l.root.scope,
        AUTOMATION_DIR: l.dir,
        AUTOMATION_ROOT: l.root.path,
        AUTOMATION_TRIGGER: "watch",
        AUTOMATION_PHASE: "watch",
    };
    if (l.repoRoot)
        env.AUTOMATION_REPO_ROOT = l.repoRoot;
    if (lastChecked)
        env.AUTOMATION_LAST_CHECKED = lastChecked;
    return env;
}
/** Run an `on.watch` script once, like a script hook; `src/watch.ts` interprets the result. */
export async function runWatchScript(l, opts) {
    const started = Date.now();
    const problem = (text, out = {}) => ({
        problem: text,
        stdout: out.stdout ?? "",
        stderr: out.stderr ?? "",
        durationMs: Date.now() - started,
    });
    const watch = l.automation.on.watch;
    if (!watch)
        return problem("this automation has no on.watch");
    const abs = path.resolve(l.dir, watch.script);
    const interp = opts.which
        ? resolveInterpreter(abs, opts.platform, opts.which, watch.script)
        : resolveInterpreter(abs, opts.platform, undefined, watch.script);
    if (!interp.ok)
        return problem(`${watch.script} ${interp.reason}`);
    if (typeof opts.runScript !== "function") {
        return problem(`${watch.script} could not run — this host composed no script executor`);
    }
    const timeoutMs = opts.timeoutMs ?? Math.min(ms(opts.config, "hookTimeout"), WATCH_TIMEOUT_MAX_MS);
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined)
            continue;
        if (SECRET_NAME.test(name))
            continue;
        env[name] = value;
    }
    Object.assign(env, watchEnv(l, opts.lastChecked));
    let raw;
    try {
        raw = await opts.runScript({
            file: interp.file,
            args: interp.args,
            cwd: l.dir,
            env,
            timeoutMs,
            maxOutputBytes: opts.config.hookMaxOutputBytes,
        });
    }
    catch (e) {
        return problem(`${watch.script} could not run — ${e.message}`);
    }
    const ran = readScriptExecution(raw);
    if (!ran) {
        return problem(`${watch.script} — its executor returned a completion this cannot read: ${describeExecution(raw)}`);
    }
    const durationMs = Date.now() - started;
    switch (ran.end) {
        case "start-failed":
            return problem(`${watch.script} could not start — ${ran.message}`);
        case "timeout":
            return { ...problem(`${watch.script} timed out after ${formatDuration(timeoutMs)}`, ran), durationMs };
        case "cancelled":
            return { ...problem(`${watch.script} was stopped`, ran), durationMs };
        default:
            // A signal is not "found work" for a watch, even though hooks read it as exit 0.
            if (ran.signal)
                return { ...problem(`${watch.script} was killed by ${ran.signal}`, ran), durationMs };
            return { exit: ran.exit, stdout: ran.stdout, stderr: ran.stderr, durationMs };
    }
}
//# sourceMappingURL=hooks.js.map