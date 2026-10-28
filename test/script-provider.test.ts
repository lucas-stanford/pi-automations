/** The script execution seam. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import type { RunScript, ScriptCommand, ScriptExecution } from "../src/core/contracts.js";
import { runScriptHook, type RunInfo } from "../src/hooks.js";
import { runLocalScript } from "../src/providers/scripts.js";
import { discover } from "../src/discover.js";
import type { Located, Root } from "../src/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const RUN: RunInfo = { runId: "run-1", trigger: "manual", late: false };

/** A temporary directory with one script in it, and nothing else. */
function scriptDir(files: Record<string, string>): string {
  const dir = tempDir("pi-scripts-");
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

/** An automation whose hooks the policy tests can run. */
function located(files: Record<string, string>): Located {
  const home = tempDir("pi-scripts-auto-");
  const root = path.join(home, "automations");
  const dir = path.join(root, "hooked");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    "---\nname: hooked\ndescription: d\non:\n  manual: true\n---\n\nBody.\n",
  );
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
  }
  const roots: Root[] = [{ path: root, scope: "user", kind: "agents" }];
  const found = discover({ roots })[0];
  if (!found?.ok) throw new Error("fixture did not parse");
  return found.located;
}

/** An executor that records what it was asked to run and answers from a script. */
function recordingRunner(answer: Partial<ScriptExecution> = {}): {
  run: RunScript;
  seen: ScriptCommand[];
} {
  const seen: ScriptCommand[] = [];
  return {
    seen,
    run: async (command) => {
      seen.push(command);
      return {
        end: "exit",
        exit: 0,
        stdout: "",
        stderr: "",
        outputBytes: 0,
        truncated: false,
        ...answer,
      } as ScriptExecution;
    },
  };
}

const base = (over: Partial<ScriptCommand> & { cwd: string; file: string }): ScriptCommand => ({
  args: [],
  env: { ...(process.env as Record<string, string>) },
  timeoutMs: 8000,
  maxOutputBytes: DEFAULTS.hookMaxOutputBytes,
  ...over,
});

