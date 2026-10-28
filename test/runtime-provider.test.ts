/** The pi runtime provider: one instance owns the model it resolved. */

import { describe, expect, it, vi } from "vitest";

import {
  createPiRuntime,
  FOREIGN_MODEL_MESSAGE,
  OVERLAPPING_SESSION_MESSAGE,
} from "../src/providers/pi/runtime.js";
import { resolveModel as resolveAgainstCatalog, type ModelRuntimeLike } from "../src/model.js";
import type {
  ModelIdentity,
  RunContext,
  RuntimeModelRef,
  SessionLiveSink,
} from "../src/core/contracts.js";
import type { SessionHandle } from "../src/run.js";
import type { ResolvedModel } from "../src/types.js";

/** The native pi model, as far as anything here cares: an object with identity. */
const NATIVE = {
  id: "claude-sonnet-4-5",
  provider: "anthropic",
  native: "pi",
  /** `null` marks a level this model does not offer — the shape `supportedThinkingLevels` reads. */
  thinkingLevelMap: { xhigh: null },
};
const NATIVE_DEFAULT = { id: "default", provider: "anthropic", native: "pi-default" };

/** A catalog that answers from a table. */
function fakeCatalog(over: Partial<ModelRuntimeLike> = {}): ModelRuntimeLike {
  return {
    providers: () => ["anthropic", "openai"],
    getModel: (provider: string, id: string) =>
      provider === "anthropic" && id === NATIVE.id ? NATIVE : undefined,
    checkAuth: async () => true,
    defaultModel: (): ResolvedModel => ({
      provider: "anthropic",
      id: "default",
      display: "anthropic/default",
      raw: NATIVE_DEFAULT,
    }),
    ...over,
  } as ModelRuntimeLike;
}

/** A session adapter that records what it was handed and never touches pi. */
function recordingStarter() {
  const started: Array<{
    cwd: string;
    model: ResolvedModel;
    native: unknown;
    live?: SessionLiveSink;
  }> = [];
  const starter = async (args: {
    cwd: string;
    model: ResolvedModel;
    native: unknown;
    signal: AbortSignal;
    live?: SessionLiveSink;
  }): Promise<SessionHandle> => {
    started.push({
      cwd: args.cwd,
      model: args.model,
      native: args.native,
      ...(args.live ? { live: args.live } : {}),
    });
    return {
      file: "/sessions/fake.jsonl",
      id: "fake-session",
      prompt: async () => "done",
      dispose: () => {},
    };
  };
  return { starter, started };
}

function runtimeWith(over: Partial<ModelRuntimeLike> = {}) {
  const session = recordingStarter();
  const load = vi.fn(async () => fakeCatalog(over));
  const runtime = createPiRuntime({ loadServices: async () => ({ catalog: await load(), openSession: session.starter }) });
  return { runtime, session, load };
}

const START = { cwd: "/work", signal: new AbortController().signal };

/** The immutable per-run context every session start carries. */
const CONTEXT: RunContext = Object.freeze({
  runId: "run-1",
  key: "user:/a:x",
  name: "x",
  scope: "user",
  trigger: "manual",
  late: false,
  automationDir: "/a/x",
  rootDir: "/a",
  stateDir: "/state",
});

