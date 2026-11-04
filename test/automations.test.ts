// The extension as pi drives it: a fake pi API and context, and a fake fm that records how it was
// called. Nothing here touches the person's fm state or automations.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import automations, {
  ENTRY,
  INSTALL,
  activeStep,
  ended,
  endedMessage,
  footerText,
  idleText,
  newPrompt,
  previewOf,
  splitArgs,
  took,
} from "../extensions/automations.ts";

describe("splitArgs", () => {
  it("splits on spaces and keeps quoted words together", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("  arm   daily ")).toEqual(["arm", "daily"]);
    expect(splitArgs(`new "a nightly digest" 'of PRs'`)).toEqual(["new", "a nightly digest", "of PRs"]);
    expect(splitArgs(`log x -n 3`)).toEqual(["log", "x", "-n", "3"]);
    expect(splitArgs(`say ""`)).toEqual(["say", ""]);
  });
});

describe("what fm says, as pi shows it", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const run = { key: "repository:/r:fix", name: "fix", runId: "r1", startedAt: "2026-11-04T11:48:00Z" };

  it("says what is running, on which step, for how long", () => {
    expect(footerText([], now)).toBeUndefined();
    expect(footerText([{ ...run, step: "Implement the fix" }], now)).toBe("◐ fix · Implement the fix · 12m");
    expect(footerText([run, { ...run, name: "digest", startedAt: "2026-11-04T11:59:30Z" }], now)).toBe(
      "◐ fix · 12m   ◐ digest · 30s",
    );
    expect(took(2 * 3600_000 + 5 * 60_000)).toBe("2h 5m");
  });

  it("says how many are armed when nothing runs, and a watcher that is off", () => {
    const st = (state: string) => ({ key: state, name: state, state });
    expect(idleText([st("off")], false)).toBeUndefined();
    expect(idleText([st("armed"), st("armed"), st("off")], true)).toBe("◇ 2 armed");
    expect(idleText([st("armed")], false)).toBe("◇ 1 armed · watcher off — /automations watcher start");
  });

  it("finds the runs that ended since the last look", () => {
    const before = new Map([[run.key, run]]);
    const still = [{ key: run.key, name: "fix", state: "armed", running: { runId: "r1", startedAt: run.startedAt } }];
    const next = [{ key: run.key, name: "fix", state: "armed", running: { runId: "r2", startedAt: run.startedAt } }];
    expect(ended(before, still)).toEqual([]);
    expect(ended(before, [{ key: run.key, name: "fix", state: "armed", running: null }])).toEqual([run]);
    expect(ended(before, next)).toEqual([run]);
  });

  it("reads the step going from fm status --json", () => {
    const status = (nodes: object[]) => JSON.stringify({ ok: true, data: { nodes } });
    expect(
      activeStep(status([
        { id: "body", label: "Run", status: "active" },
        { id: "build", label: "Implement the fix", status: "active" },
      ])),
    ).toBe("Implement the fix");
    expect(activeStep(status([{ id: "post0", label: "Clean up", status: "active" }]))).toBe("Clean up");
    expect(activeStep(status([{ id: "read", label: "Read", status: "done" }]))).toBeUndefined();
    expect(activeStep("not json")).toBeUndefined();
  });

  it("says how a run ended, with its message, and warns on a failure", () => {
    expect(endedMessage("fix", JSON.stringify({ outcome: "ok", message: { text: "Merged #40\nmore" } }))).toEqual({
      text: "fix: ok — Merged #40",
      level: "info",
    });
    expect(endedMessage("fix", JSON.stringify({ outcome: "failed", error: { message: "timeout" } }))).toEqual({
      text: "fix: failed — timeout",
      level: "error",
    });
    expect(endedMessage("fix", "")).toEqual({ text: "fix: the run ended", level: "info" });
  });

  it("keeps the consent preview of fm check", () => {
    expect(previewOf("demo  off\n  reason  x\n\nConsent preview for demo  from ~/a\n  agent  pi\n")).toBe(
      "Consent preview for demo  from ~/a\n  agent  pi",
    );
    expect(previewOf("just this")).toBe("just this");
  });

  it("asks pi to write a new automation, leaving arming to the person", () => {
    const p = newPrompt("a nightly digest of open PRs");
    expect(p).toMatch(/^Write a new automation: a nightly digest of open PRs /);
    expect(p).toContain("agent-automations skill");
    expect(p).toContain("I arm it myself");
  });
});

// --- the extension, wired into a fake pi ----------------------------------------------------------

