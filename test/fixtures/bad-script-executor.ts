/**
 * Executors that are WRONG, kept so a compiler can say so.
 *
 * This file is never imported by anything that runs. It exists to be compiled by `tsc` from
 * `script-completion.test.ts`, which asserts the specific diagnostics — because vitest strips types
 * without checking them, so a `@ts-expect-error` inside a test file proves nothing at all about
 * whether the compiler would actually have rejected the code.
 *
 * Each export below is a real executor a host could plausibly write, and each omits exactly one
 * fact that gives its own result meaning. Before `ScriptExecution` became a discriminated union all
 * three compiled cleanly, and the first one was measured turning a script that said nothing about
 * how it ended into a recorded success.
 */

import type { RunScript } from "../../src/core/contracts.js";

const output = { stdout: "", stderr: "", outputBytes: 0, truncated: false };

/** Says it exited, without saying with what. */
export const missingExit: RunScript = async () => ({ end: "exit", ...output });

/** Says it could not start, without saying why. */
export const missingMessage: RunScript = async () => ({ end: "start-failed", ...output });

/** An ending that is not one of the four. */
export const unknownEnd: RunScript = async () => ({ end: "finished", exit: 0, ...output });

/** An exit code that is not a number — the shape an untyped JS executor drifts into. */
export const stringExit: RunScript = async () => ({ end: "exit", exit: "0", ...output });