describe("a resolved model belongs to the runtime that resolved it", () => {
  it("resolves and starts on the same instance", async () => {
    const { runtime, session } = runtimeWith();

    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const handle = await runtime.startSession({ ...START, model, context: CONTEXT });

    expect(handle.id).toBe("fake-session");
    expect(session.started).toHaveLength(1);
    // The native object the catalog returned is what reached the session adapter — one runtime, one
    // model, no `raw: unknown` arriving from somewhere else.
    expect(session.started[0]?.native).toBe(NATIVE);
    expect(session.started[0]?.model.display).toBe("anthropic/claude-sonnet-4-5");
    // And the identity beside it is neutral.
    expect(session.started[0]?.model).not.toHaveProperty("raw");
    await handle.dispose();
  });

  it("refuses a reference resolved by another instance, before the SDK is touched", async () => {
    const a = runtimeWith();
    const b = runtimeWith();

    const fromA = await a.runtime.resolveModel("anthropic/claude-sonnet-4-5");
    // B has never resolved anything, so its loader has not run either.
    b.load.mockClear();

    await expect(b.runtime.startSession({ ...START, model: fromA, context: CONTEXT })).rejects.toThrow(
      FOREIGN_MODEL_MESSAGE,
    );

    // The refusal came first: no session was opened and the catalog was never asked for.
    expect(b.session.started).toEqual([]);
    expect(b.load).not.toHaveBeenCalled();
  });

  it("refuses a structural copy of its own reference", async () => {
    const { runtime, session } = runtimeWith();
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");

    // Same fields, different object. Identity is the whole point: a copy carries the identity a
    // record prints and none of the ownership a session needs.
    const copy = { ...model } as RuntimeModelRef;
    expect(copy.display).toBe(model.display);

    await expect(runtime.startSession({ ...START, model: copy, context: CONTEXT })).rejects.toThrow(
      FOREIGN_MODEL_MESSAGE,
    );
    expect(session.started).toEqual([]);
  });

  it("refuses a hand-built reference", async () => {
    const { runtime, session } = runtimeWith();
    const forged = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      display: "anthropic/claude-sonnet-4-5",
    } as unknown as RuntimeModelRef;

    await expect(runtime.startSession({ ...START, model: forged, context: CONTEXT })).rejects.toThrow(
      FOREIGN_MODEL_MESSAGE,
    );
    expect(session.started).toEqual([]);
  });

  it("hands core neutral identity only, frozen", async () => {
    const { runtime } = runtimeWith();
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5:low");

    expect(Object.keys(model).sort()).toEqual(["display", "id", "provider", "thinking"]);
    expect(Object.isFrozen(model)).toBe(true);
    // No escape hatch: nothing on the reference leads back to the SDK object.
    expect(Object.values(model).some((v) => v === NATIVE)).toBe(false);
    expect((model as unknown as { raw?: unknown }).raw).toBeUndefined();
  });

  it("gives each resolution its own reference, so one cannot be mistaken for another", async () => {
    const { runtime, session } = runtimeWith();
    const first = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const second = await runtime.resolveModel("anthropic/claude-sonnet-4-5");

    expect(second).not.toBe(first);
    // Both are owned, because both came from this instance. One at a time: a pi worker runs one
    // automation, and a second session while the first is open is refused — see
    // test/flow-context.test.ts.
    const one = await runtime.startSession({ ...START, model: first, context: CONTEXT });
    await one.dispose();
    const two = await runtime.startSession({ ...START, model: second, context: CONTEXT });
    await two.dispose();
    expect(session.started).toHaveLength(2);
  });
});

describe("one pi owner resolves the model and starts its session", () => {
  it("builds the owner ONCE and starts the session on it, never on a second one", async () => {
    // The defect this replaces: resolution created a pi ModelRuntime and session startup created
    // ANOTHER, then handed the first one's native model to the second. Counting owner construction
    // is the only way to see that from outside.
    let ownersBuilt = 0;
    const session = recordingStarter();
    const runtime = createPiRuntime({
      loadServices: async () => {
        ownersBuilt++;
        return { catalog: fakeCatalog(), openSession: session.starter };
      },
    });

    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    expect(ownersBuilt).toBe(1);

    const handle = await runtime.startSession({ ...START, model, context: CONTEXT });
    expect(ownersBuilt, "session startup built a second SDK owner").toBe(1);
    expect(session.started[0]?.native).toBe(NATIVE);
    await handle.dispose();

    // And a second run on the same instance still reuses it.
    const again = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    await (await runtime.startSession({ ...START, model: again, context: CONTEXT })).dispose();
    expect(ownersBuilt).toBe(1);
  });

  it("refuses a reference from a different owner as a HOST fault, not the agent's", async () => {
    const a = runtimeWith();
    const b = runtimeWith();
    const fromA = await a.runtime.resolveModel("anthropic/claude-sonnet-4-5");

    // The kind matters as much as the refusal: `classifyFireError` falls through to "agent" for an
    // unrecognised error, and the user would read "agent: ..." for a host composition mistake.
    await expect(
      b.runtime.startSession({ ...START, model: fromA, context: CONTEXT }),
    ).rejects.toMatchObject({ kind: "host", message: FOREIGN_MODEL_MESSAGE });

    expect(b.session.started).toHaveLength(0);
  });

  it("holds session exclusivity across the WORKER, not just one runtime instance", async () => {
    // The message promises one automation per pi worker. Two instances in one process is exactly
    // the case a per-instance flag could not cover, and `createPiServices()` is called at several
    // sites in the CLI.
    const a = runtimeWith();
    const b = runtimeWith();

    const first = await a.runtime.startSession({
      ...START,
      model: await a.runtime.resolveModel("anthropic/claude-sonnet-4-5"),
      context: CONTEXT,
    });

    await expect(
      b.runtime.startSession({
        ...START,
        model: await b.runtime.resolveModel("anthropic/claude-sonnet-4-5"),
        context: CONTEXT,
      }),
    ).rejects.toMatchObject({ kind: "host", message: OVERLAPPING_SESSION_MESSAGE });

    // The first session is untouched, and closing it releases the worker for the next one.
    await first.dispose();
    const second = await b.runtime.startSession({
      ...START,
      model: await b.runtime.resolveModel("anthropic/claude-sonnet-4-5"),
      context: CONTEXT,
    });
    await second.dispose();
  });
});