const FAKE_FM = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_FM_LOG, JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_FM_STATE, "utf8"));
const [verb] = args;
const running = state.running ? { runId: "r1", startedAt: new Date(Date.now() - 120000).toISOString() } : null;
if (verb === "list" && args.includes("--json")) {
  console.log(JSON.stringify([{ key: "repository:/r:demo", name: "demo", state: "armed", running }]));
} else if (verb === "status") {
  console.log(JSON.stringify({ ok: true, data: { nodes: [{ id: "build", label: "Build it", status: "active" }] } }));
} else if (verb === "log") {
  console.log(JSON.stringify({ outcome: "ok", message: { text: "Built and merged" } }));
} else if (verb === "watcher") {
  console.log(JSON.stringify({ state: "on" }));
} else if (verb === "check") {
  console.log("demo  off\\n\\nConsent preview for demo  from /r\\n  agent  pi (pi)");
} else if (verb === "arm") {
  console.log("demo armed");
} else {
  console.log("ran " + args.join(" "));
}
`;

interface Harness {
  dir: string;
  calls: () => string[][];
  setRunning: (running: boolean) => void;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
  entries: Array<{ type: string; data: { command: string; output: string; code: number | null } }>;
  ctx: ReturnType<typeof fakeCtx>;
}

function fakeCtx(cwd: string) {
  const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
  return {
    cwd,
    mode: "tui" as const,
    hasUI: true,
    tui,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setEditorText: vi.fn(),
      confirm: vi.fn(async () => true),
      custom: vi.fn(async (factory: (...a: unknown[]) => unknown) => {
        let result: unknown;
        factory(tui, {}, {}, (v: unknown) => {
          result = v;
        });
        return result;
      }),
    },
  };
}

let h: Harness;
const saved = { ...process.env };

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-automations-test-"));
  const fm = path.join(dir, "fm");
  writeFileSync(fm, FAKE_FM);
  chmodSync(fm, 0o755);
  const log = path.join(dir, "calls.jsonl");
  const state = path.join(dir, "state.json");
  writeFileSync(log, "");
  writeFileSync(state, JSON.stringify({ running: false }));
  process.env.FM_BIN = fm;
  process.env.FAKE_FM_LOG = log;
  process.env.FAKE_FM_STATE = state;

  const commands = new Map();
  const handlers = new Map();
  const entries: Harness["entries"] = [];
  const pi = {
    registerEntryRenderer: vi.fn(),
    registerCommand: (name: string, def: unknown) => commands.set(name, def),
    registerShortcut: vi.fn(),
    on: (event: string, fn: unknown) => handlers.set(event, fn),
    appendEntry: (type: string, data: Harness["entries"][number]["data"]) => entries.push({ type, data }),
    sendUserMessage: vi.fn(),
  };
  automations(pi as never);
  h = {
    dir,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
    setRunning: (running) => writeFileSync(state, JSON.stringify({ running })),
    commands,
    handlers,
    entries,
    ctx: fakeCtx(dir),
  };
});

afterEach(async () => {
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
  process.env = { ...saved };
  rmSync(h.dir, { recursive: true, force: true });
});

const run = (args: string) => h.commands.get("automations")!.handler(args, h.ctx);

describe("/automations", () => {
  it("opens fm's screen over pi's, and gives the terminal back", async () => {
    await run("");
    expect(h.ctx.ui.custom).toHaveBeenCalledOnce();
    expect(h.ctx.tui.stop).toHaveBeenCalledOnce();
    expect(h.ctx.tui.start).toHaveBeenCalledOnce();
    expect(h.calls()[0]).toEqual(["tui"]);
  });

  it("shows fm's consent preview and arms only on yes", async () => {
    await run("arm demo");
    expect(h.ctx.ui.confirm).toHaveBeenCalledWith("Arm demo?", "Consent preview for demo  from /r\n  agent  pi (pi)");
    expect(h.calls().slice(0, 2)).toEqual([["check", "demo"], ["arm", "demo", "--yes"]]);
    expect(h.entries[0]).toMatchObject({ type: ENTRY, data: { command: "fm arm demo", output: "demo armed", code: 0 } });

    h.ctx.ui.confirm.mockResolvedValueOnce(false);
    const before = h.calls().length;
    await run("arm demo");
    expect(h.calls().slice(before).filter((c) => c[0] === "arm")).toEqual([]);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("demo is not armed", "info");
  });

  it("runs in the background and shows what fm said, without sending it to the model", async () => {
    await run("run demo");
    expect(h.calls()[0]).toEqual(["run", "demo", "--detach"]);
    await run(`log demo -n 1`);
    expect(h.entries.map((e) => e.data.command)).toEqual(["fm run demo --detach", "fm log demo -n 1"]);
  });

  it("puts a new automation's prompt in the editor for the person to finish", async () => {
    await run(`new "a nightly digest"`);
    expect(h.ctx.ui.setEditorText).toHaveBeenCalledWith(newPrompt("a nightly digest"));
  });

  it("says how to install fm when it is missing", async () => {
    process.env.FM_BIN = path.join(h.dir, "no-such-fm");
    await run("list");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(INSTALL, "warning");
  });
});

describe("the footer", () => {
  it("shows the run going and its step, then says how it ended", async () => {
    h.setRunning(true);
    await h.handlers.get("session_start")!({}, h.ctx);
    await vi.waitFor(() => expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("automations", "◐ demo · Build it · 2m"));

    h.setRunning(false);
    await run("list"); // any command looks again
    await vi.waitFor(() => expect(h.ctx.ui.notify).toHaveBeenCalledWith("demo: ok — Built and merged", "info"));
    await vi.waitFor(() => expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("automations", "◇ 1 armed"));
  });
});
