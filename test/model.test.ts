import { describe, expect, it } from "vitest";

import { ModelError } from "../src/errors.js";
import {
  classifyFireError,
  displayOf,
  KNOWN_PROVIDERS_SHOWN,
  knownList,
  resolveModel,
  selectModel,
  splitModelSpec,
  supportedThinkingLevels,
  THINKING_LEVELS,
  unavailableRuntime,
} from "../src/model.js";
import type { DefaultModelLike, ModelLike, ModelRuntimeLike } from "../src/model.js";

interface FakeOptions {
  providers?: string[];
  models?: Record<string, ModelLike[]>;
  authed?: string[];
  authThrows?: string[];
  fallback?: DefaultModelLike | undefined;
}

/** A runtime with exactly the knowledge each test needs, and a record of what was asked. */
function fakeRuntime(opts: FakeOptions = {}) {
  const providers = opts.providers ?? ["anthropic", "openai", "google"];
  const models = opts.models ?? {
    anthropic: [
      {
        id: "claude-sonnet-4-5",
        provider: "anthropic",
        thinkingLevelMap: { off: "", low: "l", medium: "m", high: "h", xhigh: null, max: null, minimal: null },
      },
    ],
    openai: [{ id: "gpt-5.2", provider: "openai" }],
    google: [{ id: "gemini-2.5-pro", provider: "google" }],
  };
  const authed = new Set(opts.authed ?? providers);
  const authThrows = new Set(opts.authThrows ?? []);

  const asked: string[] = [];

  const rt: ModelRuntimeLike & { asked: string[] } = {
    asked,
    providers: () => providers,
    getModel(provider, id) {
      return (models[provider] ?? []).find((m) => m.id === id);
    },
    async checkAuth(provider) {
      asked.push(provider);
      if (authThrows.has(provider)) throw new Error("auth backend exploded");
      return authed.has(provider);
    },
    defaultModel: () => opts.fallback,
  };
  return rt;
}

async function refusal(spec: string | undefined, rt: ModelRuntimeLike): Promise<string> {
  try {
    await resolveModel(spec, rt);
  } catch (e) {
    expect(e).toBeInstanceOf(ModelError);
    return (e as ModelError).message;
  }
  throw new Error(`${spec} was accepted but should have been refused`);
}

describe("splitModelSpec", () => {
  it("splits provider, id and thinking level", () => {
    expect(splitModelSpec("anthropic/claude-sonnet-4-5:low")).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      thinking: "low",
    });
  });

  it("leaves a colon that belongs to the model id alone", () => {
    // OpenRouter ships ids such as `model:exacto`; `exacto` is not a thinking level, so it stays.
    expect(splitModelSpec("openrouter/some-model:exacto")).toEqual({
      provider: "openrouter",
      id: "some-model:exacto",
    });
  });

  it("keeps a Bedrock version suffix as part of the id", () => {
    expect(splitModelSpec("amazon-bedrock/amazon.nova-2-lite-v1:0")).toEqual({
      provider: "amazon-bedrock",
      id: "amazon.nova-2-lite-v1:0",
    });
  });

  it("splits a thinking level off an id that already contains a colon", () => {
    expect(splitModelSpec("amazon-bedrock/amazon.nova-2-lite-v1:0:high")).toEqual({
      provider: "amazon-bedrock",
      id: "amazon.nova-2-lite-v1:0",
      thinking: "high",
    });
  });

  it("handles a spec with no thinking level", () => {
    expect(splitModelSpec("openai/gpt-5.2")).toEqual({ provider: "openai", id: "gpt-5.2" });
  });
});

describe("resolveModel — accepts", () => {
  it("resolves a fully specified model and keeps the runtime object with the selection", async () => {
    const rt = fakeRuntime();
    const r = await resolveModel("anthropic/claude-sonnet-4-5:low", rt);
    expect(r.provider).toBe("anthropic");
    expect(r.id).toBe("claude-sonnet-4-5");
    expect(r.thinking).toBe("low");
    expect(r.display).toBe("anthropic/claude-sonnet-4-5:low");
    // Identity only. A listing gets this, and nothing in it can open a session.
    expect(Object.keys(r).sort()).toEqual(["display", "id", "provider", "thinking"]);

    // The catalog's own object travels beside the identity, for whoever will START the session.
    const selected = await selectModel("anthropic/claude-sonnet-4-5:low", rt);
    expect(selected.identity).toEqual(r);
    expect(selected.native).toBe(rt.getModel("anthropic", "claude-sonnet-4-5"));
  });

  it("resolves without a thinking level", async () => {
    const r = await resolveModel("openai/gpt-5.2", fakeRuntime());
    expect(r.display).toBe("openai/gpt-5.2");
    expect(r.thinking).toBeUndefined();
  });

  it("falls back to the host default when the automation names no model", async () => {
    const native = { id: "claude-sonnet-4-5" };
    const fallback: DefaultModelLike = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      display: "anthropic/claude-sonnet-4-5",
      raw: native,
    };
    const r = await resolveModel(undefined, fakeRuntime({ fallback }));
    expect(r).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      display: "anthropic/claude-sonnet-4-5",
    });

    // The default's own catalog object is what a session would be started with.
    const selected = await selectModel(undefined, fakeRuntime({ fallback }));
    expect(selected.native).toBe(native);
  });

  it("composes a display for a default that does not carry one", async () => {
    const fallback: DefaultModelLike = { provider: "openai", id: "gpt-5.2" };
    const r = await resolveModel(undefined, fakeRuntime({ fallback }));
    expect(r.display).toBe("openai/gpt-5.2");
    // With no distinct catalog object, the record the catalog returned IS the model.
    const selected = await selectModel(undefined, fakeRuntime({ fallback }));
    expect(selected.native).toBe(fallback);
  });

  it("accepts every thinking level the model does not mark null", async () => {
    const rt = fakeRuntime();
    for (const level of ["off", "low", "medium", "high"]) {
      const r = await resolveModel(`anthropic/claude-sonnet-4-5:${level}`, rt);
      expect(r.thinking, level).toBe(level);
    }
  });
});