describe("the compiler refuses a native model where a reference belongs", () => {
  it("does not accept a pi model object", async () => {
    const { runtime } = runtimeWith();

    // @ts-expect-error a native pi model has none of the identity fields a reference is made of.
    await expect(runtime.startSession({ ...START, model: NATIVE, context: CONTEXT })).rejects.toThrow();
  });

  it("accepts what resolveModel returned", async () => {
    const { runtime, session } = runtimeWith();
    // The positive fixture: without it, the negative above could pass because EVERYTHING fails.
    const model: RuntimeModelRef = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    await (await runtime.startSession({ ...START, model, context: CONTEXT })).dispose();
    expect(session.started).toHaveLength(1);
  });

  it("is plain neutral identity to anything that only reads it", async () => {
    const { runtime } = runtimeWith();
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    // A reference IS an identity, so a listing or a record can take one without knowing anything
    // about runtimes.
    const identity: ModelIdentity = model;
    expect(identity.display).toBe("anthropic/claude-sonnet-4-5");
  });
});

describe("resolution is the existing one, unchanged", () => {
  it("keeps the exact wording for an unregistered provider", async () => {
    const { runtime } = runtimeWith();
    const direct = await resolveAgainstCatalog("mystery/thing", fakeCatalog()).catch(
      (e: unknown) => (e as Error).message,
    );

    await expect(runtime.resolveModel("mystery/thing")).rejects.toThrow(String(direct));
    // The nearest registered names come first, so a typo is offered its correction.
    expect(String(direct)).toBe(
      'model: provider "mystery" is not registered — known: openai, anthropic',
    );
  });

  it("keeps the exact wording for a model the provider does not have", async () => {
    const { runtime } = runtimeWith();
    await expect(runtime.resolveModel("anthropic/nope")).rejects.toThrow(
      'model: "nope" is not in provider anthropic — run pi --list-models anthropic',
    );
  });

  it("keeps the exact wording for missing credentials", async () => {
    const { runtime } = runtimeWith({ checkAuth: async () => false });
    await expect(runtime.resolveModel("anthropic/claude-sonnet-4-5")).rejects.toThrow(
      "model: no credentials for anthropic — run pi /login (env vars are not visible to scheduled runs)",
    );
  });

  it("keeps the check order: a file problem is reported before a machine one", async () => {
    // The model does not offer `xhigh` AND there are no credentials. The author should be told
    // about the file first, so they fix it once instead of logging in and finding a second error.
    const { runtime } = runtimeWith({ checkAuth: async () => false });
    await expect(runtime.resolveModel("anthropic/claude-sonnet-4-5:xhigh")).rejects.toThrow(
      'model: thinking level "xhigh" is not supported by anthropic/claude-sonnet-4-5 — supported: off, minimal, low, medium, high, max',
    );
  });

  it("uses the host default when the automation names no model", async () => {
    const { runtime, session } = runtimeWith();
    const model = await runtime.resolveModel(undefined);

    expect(model.display).toBe("anthropic/default");
    await (await runtime.startSession({ ...START, model, context: CONTEXT })).dispose();
    // The default's own native object, not the catalogued one.
    expect(session.started[0]?.native).toBe(NATIVE_DEFAULT);
  });

  it("never substitutes another model", async () => {
    const { runtime, session } = runtimeWith();
    await expect(runtime.resolveModel("anthropic/nope")).rejects.toThrow();
    // Nothing silently fell back to the default.
    expect(session.started).toEqual([]);
  });
});

