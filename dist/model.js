// Model resolution policy: resolved at arm time, re-checked at every discovery, never substituted.
import { ModelError } from "./errors.js";
import { MODEL_RE } from "./parse.js";
/** pi's thinking levels (`pi-agent-core` `ThinkingLevel`). */
export const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
/** The closed `ErrorKind` list as a value, so a declared kind can be validated. */
export const ERROR_KINDS = [
    "timeout",
    "model-unavailable",
    "hook",
    "agent",
    "host",
];
/** Split `<provider>/<id>[:<thinking>]`. Shape is already validated by the parser. */
export function splitModelSpec(spec) {
    const slash = spec.indexOf("/");
    const provider = spec.slice(0, slash);
    const rest = spec.slice(slash + 1);
    const colon = rest.lastIndexOf(":");
    if (colon > 0) {
        const maybe = rest.slice(colon + 1);
        if (THINKING_LEVELS.includes(maybe)) {
            return { provider, id: rest.slice(0, colon), thinking: maybe };
        }
        // A colon that is part of the model id (OpenRouter's `:exacto`) is left alone.
        return { provider, id: rest };
    }
    return { provider, id: rest };
}
/** The levels a model actually offers, for the "supported: …" list. */
export function supportedThinkingLevels(model) {
    const map = model.thinkingLevelMap;
    if (!map)
        return [...THINKING_LEVELS];
    return THINKING_LEVELS.filter((l) => map[l] !== null);
}
export function displayOf(provider, id, thinking) {
    return thinking ? `${provider}/${id}:${thinking}` : `${provider}/${id}`;
}
/** Resolve `model:` (or the default), reporting file problems before machine problems. */
export async function selectModel(spec, rt) {
    // pi itself could not be found: say so once.
    const unavailable = rt.unavailableReason;
    if (unavailable !== undefined && unavailable !== "") {
        throw new ModelError("model", unavailable);
    }
    if (spec === undefined) {
        const fallback = rt.defaultModel();
        if (!fallback) {
            throw new ModelError("model", "this host has no default model — name one in the automation, or set a default with pi");
        }
        if (!(await rt.checkAuth(fallback.provider))) {
            throw new ModelError("model", noCredentials(fallback.provider));
        }
        return {
            identity: {
                provider: fallback.provider,
                id: fallback.id,
                display: fallback.display ?? displayOf(fallback.provider, fallback.id),
            },
            native: fallback.raw ?? fallback,
        };
    }
    if (!MODEL_RE.test(spec)) {
        throw new ModelError("model", `${JSON.stringify(spec)} is not <provider>/<id>[:<thinking>] — for example anthropic/claude-sonnet-4-5:low`);
    }
    const { provider, id, thinking } = splitModelSpec(spec);
    const known = rt.providers();
    if (!known.includes(provider)) {
        throw new ModelError("model", `provider ${JSON.stringify(provider)} is not registered — known: ${knownList(known, provider)}`);
    }
    const model = rt.getModel(provider, id);
    if (!model) {
        throw new ModelError("model", `${JSON.stringify(id)} is not in provider ${provider} — run pi --list-models ${provider}`);
    }
    if (thinking !== undefined) {
        const supported = supportedThinkingLevels(model);
        if (!supported.includes(thinking)) {
            throw new ModelError("model", `thinking level ${JSON.stringify(thinking)} is not supported by ${provider}/${id} — supported: ${supported.join(", ")}`);
        }
    }
    if (!(await rt.checkAuth(provider))) {
        throw new ModelError("model", noCredentials(provider));
    }
    const identity = {
        provider,
        id,
        display: displayOf(provider, id, thinking),
    };
    if (thinking !== undefined)
        identity.thinking = thinking;
    return { identity, native: model };
}
/** The same question for a caller that never starts a session: identity only. */
export async function resolveModel(spec, rt) {
    return (await selectModel(spec, rt)).identity;
}
function noCredentials(provider) {
    return `no credentials for ${provider} — run pi /login (env vars are not visible to scheduled runs)`;
}
/** How many providers the "known:" list names before it gives up and says "…". */
export const KNOWN_PROVIDERS_SHOWN = 8;
/** The "known: …" provider list, nearest names first, truncated. */
export function knownList(known, typed) {
    const ranked = [...known].sort((a, b) => {
        const d = editDistance(a, typed) - editDistance(b, typed);
        return d !== 0 ? d : a.localeCompare(b);
    });
    const shown = ranked.slice(0, KNOWN_PROVIDERS_SHOWN);
    return shown.join(", ") + (ranked.length > shown.length ? ", …" : "");
}
/** Levenshtein distance, bounded by the short strings it is used on. */
function editDistance(a, b) {
    if (a === b)
        return 0;
    const m = a.length;
    const n = b.length;
    if (m === 0)
        return n;
    if (n === 0)
        return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    let curr = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        const swap = prev;
        prev = curr;
        curr = swap;
    }
    return prev[n];
}
/** Classify a run failure from its text; anything unrecognised is `agent`. */
export function classifyFireError(e) {
    // An explicit `kind` wins, but only when it is one of the closed members.
    const declared = e?.kind;
    if (typeof declared === "string" && ERROR_KINDS.includes(declared)) {
        return declared;
    }
    const name = e?.name ?? "";
    if (name === "AbortError" || name === "TimeoutError")
        return "timeout";
    const status = e?.status ??
        e?.statusCode;
    if (typeof status === "number") {
        if (status === 401 || status === 402 || status === 403 || status === 429) {
            return "model-unavailable";
        }
        if (status >= 500)
            return "model-unavailable";
    }
    const text = `${name} ${e?.message ?? String(e ?? "")}`.toLowerCase();
    if (/\babort/.test(text))
        return "timeout";
    if (/unauthor|forbidden|invalid api key|no credentials|authentication|credential|quota|rate limit|insufficient|billing|overload|unavailable|bad gateway|service unavailable|gateway timeout|econnrefused|enotfound|eai_again|socket hang up/.test(text)) {
        return "model-unavailable";
    }
    return "agent";
}
/** The runtime used when pi cannot be found: every run fails with a fix-naming record. */
export function unavailableRuntime(reason) {
    return {
        providers: () => [],
        getModel: () => undefined,
        checkAuth: async () => false,
        defaultModel: () => undefined,
        unavailableReason: reason,
    };
}
//# sourceMappingURL=model.js.map