describe("resolveModel — the four specification error lines", () => {
  it("provider is not registered, and lists the ones that are, nearest first", () => {
    return refusal("anthropc/claude-sonnet-4-5", fakeRuntime()).then((msg) => {
      expect(msg.startsWith('model: provider "anthropc" is not registered — known: anthropic')).toBe(
        true,
      );
      // The rest of the list is ordered by distance from the typo; membership is what matters.
      for (const p of ["anthropic", "openai", "google"]) expect(msg).toContain(p);
      expect(msg.endsWith("…")).toBe(false);
    });
  });

  it("puts the nearest provider first and truncates a long list", async () => {
    const many = [
      "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "baseten",
      "cerebras", "deepseek", "fireworks", "github-copilot", "google", "groq", "mistral",
      "openai", "openrouter", "together", "xai", "zai",
    ];
    const msg = await refusal("anthropc/x", fakeRuntime({ providers: many }));
    expect(msg.startsWith('model: provider "anthropc" is not registered — known: anthropic,')).toBe(
      true,
    );
    expect(msg.endsWith(", …")).toBe(true);
    expect(msg.split("known: ")[1]?.split(", ").length).toBe(KNOWN_PROVIDERS_SHOWN + 1);
    expect(msg.length).toBeLessThan(200);
  });

  it("does not truncate when every provider fits", () => {
    expect(knownList(["a", "b", "c"], "q")).toBe("a, b, c");
    expect(knownList(["a", "b", "c"], "q").endsWith("…")).toBe(false);
  });

  it("model is not in the provider", async () => {
    const msg = await refusal("anthropic/nope", fakeRuntime());
    expect(msg).toBe(
      'model: "nope" is not in provider anthropic — run pi --list-models anthropic',
    );
  });

  it("no credentials, and says env vars will not help", async () => {
    const msg = await refusal("anthropic/claude-sonnet-4-5", fakeRuntime({ authed: [] }));
    expect(msg).toBe(
      "model: no credentials for anthropic — run pi /login (env vars are not visible to scheduled runs)",
    );
  });

  it("thinking level is not supported, and lists the ones that are", async () => {
    const msg = await refusal("anthropic/claude-sonnet-4-5:xhigh", fakeRuntime());
    expect(msg).toBe(
      'model: thinking level "xhigh" is not supported by anthropic/claude-sonnet-4-5 — supported: off, low, medium, high',
    );
  });

  it("every refusal is exactly one line beginning with the field", async () => {
    const rt = fakeRuntime({ authed: [] });
    for (const spec of [
      "anthropc/x",
      "anthropic/nope",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-5:xhigh",
    ]) {
      const msg = await refusal(spec, rt);
      expect(msg.split("\n"), spec).toHaveLength(1);
      expect(msg.startsWith("model: "), spec).toBe(true);
    }
  });
});

