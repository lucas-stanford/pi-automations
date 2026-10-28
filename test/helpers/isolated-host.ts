/** An isolated host for behaviour tests. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULTS } from "../../src/config.js";
import { discover } from "../../src/discover.js";
import { runLocalScript } from "../../src/providers/scripts.js";
import { State } from "../../src/state.js";
import { Trust } from "../../src/trust.js";
import type { Config, Located, ResolvedModel, Root, RunRecord } from "../../src/types.js";
import type {
  AutomationRuntime,
  RuntimeModelRef,
  RuntimeSessionStart,
} from "../../src/core/contracts.js";
import type { SessionHandle } from "../../src/run.js";
import { tempDir } from "./temp.js";
import { armForTest } from "./arm.js";

/**
 * One fixed instant for every characterization fixture.
 *
 * Chosen rather than scrubbed: a frozen clock means the rendered output is byte-stable by
 * construction, so a diff in a fixture is a real behaviour change and not a timestamp.
 */
export const HOST_NOW = new Date("2026-09-17T14:00:00.000Z");

/** Notifications cannot be delivered from an isolated host, twice over. */
export const HOST_CONFIG: Config = Object.freeze({ ...DEFAULTS, notifyOnFailed: false });

/** A runtime that resolves from a table and opens a recording session. */
export function fakeRuntime(over: FakeRuntimeOptions = {}): AutomationRuntime {
  const identity: ResolvedModel = over.model ?? {
    provider: "anthropic",
    id: "default",
    display: "anthropic/default",
  };

  const startSession = over.startSession ?? fakeSession().starter;

  return {
    resolveModel: over.resolveModel ?? (async () => Object.freeze({ ...identity }) as RuntimeModelRef),
    startSession,
  };
}

export interface FakeRuntimeOptions {
  /** The identity every resolution answers with. */
  model?: ResolvedModel;
  /** Rejects instead of resolving, for a test about a model that cannot be resolved. */
  resolveModel?: (spec: string | undefined) => Promise<RuntimeModelRef>;
  /** How a session is opened. Defaults to a fresh recording session. */
  startSession?: (start: RuntimeSessionStart) => Promise<SessionHandle>;
}

export interface FakeSession {
  starter: (start: RuntimeSessionStart) => Promise<SessionHandle>;
  /** Every prompt the run asked, in order. */
  asked: string[];
  readonly opened: number;
  readonly disposed: number;
}

/** A session that records what it was asked and answers from a script. */
export function fakeSession(answers: string[] = []): FakeSession {
  const asked: string[] = [];
  let disposed = 0;
  let opened = 0;
  let i = 0;

  const starter = async (): Promise<SessionHandle> => {
    opened++;
    return {
      file: "/sessions/fake.jsonl",
      id: "fake-session",
      async prompt(text: string) {
        asked.push(text);
        return answers[i++] ?? "done";
      },
      dispose() {
        disposed++;
      },
    };
  };

  return {
    starter,
    asked,
    get opened() {
      return opened;
    },
    get disposed() {
      return disposed;
    },
  };
}

/** A notification sink that records instead of delivering. */
export function recordingNotifier(): {
  sink: (rec: RunRecord) => Promise<void>;
  delivered: RunRecord[];
} {
  const delivered: RunRecord[] = [];
  return {
    delivered,
    sink: async (rec: RunRecord) => {
      delivered.push(rec);
    },
  };
}

export interface IsolatedAutomation {
  located: Located;
  /** The explicit discovery root. Never the operator's real automations directory. */
  roots: Root[];
  root: string;
  dir: string;
  stateDir: string;
}

/**
 * Write one automation into a fresh temporary root and locate it.
 *
 * Scripts are JavaScript so they behave identically on every OS, and every call gets its own
 * directory so nothing shares state between tests.
 */
export function isolatedAutomation(spec: {
  name?: string;
  frontmatter: string;
  body?: string;
  scripts?: Record<string, string>;
  scope?: "user" | "repository";
  files?: Record<string, string>;
}): IsolatedAutomation {
  const name = spec.name ?? "test-automation";
  const home = tempDir("pi-compat-");
  const root = path.join(home, "automations");
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: ${name}\ndescription: A test automation.\n${spec.frontmatter}---\n\n${spec.body ?? "Do the thing."}\n`,
  );

  for (const [rel, body] of Object.entries({ ...spec.scripts, ...spec.files })) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }

  const roots: Root[] = [{ path: root, scope: spec.scope ?? "user", kind: "agents" }];
  const found = discover({ roots });
  const first = found[0];
  if (!first?.ok) {
    throw new Error(`fixture did not parse: ${first && !first.ok ? first.error : "not found"}`);
  }

  const stateDir = tempDir("pi-compat-state-");
  // A user automation is off until armed; these fixtures are about what happens once it is.
  if ((spec.scope ?? "user") === "user") armForTest(first.located, stateDir);

  return {
    located: first.located,
    roots,
    root,
    dir,
    stateDir,
  };
}

export { armForTest };

/** The one runtime `fire` takes, from an override object that may still name a session starter. */
export function fireRuntimeFrom(over: Record<string, unknown>): {
  runtime: AutomationRuntime;
  rest: Record<string, unknown>;
} {
  const { startSession, runtime, ...rest } = over as {
    startSession?: FakeRuntimeOptions["startSession"];
    runtime?: AutomationRuntime;
  } & Record<string, unknown>;

  return {
    runtime: runtime ?? fakeRuntime(startSession ? { startSession } : {}),
    rest,
  };
}

/** Dependencies for `fire`, with nothing real attached. */
export function isolatedFireDeps(
  stateDir: string,
  over: Record<string, unknown> = {},
): Parameters<typeof import("../../src/run.js").fire>[2] {
  const { runtime, rest } = fireRuntimeFrom(over);

  return {
    config: HOST_CONFIG,
    stateDir,
    trust: new Trust(stateDir),
    state: new State(stateDir),
    runtime,
    runScript: runLocalScript,
    // A sink that records. Not "notifications turned off" — there is no desktop path composed here
    // at all, so a fixture cannot raise a real toast even if a config flag were flipped.
    notify: recordingNotifier().sink,
    hookTimeoutMs: 4000,
    ...rest,
  } as Parameters<typeof import("../../src/run.js").fire>[2];
}