describe("the local executor runs a real process", () => {
  it("reports the exit code and what the child printed", async () => {
    const dir = scriptDir({ "ok.js": 'process.stdout.write("hello"); process.exit(0);' });
    const r = await runLocalScript(
      base({ cwd: dir, file: process.execPath, args: [path.join(dir, "ok.js")] }),
    );

    expect(r.end).toBe("exit");
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("hello");
    expect(r.truncated).toBe(false);
  });

  it("keeps a non-zero exit as a fact, with no opinion about it", async () => {
    const dir = scriptDir({
      "bad.js": 'process.stderr.write("went wrong\\n"); process.exit(3);',
    });
    const r = await runLocalScript(
      base({ cwd: dir, file: process.execPath, args: [path.join(dir, "bad.js")] }),
    );

    // `exit`, not `failed`: whether 3 means "stop the run" or "record and continue" is the hook's
    // judgement, and an executor that decided it here would have taken that away.
    expect(r.end).toBe("exit");
    expect(r.exit).toBe(3);
    expect(r.stderr).toContain("went wrong");
  });

  it("runs in the directory it was given", async () => {
    const dir = scriptDir({ "cwd.js": "process.stdout.write(process.cwd());" });
    const r = await runLocalScript(
      base({ cwd: dir, file: process.execPath, args: [path.join(dir, "cwd.js")] }),
    );
    // Compared through realpath: a temporary directory can be reached by more than one name.
    expect(path.resolve(r.stdout)).toBe(path.resolve(dir));
  });

  it("gives the child exactly the environment it was handed, and nothing else", async () => {
    process.env.PI_AUTOMATIONS_SCRIPTS_PARENT_ONLY = "leaked";
    try {
      const dir = scriptDir({
        "env.js":
          'process.stdout.write(String(process.env.ONLY_THIS) + "|" + String(process.env.PI_AUTOMATIONS_SCRIPTS_PARENT_ONLY));',
      });
      const r = await runLocalScript(
        base({
          cwd: dir,
          file: process.execPath,
          args: [path.join(dir, "env.js")],
          env: { ONLY_THIS: "yes" },
        }),
      );

      const [only, inherited] = r.stdout.split("|");
      expect(only).toBe("yes");
      // The parent has this variable and the child was not given it, so it must not have it — an
      // executor that merged `process.env` underneath would make the caller's credential filtering
      // meaningless.
      expect(inherited).toBe("undefined");
    } finally {
      delete process.env.PI_AUTOMATIONS_SCRIPTS_PARENT_ONLY;
    }
  });

  it("writes stdin and closes it", async () => {
    const dir = scriptDir({
      "in.js": `
        let s = "";
        process.stdin.on("data", (c) => (s += c));
        process.stdin.on("end", () => process.stdout.write("got:" + s));
      `,
    });
    const r = await runLocalScript(
      base({
        cwd: dir,
        file: process.execPath,
        args: [path.join(dir, "in.js")],
        stdin: "the body said this",
      }),
    );
    expect(r.stdout).toBe("got:the body said this");
  });

  it("does not mind a child that never reads stdin", async () => {
    const dir = scriptDir({ "ignore.js": 'process.stdout.write("fine");' });
    const r = await runLocalScript(
      base({
        cwd: dir,
        file: process.execPath,
        args: [path.join(dir, "ignore.js")],
        stdin: "x".repeat(200_000),
      }),
    );
    // A large write to a child that closed stdin raises EPIPE. That is ordinary, not a failure.
    expect(r.end).toBe("exit");
    expect(r.exit).toBe(0);
  });

  it("caps what it captures and says the rest is missing", async () => {
    const dir = scriptDir({ "loud.js": 'process.stdout.write("x".repeat(5000));' });
    const r = await runLocalScript(
      base({
        cwd: dir,
        file: process.execPath,
        args: [path.join(dir, "loud.js")],
        maxOutputBytes: 100,
      }),
    );

    expect(r.stdout.length).toBe(100);
    expect(r.truncated).toBe(true);
    // The count is what the child ACTUALLY produced, not what survived the cap — otherwise a
    // truncated hook would under-report its own output on the record.
    expect(r.outputBytes).toBe(5000);
  });

  it("stops a process that overruns its time limit", async () => {
    const dir = scriptDir({ "slow.js": "setTimeout(() => {}, 60_000);" });
    const started = Date.now();
    const r = await runLocalScript(
      base({
        cwd: dir,
        file: process.execPath,
        args: [path.join(dir, "slow.js")],
        timeoutMs: 300,
      }),
    );

    expect(r.end).toBe("timeout");
    expect(r.exit).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("reports a binary that does not exist instead of throwing", async () => {
    const dir = scriptDir({});
    const r = await runLocalScript(
      base({ cwd: dir, file: path.join(dir, "no-such-binary-anywhere"), args: [] }),
    );

    expect(r.end).toBe("start-failed");
    expect(r.message).toBeTruthy();
    // Never thrown: a hook that cannot run has to become a hook RESULT, not an exception in the
    // middle of somebody's run.
    expect(r.stdout).toBe("");
  });

  it("stops early when its signal is aborted", async () => {
    const dir = scriptDir({ "slow.js": "setTimeout(() => {}, 60_000);" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);

    const started = Date.now();
    const r = await runLocalScript(
      base({
        cwd: dir,
        file: process.execPath,
        args: [path.join(dir, "slow.js")],
        timeoutMs: 60_000,
        signal: ac.signal,
      }),
    );

    // Distinguished from a timeout: they are different events and the hook reports them
    // differently, so collapsing them would lose why the process stopped.
    expect(r.end).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("does not leave a process behind when the signal was already aborted", async () => {
    const dir = scriptDir({ "slow.js": "setTimeout(() => {}, 60_000);" });
    const r = await runLocalScript(
      base({
        cwd: dir,
        file: process.execPath,
        args: [path.join(dir, "slow.js")],
        timeoutMs: 60_000,
        signal: AbortSignal.abort(),
      }),
    );
    expect(r.end).toBe("cancelled");
  });
});

describe("the hook composes the command and reads the outcome", () => {
  it("chooses the interpreter and passes the resolved one through", async () => {
    const l = located({ "s.js": 'process.stdout.write("x");' });
    const rec = recordingRunner();

    await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: rec.run,
    });

    const cmd = rec.seen[0];
    expect(cmd).toBeTruthy();
    // Already resolved. The executor is never asked to work out what a `.js` file needs.
    expect(cmd?.file).toBe(process.execPath);
    expect(cmd?.args.some((a) => a.endsWith("s.js"))).toBe(true);
    expect(cmd?.cwd).toBe(l.dir);
  });

  it("filters credential-shaped variables before the executor sees them", async () => {
    process.env.PI_AUTOMATIONS_SCRIPTS_TEST_API_KEY = "super-secret";
    process.env.PI_AUTOMATIONS_SCRIPTS_TEST_PLAIN = "fine";
    try {
      const l = located({ "s.js": "" });
      const rec = recordingRunner();

      await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, {
        config: DEFAULTS,
        runScript: rec.run,
      });

      const env = rec.seen[0]?.env ?? {};
      // The filtering happens in the POLICY, so every executor inherits it — a replacement host
      // cannot forget to do it.
      expect(env.PI_AUTOMATIONS_SCRIPTS_TEST_API_KEY).toBeUndefined();
      expect(env.PI_AUTOMATIONS_SCRIPTS_TEST_PLAIN).toBe("fine");
      expect(env.AUTOMATION_NAME).toBe("hooked");
      expect(env.AUTOMATION_PHASE).toBe("pre");
    } finally {
      delete process.env.PI_AUTOMATIONS_SCRIPTS_TEST_API_KEY;
      delete process.env.PI_AUTOMATIONS_SCRIPTS_TEST_PLAIN;
    }
  });

  it("resolves the bounds from config before handing them over", async () => {
    const l = located({ "s.js": "" });
    const rec = recordingRunner();

    await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, {
      config: { ...DEFAULTS, hookMaxOutputBytes: 123 },
      runScript: rec.run,
      timeoutMs: 456,
    });

    expect(rec.seen[0]?.maxOutputBytes).toBe(123);
    expect(rec.seen[0]?.timeoutMs).toBe(456);
  });

  it("does not hand the executor a cancellation signal", async () => {
    const l = located({ "s.js": "" });
    const rec = recordingRunner();

    await runScriptHook(l, { script: "s.js" }, "post", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: rec.run,
    });

    // Hook process termination is NOT run cancellation. A post hook's whole job is delivery and
    // cleanup, so wiring a cancelled run's signal into it would kill the one thing that still has
    // work to do. The hook's only stop is its own timeout.
    expect(rec.seen[0]?.signal).toBeUndefined();
  });

  it("reads a timeout as a failure naming the limit", async () => {
    const l = located({ "s.js": "" });
    const rec = recordingRunner({ end: "timeout", exit: undefined, outputBytes: 4 });

    const r = await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: rec.run,
      timeoutMs: 1000,
    });

    expect(r.result.status).toBe("failed");
    expect(r.result.reason).toMatch(/^hook timeout after/);
  });

  it("reads a cancellation as its own failure, not as a timeout", async () => {
    const l = located({ "s.js": "" });
    const rec = recordingRunner({ end: "cancelled", exit: undefined });

    const r = await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: rec.run,
    });

    expect(r.result.status).toBe("failed");
    expect(r.result.reason).toContain("was stopped");
    expect(r.result.reason).not.toMatch(/timeout/);
  });

  it("carries the truncation flag and the real byte count onto the record", async () => {
    const l = located({ "s.js": "" });
    const rec = recordingRunner({ stdout: "xx", outputBytes: 9000, truncated: true });

    const r = await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: rec.run,
    });

    expect(r.result.truncated).toBe(true);
    expect(r.result.outputBytes).toBe(9000);
  });

  it("keeps the pre/post split on a non-zero exit", async () => {
    const l = located({ "s.js": "" });
    const answer = { end: "exit" as const, exit: 3, stderr: "nothing to do\n" };

    const pre = await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: recordingRunner(answer).run,
    });
    const post = await runScriptHook(l, { script: "s.js" }, "post", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: recordingRunner(answer).run,
    });

    expect(pre.result.status).toBe("skipped");
    expect(pre.result.reason).toBe("pre[0] s.js exited 3: nothing to do");
    expect(post.result.status).toBe("failed");
  });

  it("does not ask the executor at all when no interpreter is available", async () => {
    const l = located({ "s.rb": "" });
    const rec = recordingRunner();

    const r = await runScriptHook(l, { script: "s.rb" }, "pre", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: rec.run,
      platform: "linux",
      which: () => undefined,
    });

    expect(r.result.status).toBe("failed");
    expect(r.result.reason).toContain("no interpreter");
    expect(rec.seen).toHaveLength(0);
  });

  it("turns an executor that throws into an ordinary failed hook", async () => {
    const l = located({ "s.js": "" });

    const r = await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, {
      config: DEFAULTS,
      runScript: async () => {
        throw new Error("the sandbox is gone");
      },
    });

    expect(r.result.status).toBe("failed");
    expect(r.result.reason).toContain("the sandbox is gone");
  });
});

