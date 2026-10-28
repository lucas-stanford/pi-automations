/**
 * A script's completion has to say how it ended, and be believed only when it does.
 *
 * Measured by the `p5-script-no-exit` fault probe against the shipped code: a JavaScript executor
 * returning `{ end: "exit" }` with no `exit` field produced a hook recorded `ok` with `exit: 0`,
 * and the run succeeded. A script that said nothing about how it ended was read as having ended
 * well.
 *
 * Two defences, and this file tests both AS WHAT THEY ARE:
 *
 *   - the compile-time one is checked by actually running `tsc` over a fixture of wrong executors
 *     and asserting the diagnostics. It is NOT checked with `@ts-expect-error` inside this file,
 *     because vitest transpiles without typechecking — such an assertion would pass whether or not
 *     the compiler agreed, which is worse than no test at all;
 *   - the runtime one is checked by calling the real `runScriptHook` with a malformed result, the
 *     way a plain JavaScript host actually reaches it.
 *
 * And the mapping that must NOT change is pinned: a child terminated by a signal reports exit 0
 * through the local executor. That is this CLI's long-standing behaviour, it is a different fact
 * from "the executor did not observe the ending", and it was never authorised to change.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { runScriptHook } from "../src/hooks.js";
import { exitCodeForClose, runLocalScript } from "../src/providers/scripts.js";
import type { RunScript, ScriptExecution } from "../src/core/contracts.js";
import type { RunInfo } from "../src/types.js";
import { isolatedAutomation } from "./helpers/isolated-host.js";
import { tempDir } from "./helpers/temp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const RUN: RunInfo = { runId: "completion-run", trigger: "manual", late: false };

describe("the compiler refuses an executor that cannot say how its script ended", () => {
  // One `tsc` run for all four cases: compiling the fixture is seconds, and doing it once keeps
  // this from being four of the slowest tests in the suite.
  const fixture = path.join(REPO, "test", "fixtures", "bad-script-executor.ts");
  const tsc = path.join(REPO, "node_modules", "typescript", "bin", "tsc");

  const diagnostics = (() => {
    expect(existsSync(fixture)).toBe(true);
    expect(existsSync(tsc)).toBe(true);
    try {
      execFileSync(
        process.execPath,
        [tsc, "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--skipLibCheck", fixture],
        { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      return "";
    } catch (e) {
      // tsc exits non-zero WITH the diagnostics on stdout, which is the success path here.
      return String((e as { stdout?: string }).stdout ?? "");
    }
  })();

  it("compiles the fixture and actually reports errors, so the assertions below mean something", () => {
    // If this fails, every expectation in this block would pass vacuously against an empty string.
    expect(diagnostics).not.toBe("");
    expect(diagnostics).toContain("bad-script-executor.ts");
  });

  it("rejects end: exit with no exit code", () => {
    expect(diagnostics).toMatch(/missingExit|Property 'exit' is missing/);
    expect(diagnostics).toContain("'exit' is missing");
  });

  it("rejects start-failed with no message", () => {
    expect(diagnostics).toContain("'message' is missing");
  });

  it("rejects an ending that is not one of the four", () => {
    expect(diagnostics).toMatch(/"finished"/);
  });

  it("rejects an exit code that is not a number", () => {
    expect(diagnostics).toMatch(/Type 'string' is not assignable to type 'number'/);
  });
});

describe("a malformed completion at RUNTIME is a visible failure, not exit 0", () => {
  const output = { stdout: "", stderr: "", outputBytes: 0, truncated: false };

  /** Exactly what a plain JavaScript host can hand core, past every compile-time guarantee. */
  function executorReturning(value: unknown): RunScript {
    return (async () => value) as unknown as RunScript;
  }

  async function runWith(executor: RunScript, phase: "pre" | "post" = "pre") {
    const a = isolatedAutomation({
      name: "bad-completion",
      frontmatter: "on:\n  manual: true\n",
      scripts: { "hook.js": "process.exit(0);" },
    });
    return runScriptHook(
      a.located,
      { script: "hook.js" },
      phase,
      0,
      RUN,
      undefined,
      { config: DEFAULTS, runScript: executor, timeoutMs: 4000 },
    );
  }

  it("fails the hook when end is exit but no exit code came back — the measured p5 case", async () => {
    const r = await runWith(executorReturning({ end: "exit", ...output }));

    expect(r.result.status).not.toBe("ok");
    expect(r.result.exit).toBeUndefined();
    // The reason has to name the executor's own shape, because the person reading it is debugging
    // their executor and "the hook failed" would not help them at all.
    expect(r.result.reason).toContain("completion this cannot read");
    expect(r.result.reason).toContain("exit=missing");
  });

  it("fails the hook when the ending is not one this knows", async () => {
    const r = await runWith(executorReturning({ end: "finished", exit: 0, ...output }));

    expect(r.result.status).not.toBe("ok");
    expect(r.result.reason).toContain("completion this cannot read");
    expect(r.result.reason).toContain('end="finished"');
  });

  it("fails the hook when the exit code is not a number", async () => {
    const r = await runWith(executorReturning({ end: "exit", exit: "0", ...output }));

    expect(r.result.status).not.toBe("ok");
    expect(r.result.reason).toContain("exit=string");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a primitive", "finished"],
    ["an array", []],
    ["missing stdout", { end: "exit", exit: 0, stderr: "", outputBytes: 0, truncated: false }],
    ["missing stderr", { end: "exit", exit: 0, stdout: "", outputBytes: 0, truncated: false }],
    ["missing outputBytes", { end: "exit", exit: 0, stdout: "", stderr: "", truncated: false }],
    ["missing truncated", { end: "exit", exit: 0, stdout: "", stderr: "", outputBytes: 0 }],
  ])("fails visibly for %s before reading shared output fields", async (_label, value) => {
    const r = await runWith(executorReturning(value));
    expect(r.result.status).toBe("failed");
    expect(r.result.reason).toContain("completion this cannot read");
  });

  it("does not quote the child's output into the reason", async () => {
    const r = await runWith(
      executorReturning({ end: "exit", stdout: "SECRET-STDOUT", stderr: "SECRET-STDERR", outputBytes: 13, truncated: false }),
    );

    expect(r.result.reason).not.toContain("SECRET-STDOUT");
    expect(r.result.reason).not.toContain("SECRET-STDERR");
  });

  it("still accepts every VALID completion", async () => {
    const ok = await runWith(executorReturning({ end: "exit", exit: 0, ...output } satisfies ScriptExecution));
    expect(ok.result.status).toBe("ok");
    expect(ok.result.exit).toBe(0);

    const nonZero = await runWith(executorReturning({ end: "exit", exit: 3, ...output } satisfies ScriptExecution));
    // A pre hook exiting non-zero is the documented way to say "nothing to do".
    expect(nonZero.result.status).toBe("skipped");
    expect(nonZero.result.exit).toBe(3);

    const started = await runWith(
      executorReturning({ end: "start-failed", message: "ENOENT", ...output } satisfies ScriptExecution),
    );
    expect(started.result.status).not.toBe("ok");
    expect(started.result.reason).toContain("ENOENT");
  });
});

