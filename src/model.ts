// Model resolution policy: resolved at arm time, re-checked at every discovery, never substituted.

import { ModelError } from "./errors.js";
import { MODEL_RE } from "./parse.js";
import type { ErrorKind, ResolvedModel } from "./types.js";

/** pi's thinking levels (`pi-agent-core` `ThinkingLevel`). */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** The closed `ErrorKind` list as a value, so a declared kind can be validated. */
export const ERROR_KINDS = [
  "timeout",
  "model-unavailable",
  "hook",
  "agent",
  "host",
] as const satisfies readonly ErrorKind[];

export interface ModelLike {
  id: string;
  provider: string;
  /** `null` marks a level explicitly unsupported; a missing key means the provider default. */
  thinkingLevelMap?: Partial<Record<string, string | null>> | undefined;
}

/** The host default. `raw` never leaves the runtime that asked. */
export interface DefaultModelLike extends ModelLike {
  display?: string;
  raw?: unknown;
}

/** The slice of pi's ModelRuntime this needs: each error line is a direct question to it. */
export interface ModelRuntimeLike {
  /** Registered provider ids, for the "known: …" list. */
  providers(): string[];
  /** A specific model, or undefined when the provider does not have it. */
  getModel(provider: string, id: string): ModelLike | undefined;
  // True when usable credentials exist. pi returns undefined from checkAuth when there are none.
  checkAuth(provider: string): Promise<boolean>;
  /** The host default, used when the automation names no model. */
  defaultModel(): DefaultModelLike | undefined;
}

/** A model and the catalog's own object for it. Only the runtime that asked holds `native`. */
export interface ModelSelection {
  identity: ResolvedModel;
  native: unknown;
}

/** Split `<provider>/<id>[:<thinking>]`. Shape is already validated by the parser. */
export function splitModelSpec(spec: string): { provider: string; id: string; thinking?: string } {
  const slash = spec.indexOf("/");
  const provider = spec.slice(0, slash);
  const rest = spec.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  if (colon > 0) {
    const maybe = rest.slice(colon + 1);
    if ((THINKING_LEVELS as readonly string[]).includes(maybe)) {
      return { provider, id: rest.slice(0, colon), thinking: maybe };
    }
    // A colon that is part of the model id (OpenRouter's `:exacto`) is left alone.
    return { provider, id: rest };
  }
  return { provider, id: rest };
}

/** The levels a model actually offers, for the "supported: …" list. */
export function supportedThinkingLevels(model: ModelLike): string[] {
  const map = model.thinkingLevelMap;
  if (!map) return [...THINKING_LEVELS];
  return THINKING_LEVELS.filter((l) => map[l] !== null);
}

export function displayOf(provider: string, id: string, thinking?: string): string {
  return thinking ? `${provider}/${id}:${thinking}` : `${provider}/${id}`;
}

/** Resolve `model:` (or the default), reporting file problems before machine problems. */
export async function selectModel(
  spec: string | undefined,
  rt: ModelRuntimeLike,
): Promise<ModelSelection> {
  // pi itself could not be found: say so once.
  const unavailable = (rt as { unavailableReason?: string }).unavailableReason;
  if (unavailable !== undefined && unavailable !== "") {
    throw new ModelError("model", unavailable);
  }

  if (spec === undefined) {
    const fallback = rt.defaultModel();
    if (!fallback) {
      throw new ModelError(
        "model",
        "this host has no default model — name one in the automation, or set a default with pi",
      );
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
    throw new ModelError(
      "model",
      `${JSON.stringify(spec)} is not <provider>/<id>[:<thinking>] — for example anthropic/claude-sonnet-4-5:low`,
    );
  }

  const { provider, id, thinking } = splitModelSpec(spec);

  const known = rt.providers();
  if (!known.includes(provider)) {
    throw new ModelError(
      "model",
      `provider ${JSON.stringify(provider)} is not registered — known: ${knownList(known, provider)}`,
    );
  }

  const model = rt.getModel(provider, id);
  if (!model) {
    throw new ModelError(
      "model",
      `${JSON.stringify(id)} is not in provider ${provider} — run pi --list-models ${provider}`,
    );
  }

  if (thinking !== undefined) {
    const supported = supportedThinkingLevels(model);
    if (!supported.includes(thinking)) {
      throw new ModelError(
        "model",
        `thinking level ${JSON.stringify(thinking)} is not supported by ${provider}/${id} — supported: ${supported.join(", ")}`,
      );
    }
  }

  if (!(await rt.checkAuth(provider))) {
    throw new ModelError("model", noCredentials(provider));
  }

  const identity: ResolvedModel = {
    provider,
    id,
    display: displayOf(provider, id, thinking),
  };
  if (thinking !== undefined) identity.thinking = thinking;
  return { identity, native: model };
}

/** The same question for a caller that never starts a session: identity only. */
export async function resolveModel(
  spec: string | undefined,
  rt: ModelRuntimeLike,
): Promise<ResolvedModel> {
  return (await selectModel(spec, rt)).identity;
}

function noCredentials(provider: string): string {
  return `no credentials for ${provider} — run pi /login (env vars are not visible to scheduled runs)`;
}

/** How many providers the "known:" list names before it gives up and says "…". */
export const KNOWN_PROVIDERS_SHOWN = 8;

/** The "known: …" provider list, nearest names first, truncated. */
export function knownList(known: string[], typed: string): string {
  const ranked = [...known].sort((a, b) => {
    const d = editDistance(a, typed) - editDistance(b, typed);
    return d !== 0 ? d : a.localeCompare(b);
  });
  const shown = ranked.slice(0, KNOWN_PROVIDERS_SHOWN);
  return shown.join(", ") + (ranked.length > shown.length ? ", …" : "");
}

/** Levenshtein distance, bounded by the short strings it is used on. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n] as number;
}

/** Classify a run failure from its text; anything unrecognised is `agent`. */
export function classifyFireError(e: unknown): ErrorKind {
  // An explicit `kind` wins, but only when it is one of the closed members.
  const declared = (e as { kind?: unknown })?.kind;
  if (typeof declared === "string" && (ERROR_KINDS as readonly string[]).includes(declared)) {
    return declared as ErrorKind;
  }

  const name = (e as { name?: string })?.name ?? "";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";

  const status = (e as { status?: number; statusCode?: number })?.status ??
    (e as { statusCode?: number })?.statusCode;
  if (typeof status === "number") {
    if (status === 401 || status === 402 || status === 403 || status === 429) {
      return "model-unavailable";
    }
    if (status >= 500) return "model-unavailable";
  }

  const text = `${name} ${(e as { message?: string })?.message ?? String(e ?? "")}`.toLowerCase();

  if (/\babort/.test(text)) return "timeout";

  if (
    /unauthor|forbidden|invalid api key|no credentials|authentication|credential|quota|rate limit|insufficient|billing|overload|unavailable|bad gateway|service unavailable|gateway timeout|econnrefused|enotfound|eai_again|socket hang up/.test(
      text,
    )
  ) {
    return "model-unavailable";
  }

  return "agent";
}

/** The runtime used when pi cannot be found: every run fails with a fix-naming record. */
export function unavailableRuntime(reason: string): ModelRuntimeLike {
  return {
    providers: () => [],
    getModel: () => undefined,
    checkAuth: async () => false,
    defaultModel: () => undefined,
    unavailableReason: reason,
  } as ModelRuntimeLike & { unavailableReason: string };
}