describe("a configured script with nowhere to run it fails loudly", () => {
  const noExecutor = { config: DEFAULTS } as unknown as Parameters<typeof runScriptHook>[6];

  it("fails a PRE hook rather than skipping it", async () => {
    const l = located({ "s.js": 'process.stdout.write("this must not run");' });

    const r = await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, noExecutor);

    // `skipped` is the documented way a pre hook says "nothing to do", and it stops the run
    // quietly. A miscomposed host must never be able to borrow that signal — the run would end
    // looking entirely correct while a configured script had silently never executed.
    expect(r.result.status).toBe("failed");
    expect(r.result.status).not.toBe("skipped");
    expect(r.result.reason).toContain("composed no script executor");
    expect(r.result.reason).toContain("s.js");
  });

  it("fails a POST hook rather than reporting success", async () => {
    const l = located({ "s.js": "" });

    const r = await runScriptHook(l, { script: "s.js" }, "post", 0, RUN, undefined, noExecutor);

    expect(r.result.status).toBe("failed");
    expect(r.result.status).not.toBe("ok");
    expect(r.result.exit).toBeUndefined();
    expect(r.output).toBe("");
  });

  it("refuses the same way when the field is present but not callable", async () => {
    const l = located({ "s.js": "" });
    const broken = { config: DEFAULTS, runScript: "local" } as unknown as Parameters<
      typeof runScriptHook
    >[6];

    const r = await runScriptHook(l, { script: "s.js" }, "pre", 0, RUN, undefined, broken);
    expect(r.result.status).toBe("failed");
    expect(r.result.reason).toContain("composed no script executor");
  });
});