describe("pi is loaded late, and a missing pi stays actionable", () => {
  it("loads nothing until a model is resolved", async () => {
    const load = vi.fn(async () => fakeCatalog());
    const runtime = createPiRuntime({ loadServices: async () => ({ catalog: await load(), openSession: recordingStarter().starter }) });

    // Composed, exported, imported — and still nothing has been loaded.
    expect(load).not.toHaveBeenCalled();
    await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads once, however many models it is asked for", async () => {
    const { runtime, load } = runtimeWith();
    await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reports a missing pi as itself, not as a confusing consequence", async () => {
    const missing = "pi is not installed beside this package — set piModule in config.json";
    const runtime = createPiRuntime({
      loadServices: async () => {
        throw new Error(missing);
      },
    });

    // The run still gets a one-line actionable failure, exactly as `bin/fire.js` has always
    // produced through `unavailableRuntime` — not a stack trace, and not "no default model".
    await expect(runtime.resolveModel(undefined)).rejects.toThrow(missing);
    await expect(runtime.resolveModel("anthropic/claude-sonnet-4-5")).rejects.toThrow(missing);
  });

  it("does not retry a load that already failed", async () => {
    const load = vi.fn(async (): Promise<ModelRuntimeLike> => {
      throw new Error("pi is missing");
    });
    const runtime = createPiRuntime({ loadServices: async () => ({ catalog: await load(), openSession: recordingStarter().starter }) });

    await expect(runtime.resolveModel(undefined)).rejects.toThrow("pi is missing");
    await expect(runtime.resolveModel(undefined)).rejects.toThrow("pi is missing");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("survives a thrown non-Error", async () => {
    const runtime = createPiRuntime({
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      loadServices: async (): Promise<never> => {
        throw "pi exploded";
      },
    });
    await expect(runtime.resolveModel(undefined)).rejects.toThrow("pi exploded");
  });
});

describe("what the session adapter is handed", () => {
  it("refuses a pre-aborted start before opening a session", async () => {
    const { runtime, session } = runtimeWith();
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.startSession({ ...START, signal: controller.signal, model, context: CONTEXT }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(session.started).toEqual([]);
  });

  it("disposes a session whose construction finishes after cancellation", async () => {
    let finish!: (handle: SessionHandle) => void;
    const dispose = vi.fn(async () => {});
    const started = new Promise<SessionHandle>((resolve) => {
      finish = resolve;
    });
    const runtime = createPiRuntime({
      loadServices: async () => ({
        catalog: fakeCatalog(),
        openSession: async () => started,
      }),
    });
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    const controller = new AbortController();
    const opening = runtime.startSession({
      ...START,
      signal: controller.signal,
      model,
      context: CONTEXT,
    });

    controller.abort();
    finish({
      file: "/sessions/late.jsonl",
      id: "late",
      prompt: async () => "must not run",
      dispose,
    });

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("passes the working directory, the signal and the live sink through", async () => {
    const { runtime, session } = runtimeWith();
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5:low");
    const live: SessionLiveSink = {
      partial: () => {},
      thinking: () => {},
      message: () => {},
      tool: () => {},
    };

    await (await runtime.startSession({ cwd: "/somewhere", signal: START.signal, model, live, context: CONTEXT })).dispose();

    expect(session.started[0]?.cwd).toBe("/somewhere");
    expect(session.started[0]?.live).toBe(live);
    expect(session.started[0]?.model.thinking).toBe("low");
  });

  it("omits thinking entirely when none was selected", async () => {
    const { runtime, session } = runtimeWith();
    const model = await runtime.resolveModel("anthropic/claude-sonnet-4-5");
    await (await runtime.startSession({ ...START, model, context: CONTEXT })).dispose();

    expect("thinking" in (session.started[0]?.model ?? {})).toBe(false);
  });
});
