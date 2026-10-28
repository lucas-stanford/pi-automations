/** The workspace seam. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { digestOf } from "../src/digest.js";
import { discover } from "../src/discover.js";
import { prepareLocalWorkspace, workspaceFailureDetail } from "../src/providers/workspace.js";
import { readRecords } from "../src/records.js";
import { State } from "../src/state.js";
import { interpreterMap } from "../src/status.js";
import { Trust } from "../src/trust.js";
import { fire } from "../src/run.js";
import type {
  PrepareWorkspace,
  WorkspacePreparation,
  WorkspaceRequest,
} from "../src/core/contracts.js";
import type { Located } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";
import { fakeSession, fireRuntimeFrom, HOST_NOW } from "./helpers/isolated-host.js";

vi.mock("../src/notify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify.js")>();
  return { ...actual, notifyFailed: async () => {} };
});

afterAll(cleanupTempDirs);

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  located: Located;
  stateDir: string;
  repo: string;
}

function fixture(name = "workspace-one"): Fixture {
  const repo = tempDir("pi-ws-repo-");
  const dir = path.join(repo, ".agents", "automations", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: ${name}\ndescription: A test automation.\non:\n  manual: true\n---\n\nDo the thing.\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, stdio: "ignore", windowsHide: true });

  const roots = [{ path: path.join(repo, ".agents", "automations"), scope: "repository" as const, kind: "agents" as const }];
  const found = discover({ roots, cwd: repo });
  const first = found[0];
  if (!first?.ok) throw new Error("fixture did not parse");

  const stateDir = tempDir("pi-ws-state-");
  const trust = new Trust(stateDir);
  trust.arm(first.located, digestOf(first.located), interpreterMap(first.located), HOST_NOW, 30 * 24 * 3600 * 1000);
  trust.save();

  return { located: first.located, stateDir, repo };
}

function deps(f: Fixture, over: Record<string, unknown> = {}) {
  const { runtime, rest } = fireRuntimeFrom(over);
  return {
    config: { ...DEFAULTS, notifyOnFailed: false, worktree: { [f.located.key]: true } },
    stateDir: f.stateDir,
    trust: new Trust(f.stateDir),
    state: new State(f.stateDir),
    runtime,
    hookTimeoutMs: 4000,
    ...rest,
  } as Parameters<typeof fire>[2];
}

const MANUAL = { trigger: "manual" as const, now: () => HOST_NOW };
const describeGit = gitAvailable() ? describe : describe.skip;

describe("the contract module", () => {
  it("emits no executable code", () => {
    const js = readFileSync(
      path.join(import.meta.dirname, "..", "dist", "core", "contracts.js"),
      "utf8",
    );
    // Comments and the empty-module marker only. Anything else means a runtime dependency has
    // appeared in the middle of the portable core.
    const code = js
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    expect(code).toEqual(["export {};"]);
  });

  it("declares no type that already exists elsewhere", () => {
    const src = readFileSync(
      path.join(import.meta.dirname, "..", "src", "core", "contracts.ts"),
      "utf8",
    );
    // `Scope` and `Trigger` are imported, never redeclared. A twin declaration is two sources of
    // truth for one idea, and the compiler would not complain about it.
    expect(src).toMatch(/import type \{ Scope, Trigger \} from "\.\.\/types\.js";/);
    expect(src).not.toMatch(/^export type Scope\b/m);
    expect(src).not.toMatch(/^export type Trigger\b/m);
    expect(src).not.toMatch(/^export interface (RunRecord|Status|Config|Root)\b/m);
  });
});

describeGit("the local workspace provider", () => {
  it("hands back the base directory when nothing was requested", async () => {
    const f = fixture("plain-one");
    const result = await prepareLocalWorkspace({
      context: fakeContext(f),
      baseCwd: f.repo,
      repositoryRoot: f.repo,
      isolated: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.cwd).toBe(f.repo);
    // Releasing a directory we did not create must do nothing at all.
    await result.workspace.release();
    expect(existsSync(f.repo)).toBe(true);
  });

  it("creates and then removes a real worktree", async () => {
    const f = fixture("isolated-two");
    const result = await prepareLocalWorkspace({
      context: fakeContext(f),
      baseCwd: f.repo,
      repositoryRoot: f.repo,
      isolated: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dir = result.workspace.cwd;
    expect(dir).not.toBe(f.repo);
    expect(existsSync(path.join(dir, ".git"))).toBe(true);

    await result.workspace.release();
    expect(existsSync(dir)).toBe(false);
  });

  it("returns a typed failure, not a fallback, when git cannot", async () => {
    const f = fixture("broken-three");
    writeFileSync(path.join(f.repo, ".git", "HEAD"), "ref: refs/heads/nowhere-at-all\n");

    const result = await prepareLocalWorkspace({
      context: fakeContext(f),
      baseCwd: f.repo,
      repositoryRoot: f.repo,
      isolated: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("workspace-preparation");
    expect(result.failure.repository).toBe(f.repo);
    expect(result.failure.intendedPath).toContain("pi-automations-wt-");
    expect(result.failure.detail).toMatch(/^(fatal|error):/i);
    // The partial workspace it created is gone, and nothing else was touched.
    expect(existsSync(result.failure.intendedPath as string)).toBe(false);
    expect(existsSync(f.repo)).toBe(true);
  });

  it("prefers git's diagnosis over its preamble, and falls back to the thrown error", () => {
    expect(
      workspaceFailureDetail({
        stderr: "warning: HEAD points to an invalid (or orphaned) reference.\nfatal: bad object HEAD\n",
      }),
    ).toBe("fatal: bad object HEAD");
    expect(workspaceFailureDetail(new Error("spawnSync git ENOENT"))).toBe("spawnSync git ENOENT");
    expect(workspaceFailureDetail({ stderr: "x".repeat(4000) }).length).toBeLessThanOrEqual(161);
  });
});

describeGit("the run consumes whatever function it is given", () => {
  it("preserves the B1 refusal when the injected function refuses", async () => {
    const f = fixture("injected-refusal");
    const refusing: PrepareWorkspace = async () => ({
      ok: false,
      failure: {
        kind: "workspace-preparation",
        repository: "/no/such/repo",
        intendedPath: "/no/such/workspace",
        detail: "fatal: this host has no git",
      },
    });
    const session = fakeSession();

    const rec = await fire(
      f.located,
      MANUAL,
      deps(f, { prepareWorkspace: refusing, startSession: session.starter }),
    );

    expect(rec.outcome).toBe("failed");
    expect(rec.error?.kind).toBe("host");
    expect(rec.error?.message).toContain("/no/such/repo");
    expect(rec.error?.message).toContain("/no/such/workspace");
    expect(rec.error?.message).toContain("this host has no git");
    expect(readRecords(f.stateDir, f.located.key, 100)).toHaveLength(1);
    expect(session.opened).toBe(0);
  });

  it("runs the body in whatever directory the function returns", async () => {
    const f = fixture("injected-cwd");
    const elsewhere = tempDir("pi-ws-elsewhere-");
    let released = 0;
    const injected: PrepareWorkspace = async () => ({
      ok: true,
      workspace: {
        cwd: elsewhere,
        async release() {
          released++;
        },
      },
    });
    const seen: string[] = [];
    const starter = async (args: { cwd: string }) => {
      seen.push(args.cwd);
      return {
        file: "/sessions/fake.jsonl",
        id: "fake",
        async prompt() {
          return "done";
        },
        dispose() {},
      };
    };

    const rec = await fire(
      f.located,
      MANUAL,
      deps(f, { prepareWorkspace: injected, startSession: starter }),
    );

    expect(rec.outcome).toBe("ok");
    expect(seen).toEqual([elsewhere]);
    // Released exactly once, in the run's finally.
    expect(released).toBe(1);
  });

  it("releases exactly once on every path, including a failure", async () => {
    const f = fixture("release-once");
    let released = 0;
    const injected: PrepareWorkspace = async () => ({
      ok: true,
      workspace: {
        cwd: f.repo,
        async release() {
          released++;
        },
      },
    });
    const starter = async () => {
      throw new Error("the model refused");
    };

    const rec = await fire(
      f.located,
      MANUAL,
      deps(f, { prepareWorkspace: injected, startSession: starter }),
    );

    expect(rec.outcome).toBe("failed");
    expect(released).toBe(1);
  });

  it("is given an immutable context describing the run", async () => {
    const f = fixture("context-shape");
    const seen: WorkspaceRequest[] = [];
    const injected: PrepareWorkspace = async (request): Promise<WorkspacePreparation> => {
      seen.push(request);
      return { ok: true, workspace: { cwd: f.repo, async release() {} } };
    };

    await fire(
      f.located,
      { trigger: "schedule", scheduledFor: "2026-09-17T07:00:00.000Z", late: true, now: () => HOST_NOW },
      deps(f, { prepareWorkspace: injected }),
    );

    expect(seen).toHaveLength(1);
    const request = seen[0] as WorkspaceRequest;
    expect(request.isolated).toBe(true);
    expect(request.repositoryRoot).toBe(f.repo);
    expect(request.baseCwd).toBe(f.repo);
    expect(request.context.key).toBe(f.located.key);
    expect(request.context.name).toBe("context-shape");
    expect(request.context.scope).toBe("repository");
    expect(request.context.trigger).toBe("schedule");
    expect(request.context.scheduledFor).toBe("2026-09-17T07:00:00.000Z");
    expect(request.context.late).toBe(true);
    expect(request.context.automationDir).toBe(f.located.dir);
    expect(request.context.rootDir).toBe(f.located.root.path);
    expect(request.context.stateDir).toBe(f.stateDir);
    expect(Object.isFrozen(request.context)).toBe(true);
  });

  it("still uses the local provider when nothing is injected", async () => {
    const f = fixture("default-provider");
    const seen: string[] = [];
    const starter = async (args: { cwd: string }) => {
      seen.push(args.cwd);
      return { file: "", id: "", async prompt() { return "done"; }, dispose() {} };
    };

    const rec = await fire(f.located, MANUAL, deps(f, { startSession: starter }));

    expect(rec.outcome).toBe("ok");
    // A real worktree, not the checkout, and cleaned up afterwards.
    expect(seen[0]).toContain("pi-automations-wt-");
    expect(existsSync(seen[0] as string)).toBe(false);
  });
});

/** A context good enough to hand the provider directly. */
function fakeContext(f: Fixture) {
  return Object.freeze({
    runId: "r-1",
    key: f.located.key,
    name: f.located.automation.name,
    scope: "repository" as const,
    trigger: "manual" as const,
    late: false,
    automationDir: f.located.dir,
    rootDir: f.located.root.path,
    repositoryRoot: f.repo,
    stateDir: f.stateDir,
  });
}