describe("the signal mapping this was NOT authorised to change", () => {
  it("maps a null close code to 0, which is the signal policy, on every platform", () => {
    // Asserted directly rather than through a spawned child, because Windows has no POSIX signals
    // and no child in this suite ever ends with a null code.
    expect(exitCodeForClose(null)).toBe(0);

    // And an ordinary exit is still itself, including a failure.
    expect(exitCodeForClose(0)).toBe(0);
    expect(exitCodeForClose(1)).toBe(1);
    expect(exitCodeForClose(3)).toBe(3);
  });

  it("never reports an exit with no code, however abnormally the child ended", async () => {
    const dir = tempDir("pi-signal-");
    const script = path.join(dir, "self-terminate.js");
    // Terminates ITSELF, which is the only portable way to get an abnormal ending without this test
    // owning a second process.
    writeFileSync(script, "process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n");

    const ran = await runLocalScript({
      file: process.execPath,
      args: [script],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 8000,
      maxOutputBytes: 4096,
    });

    expect(ran.end).toBe("exit");
    if (ran.end !== "exit") return;

    // The invariant that holds on EVERY platform, and the one the union now makes unstateable
    // otherwise: a completion that says `exit` carries a number. This is what stops an abnormal
    // ending from reaching `runScriptHook` as the unreadable shape it rejects.
    expect(typeof ran.exit).toBe("number");

    if (process.platform === "win32") {
      // Windows has NO POSIX signals.
      expect(ran.exit).toBeGreaterThanOrEqual(0);
    } else {
      // POSIX: node reports `close(code: null, signal)`, and `code ?? 0` is this CLI's
      // long-standing reading — a hook the operator stopped is not a script that failed.
      expect(ran.exit).toBe(0);
    }
  });

  it("and core reads a null-code completion as an ordinary successful hook, on every platform", async () => {
    const r = await (async () => {
      const passthrough: RunScript = async () => ({
        end: "exit",
        // Exactly what `runLocalScript` produces for `close(null, "SIGTERM")`.
        exit: 0,
        stdout: "",
        stderr: "",
        outputBytes: 0,
        truncated: false,
      });
      const a = isolatedAutomation({
        name: "signal-mapping",
        frontmatter: "on:\n  manual: true\n",
        scripts: { "hook.js": "process.exit(0);" },
      });
      return runScriptHook(
        a.located,
        { script: "hook.js" },
        "pre",
        0,
        RUN,
        undefined,
        { config: DEFAULTS, runScript: passthrough, timeoutMs: 4000 },
      );
    })();

    expect(r.result.status).toBe("ok");
    expect(r.result.exit).toBe(0);
  });
});