describe("resolveModel — check order and safety", () => {
  it("reports the file problem before the machine problem", async () => {
    // Logged out AND a bad thinking level. Telling the author to log in first would have them fix
    // the machine and only then discover the file was wrong too.
    const rt = fakeRuntime({ authed: [] });
    expect(await refusal("anthropic/claude-sonnet-4-5:xhigh", rt)).toContain("thinking level");
  });

  it("does not ask about credentials when the file itself is wrong", async () => {
    const rt = fakeRuntime({ authed: [] });
    await refusal("anthropic/nope", rt);
    expect(rt.asked).toEqual([]);
  });

  it("never substitutes another model when the named one is missing", async () => {
    const fallback: DefaultModelLike = {
      provider: "openai",
      id: "gpt-5.2",
      display: "openai/gpt-5.2",
      raw: {},
    };
    const rt = fakeRuntime({ fallback });
    // A default exists, but the named model does not — the answer is a refusal, not the default.
    expect(await refusal("anthropic/nope", rt)).toContain("is not in provider anthropic");
  });

  it("treats a throwing auth check as no credentials rather than as success", async () => {
    const rt = fakeRuntime({ authThrows: ["anthropic"] });
    // The adapter swallows the throw; here the fake throws, so resolveModel must propagate a
    // refusal rather than arming an automation whose credentials are unknown.
    await expect(resolveModel("anthropic/claude-sonnet-4-5", rt)).rejects.toThrow();
  });

  it("refuses when there is no default model and none was named", async () => {
    const msg = await refusal(undefined, fakeRuntime({ fallback: undefined }));
    expect(msg).toContain("no default model");
  });

  it("checks credentials for the default model too", async () => {
    const fallback: DefaultModelLike = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      display: "anthropic/claude-sonnet-4-5",
      raw: {},
    };
    const msg = await refusal(undefined, fakeRuntime({ fallback, authed: [] }));
    expect(msg).toContain("no credentials for anthropic");
  });

  it("refuses a spec whose shape is wrong even if it reaches this far", async () => {
    expect(await refusal("claude-sonnet-4-5", fakeRuntime())).toContain(
      "is not <provider>/<id>[:<thinking>]",
    );
  });
});

describe("supportedThinkingLevels", () => {
  it("drops the levels the model marks null", () => {
    expect(
      supportedThinkingLevels({
        id: "m",
        provider: "p",
        thinkingLevelMap: { off: "", low: "l", high: "h", xhigh: null, max: null, minimal: null, medium: null },
      }),
    ).toEqual(["off", "low", "high"]);
  });

  it("assumes every level when the model publishes no map", () => {
    expect(supportedThinkingLevels({ id: "m", provider: "p" })).toEqual([...THINKING_LEVELS]);
  });
});

describe("displayOf", () => {
  it("renders with and without a thinking level", () => {
    expect(displayOf("anthropic", "x", "low")).toBe("anthropic/x:low");
    expect(displayOf("anthropic", "x")).toBe("anthropic/x");
  });
});

describe("classifyFireError", () => {
  it("calls an abort a timeout", () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    expect(classifyFireError(e)).toBe("timeout");
    expect(classifyFireError(new Error("Request aborted"))).toBe("timeout");
  });

  it("calls auth, quota and 5xx failures model-unavailable", () => {
    expect(classifyFireError({ status: 401, message: "Unauthorized" })).toBe("model-unavailable");
    expect(classifyFireError({ status: 429, message: "Too Many Requests" })).toBe(
      "model-unavailable",
    );
    expect(classifyFireError({ status: 503, message: "Service Unavailable" })).toBe(
      "model-unavailable",
    );
    expect(classifyFireError(new Error("Invalid API key"))).toBe("model-unavailable");
    expect(classifyFireError(new Error("getaddrinfo ENOTFOUND api.anthropic.com"))).toBe(
      "model-unavailable",
    );
  });

  it("calls anything unrecognised an agent error rather than guessing", () => {
    // Mislabelling a bug as model-unavailable sends someone to check credentials for no reason.
    expect(classifyFireError(new Error("Cannot read properties of undefined"))).toBe("agent");
    expect(classifyFireError({ status: 404, message: "Not Found" })).toBe("agent");
    expect(classifyFireError("something odd")).toBe("agent");
    expect(classifyFireError(undefined)).toBe("agent");
  });
});

describe("unavailableRuntime — a missing pi is reported as itself", () => {
  // `bin/fire.js` falls back to this when the SDK cannot be loaded, so that a run still takes its
  // lock and still writes a record.
  const REASON = "pi: cannot find @earendil-works/pi-coding-agent from a background run — install pi";

  it("reports the real cause when the automation names no model", async () => {
    await expect(resolveModel(undefined, unavailableRuntime(REASON))).rejects.toThrow(REASON);
  });

  it("reports the real cause when the automation DOES name a model", async () => {
    // Without the check this says `provider "anthropic" is not registered — known: (none)`.
    await expect(
      resolveModel("anthropic/claude-sonnet-4-5", unavailableRuntime(REASON)),
    ).rejects.toThrow(REASON);
  });

  it("is a ModelError, so the run records it the same way as any other model refusal", async () => {
    await expect(resolveModel(undefined, unavailableRuntime(REASON))).rejects.toBeInstanceOf(
      ModelError,
    );
  });

  it("answers honestly about what it has, rather than pretending", () => {
    const rt = unavailableRuntime(REASON);
    expect(rt.providers()).toEqual([]);
    expect(rt.getModel("anthropic", "x")).toBeUndefined();
    expect(rt.defaultModel()).toBeUndefined();
  });

  it("does not hijack a real runtime that happens to have no providers", async () => {
    // A logged-out but present pi must still get the ordinary message, not the pi-missing one.
    const empty: ModelRuntimeLike = {
      providers: () => [],
      getModel: () => undefined,
      checkAuth: async () => false,
      defaultModel: () => undefined,
    };
    await expect(resolveModel(undefined, empty)).rejects.toThrow("no default model");
  });
});
