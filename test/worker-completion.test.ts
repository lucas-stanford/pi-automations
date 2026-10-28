/**
 * A worker's completion has to say how it ended, and be believed only when it does.
 *
 * The old `WorkerCompletion` was `{ exit: number | null; signal: NodeJS.Signals | null }`, so
 * `{ exit: null, signal: null }` was a legal value — a worker that ended with the transport unable
 * to say HOW. Both callers read it as success, because "exited cleanly" and "the transport told us
 * nothing" were spelled the same way:
 *
 *   bin/pi-automations.js   `if (exit !== null) return exit; return signal ? EXIT.failed : 0;`
 *   hosts/pi/extension.ts   `const code = exit ?? (signal ? 20 : 0);`
 *
 * Both answer **0** for `{ null, null }`.
 *
 * This file pins three things, and the third is the one that is easy to get backwards:
 *
 *   1. the compiler now refuses a transport that cannot say how its worker ended — checked by
 *      running a REAL `tsc`, not by `@ts-expect-error` in a file vitest never typechecks;
 *   2. a malformed completion from an untyped JavaScript transport reaches no caller as success;
 *   3. a worker terminated by a SIGNAL still reports 0, exactly as it did at HEAD `309ae2bd`.
 *
 * Point 3 is a RESTORATION. The original CLI was `child.on("close", (code) => resolve(code ?? 0))`
 * and the original extension was `registry.crash(id, code ?? 0, …)`; a later slice in this
 * refactor changed them to 20. That was never authorised, and this file is what stops it drifting
 * again.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  completionFor,
  exitCodeForCompletion,
  readCompletion,
} from "../src/providers/worker.js";
import type { WorkerCompletion } from "../src/core/contracts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

describe("the compiler refuses a transport that cannot say how its worker ended", () => {
  const fixture = path.join(REPO, "test", "fixtures", "bad-worker-transport.ts");
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
      return String((e as { stdout?: string }).stdout ?? "");
    }
  })();

  it("compiles the fixture and actually reports errors, so the assertions below mean something", () => {
    // Without this every expectation in the block would pass vacuously against an empty string.
    expect(diagnostics).not.toBe("");
    expect(diagnostics).toContain("bad-worker-transport.ts");
  });

  it("refuses the old both-null shape, which is the defect this union removes", () => {
    expect(diagnostics).toMatch(/exit: null|is not assignable/);
  });

  it("refuses an exit with no code and a signal with no name", () => {
    expect(diagnostics).toContain("'exit' is missing");
    expect(diagnostics).toContain("'signal' is missing");
  });

  it("refuses a completion claiming both at once", () => {
    // `signal` cannot appear on the exit variant: a process does not do both.
    expect(diagnostics).toMatch(/signal/);
  });

  it("refuses a contradiction carried by a VARIABLE, not just a fresh literal", () => {
    // The distinction that matters.
    expect(diagnostics).toMatch(/Type 'Signals' is not assignable to type 'undefined'/);
    expect(diagnostics).toMatch(/Type 'number' is not assignable to type 'undefined'/);
  });
});

describe("reading an untyped transport's completion", () => {
  it("accepts the two real shapes", () => {
    expect(readCompletion({ end: "exit", exit: 0 })).toEqual({ end: "exit", exit: 0 });
    expect(readCompletion({ end: "exit", exit: 17 })).toEqual({ end: "exit", exit: 17 });
    expect(readCompletion({ end: "signal", signal: "SIGTERM" })).toEqual({
      end: "signal",
      signal: "SIGTERM",
    });
  });

  it("refuses everything a JavaScript transport can produce that means nothing", () => {
    expect(readCompletion({ exit: null, signal: null })).toBeUndefined();

    expect(readCompletion({})).toBeUndefined();
    expect(readCompletion(undefined)).toBeUndefined();
    expect(readCompletion(null)).toBeUndefined();
    expect(readCompletion("done")).toBeUndefined();
    expect(readCompletion({ end: "exit" })).toBeUndefined();
    expect(readCompletion({ end: "exit", exit: "0" })).toBeUndefined();
    expect(readCompletion({ end: "exit", exit: 1.5 })).toBeUndefined();
    expect(readCompletion({ end: "signal" })).toBeUndefined();
    expect(readCompletion({ end: "signal", signal: "" })).toBeUndefined();
    expect(readCompletion({ end: "finished", exit: 0 })).toBeUndefined();
  });

  /** The three shapes an independent probe found being ACCEPTED at tree `fba72f4f`. */
  it("refuses the exact counterexamples the parent probe found accepted", () => {
    expect(readCompletion({ end: "exit", exit: 0, signal: "SIGTERM" })).toBeUndefined();
    expect(readCompletion({ end: "signal", signal: "SIGTERM", exit: 1 })).toBeUndefined();
    expect(readCompletion({ end: "signal", signal: "not-a-signal" })).toBeUndefined();
  });

  it("refuses a contradiction even when the other field is undefined or null", () => {
    // Mentioning the other ending at all is the contradiction; which one was meant is not ours to
    // guess, and a `typeof` check would have let both of these through.
    expect(readCompletion({ end: "exit", exit: 0, signal: undefined })).toBeUndefined();
    expect(readCompletion({ end: "exit", exit: 0, signal: null })).toBeUndefined();
    expect(readCompletion({ end: "signal", signal: "SIGTERM", exit: undefined })).toBeUndefined();
    expect(readCompletion({ end: "signal", signal: "SIGTERM", exit: null })).toBeUndefined();
  });

  it("accepts a signal this platform does not have, because a record can come from another", () => {
    // Windows has no SIGUSR1. Refusing it here would reject a completion forwarded from a POSIX
    // host, or replayed from a record written on one, purely because of where it is being read.
    expect(readCompletion({ end: "signal", signal: "SIGUSR1" })).toEqual({
      end: "signal",
      signal: "SIGUSR1",
    });
    expect(readCompletion({ end: "signal", signal: "SIGHUP" })).toEqual({
      end: "signal",
      signal: "SIGHUP",
    });
  });

  it("refuses a name that merely looks like a signal", () => {
    expect(readCompletion({ end: "signal", signal: "SIGMADEUP" })).toBeUndefined();
    expect(readCompletion({ end: "signal", signal: "sigterm" })).toBeUndefined();
    expect(readCompletion({ end: "signal", signal: "TERM" })).toBeUndefined();
    expect(readCompletion({ end: "signal", signal: "SIG" })).toBeUndefined();
  });

  it("still maps a VALID signal to 0, which is the mapping that was never up for change", () => {
    const valid = readCompletion({ end: "signal", signal: "SIGTERM" });
    expect(valid).toBeDefined();
    expect(exitCodeForCompletion(valid as WorkerCompletion)).toBe(0);
  });
});

describe("what node's close event means", () => {
  it("is an exit when there is a code, including a non-zero one", () => {
    expect(completionFor(0, null)).toEqual({ end: "exit", exit: 0 });
    expect(completionFor(3, null)).toEqual({ end: "exit", exit: 3 });
  });

  it("is a signal when there is no code", () => {
    expect(completionFor(null, "SIGTERM")).toEqual({ end: "signal", signal: "SIGTERM" });
    expect(completionFor(null, "SIGKILL")).toEqual({ end: "signal", signal: "SIGKILL" });
  });

  it("never invents a clean exit when node reports neither", () => {
    // Not something node does — but this is the boundary where a platform assumption becomes a
    // value the rest of the system trusts, so it must not become `exit 0`.
    const c = completionFor(null, null);
    expect(c.end).toBe("signal");
    expect(c).not.toEqual({ end: "exit", exit: 0 });
  });
});

describe("the signal mapping restored from HEAD", () => {
  it("reports 0 for a signalled worker, which is what the original callers did", () => {
    expect(exitCodeForCompletion({ end: "signal", signal: "SIGTERM" })).toBe(0);
    expect(exitCodeForCompletion({ end: "signal", signal: "SIGKILL" })).toBe(0);
  });

  it("reports the worker's own code for an ordinary exit", () => {
    expect(exitCodeForCompletion({ end: "exit", exit: 0 })).toBe(0);
    expect(exitCodeForCompletion({ end: "exit", exit: 20 })).toBe(20);
    expect(exitCodeForCompletion({ end: "exit", exit: 30 })).toBe(30);
  });

  it("is ONE function, so the two callers cannot drift apart again", () => {
    const cases: WorkerCompletion[] = [
      { end: "exit", exit: 0 },
      { end: "exit", exit: 20 },
      { end: "signal", signal: "SIGTERM" },
    ];
    expect(cases.map(exitCodeForCompletion)).toEqual([0, 20, 0]);
  });
});

describe("the callers map an unreadable completion to failure, never to 0", () => {
  it("the CLI does", () => {
    const src = readCode("bin", "pi-automations.js");
    // The whole point: `EXIT.failed` on the unreadable branch, and no bare `: 0` fallback left.
    expect(src).toContain("readCompletion(completion)");
    expect(src).toContain("read ? exitCodeForCompletion(read) : EXIT.failed");
    expect(src).not.toContain("return signal ? EXIT.failed : 0;");
  });

  it("the extension does", () => {
    const src = readCode("src", "hosts", "pi", "extension.ts");
    expect(src).toContain("readCompletion(completion)");
    expect(src).toContain("EXIT_UNREADABLE_COMPLETION");
    expect(src).not.toContain("exit ?? (signal ? 20 : 0)");
  });
});

/** Source with `//` comment lines removed. */
function readCode(...parts: string[]): string {
  return readFileSync(path.join(REPO, ...parts), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}
