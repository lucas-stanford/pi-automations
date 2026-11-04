// pi-automations: Agent Automations in pi, run by fm.
//
// fm (https://github.com/lucas-stanford/fm) runs the automations: it finds AUTOMATION.md files, keeps
// consent, fires schedules and watches, runs each step through its agent and keeps every run's
// record. This extension brings it into pi:
//
// - `/automations` (or ctrl+alt+a) opens fm's own screen over pi's: what needs you, what is running,
//   what comes next, each automation and each run with its flowchart and output. Quit it (`q`) to
//   come back to pi.
// - `/automations <verb> …` runs one fm command. `arm` shows fm's consent preview here and asks
//   first; `run` starts the run in the background.
// - `/automations new [what]` starts pi on writing a new automation.
// - The footer says what is running and on which step, and a notification says how each run ended.

import { execFile, spawnSync } from "node:child_process";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const SHORTCUT = "ctrl+alt+a";
export const ENTRY = "automations";
const POLL_MS = 15_000;
/** Checking the watcher every poll would be a process per poll for a fact that rarely changes. */
const WATCHER_EVERY = 4;

export const INSTALL =
  "fm is not installed — cargo install --locked --git https://github.com/lucas-stanford/fm flow-manager (or set FM_BIN to it)";

/** The fm verbs `/automations` completes, with what each does. */
export const VERBS: ReadonlyArray<readonly [string, string]> = [
  ["new", "write a new automation with pi"],
  ["list", "every automation, grouped by scope"],
  ["check", "one automation in detail, with its consent preview"],
  ["arm", "arm one, after its consent preview"],
  ["disarm", "withdraw consent; it stays listed"],
  ["run", "run one now, in the background"],
  ["stop", "stop the run going now"],
  ["log", "the last runs, with their notes and links"],
  ["enable", "set enabled: true in a user automation"],
  ["disable", "set enabled: false in a user automation"],
  ["watch", "pause or resume a watch's checks"],
  ["agent", "the agent CLIs that run a body"],
  ["watcher", "start, stop or check the watcher"],
  ["validate", "check one AUTOMATION.md as the specification says"],
  ["tui", "open fm's screen"],
  ["help", "what /automations can do"],
];

// --- fm ----------------------------------------------------------------------------------------

export function fmBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FM_BIN?.trim() || "fm";
}

export interface FmResult {
  /** The exit code; `null` when fm could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** fm is not installed (or FM_BIN points nowhere). */
  missing: boolean;
}

/** Run fm with `args` in `cwd`, captured. Never rejects. */
export function runFm(args: string[], cwd: string, timeoutMs = 60_000): Promise<FmResult> {
  return new Promise((resolve) => {
    execFile(
      fmBin(),
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const missing = e?.code === "ENOENT";
        const code = !e ? 0 : typeof e.code === "number" ? e.code : null;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), missing });
      },
    );
  });
}

/** `arm my-thing "two words"` → `["arm", "my-thing", "two words"]`. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

// --- what fm says, as pi shows it ----------------------------------------------------------------

/** One automation, as `fm list --json` gives it: only what this extension reads. */
export interface FmStatus {
  key: string;
  name: string;
  state: string;
  running?: { runId: string; startedAt: string } | null;
}

/** A run going now, and the step it is on. */
export interface RunningRun {
  key: string;
  name: string;
  runId: string;
  startedAt: string;
  step?: string;
}

export function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The footer while something runs: `◐ gamegen-issue-fix · Implement the fix · 12m`. */
export function footerText(runs: RunningRun[], now: Date): string | undefined {
  if (runs.length === 0) return undefined;
  return runs
    .map((r) => `◐ ${r.name}${r.step ? ` · ${r.step}` : ""} · ${took(now.getTime() - Date.parse(r.startedAt))}`)
    .join("   ");
}

/** The footer when nothing runs: how many are armed, and a watcher that is off when it matters. */
export function idleText(statuses: FmStatus[], watcherOn: boolean | undefined): string | undefined {
  const armed = statuses.filter((s) => s.state === "armed").length;
  if (armed === 0) return undefined;
  const off = watcherOn === false ? " · watcher off — /automations watcher start" : "";
  return `◇ ${armed} armed${off}`;
}

/** The runs that were going last time and are not now. */
export function ended(before: ReadonlyMap<string, RunningRun>, statuses: FmStatus[]): RunningRun[] {
  const now = new Map(statuses.filter((s) => s.running).map((s) => [s.key, s.running?.runId]));
  return [...before.values()].filter((r) => now.get(r.key) !== r.runId);
}

/** The step a run is on, from `fm status --json`: the step going, else the hook or body going. */
export function activeStep(statusJson: string): string | undefined {
  try {
    const data = JSON.parse(statusJson)?.data;
    const nodes: Array<{ id: string; label: string; status: string }> = data?.nodes ?? [];
    const hook = (id: string) => id === "body" || /^(pre|post)\d+$/.test(id);
    const going = nodes.filter((n) => n.status === "active" || n.status === "waiting");
    return (going.find((n) => !hook(n.id)) ?? going[0])?.label;
  } catch {
    return undefined;
  }
}

/** How a finished run is said: `gamegen-issue-fix: ok — Issue #12 merged in #40`. */
export function endedMessage(name: string, recordJson: string): { text: string; level: "info" | "warning" | "error" } {
  try {
    const rec = JSON.parse(recordJson);
    const said = rec.message?.text ?? rec.error?.message ?? rec.reason ?? "";
    const text = `${name}: ${rec.outcome}${said ? ` — ${String(said).split("\n")[0]}` : ""}`;
    const level = rec.outcome === "failed" ? "error" : rec.outcome === "aborted" ? "warning" : "info";
    return { text, level };
  } catch {
    return { text: `${name}: the run ended`, level: "info" };
  }
}

/** The part of `fm check` a person decides on: the consent preview, else all of it. */
export function previewOf(checkOutput: string): string {
  const at = checkOutput.indexOf("Consent preview for");
  return (at >= 0 ? checkOutput.slice(at) : checkOutput).trim();
}

export function helpText(): string {
  return [
    "/automations                open fm's screen: what needs you, what is running, what comes next (q to come back)",
    ...VERBS.filter(([v]) => v !== "tui").map(([v, what]) => `/automations ${v.padEnd(14)} ${what}`),
    `${SHORTCUT.padEnd(27)} open fm's screen`,
    "",
    "Every verb but new and help is the fm command of the same name; `fm <verb> --help` says more.",
  ].join("\n");
}

/** The prompt `/automations new` puts in the editor, for the person to finish and send. */
export function newPrompt(what: string): string {
  return [
    `Write a new automation${what ? `: ${what}` : "."}`,
    "Use the agent-automations skill for the format. Put it in this repository's .agents/automations/,",
    "or in ~/.agents/automations/ if it is only mine. Check it with fm validate and fm check, then show",
    "me fm's consent preview: I arm it myself.",
  ].join(" ");
}

// --- the extension -------------------------------------------------------------------------------

export default function automations(pi: ExtensionAPI): void {
  let lastCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let polls = 0;
  let watcherOn: boolean | undefined;
  let running = new Map<string, RunningRun>();
  let toldMissing = false;

  /** Say something where pi can: a notification, or stderr without a UI. */
  function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
    try {
      if (ctx.hasUI) ctx.ui.notify(text, level);
      else process.stderr.write(`${text}\n`);
    } catch {
      // A context from a session that ended throws; there is nowhere left to say it.
    }
  }

  function setFooter(text: string | undefined): void {
    try {
      if (lastCtx?.hasUI) lastCtx.ui.setStatus("automations", text);
    } catch {
      // As above.
    }
  }

  /** What an fm command printed, in the session for the person, and never sent to the model. */
  function show(ctx: ExtensionContext, args: string[], r: FmResult): void {
    const output = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n") || "(no output)";
    if (!ctx.hasUI) {
      process.stdout.write(`${output}\n`);
      return;
    }
    pi.appendEntry(ENTRY, { command: `fm ${args.join(" ")}`, output, code: r.code });
  }

  /** Hand the terminal to fm's own screen, and take it back when the person quits it. */
  async function openFm(ctx: ExtensionContext, args: string[] = []): Promise<void> {
    if (ctx.mode !== "tui") {
      const r = await runFm(["list"], ctx.cwd);
      if (r.missing) return notify(ctx, INSTALL, "warning");
      show(ctx, ["list"], r);
      return;
    }
    const result = await ctx.ui.custom<{ code: number | null; missing: boolean }>((tui, _theme, _keys, done) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");
      const r = spawnSync(fmBin(), ["tui", ...args], { stdio: "inherit", cwd: ctx.cwd, env: process.env });
      tui.start();
      tui.requestRender(true);
      done({ code: r.status, missing: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" });
      return { render: () => [], invalidate: () => {} };
    });
    if (result.missing) notify(ctx, INSTALL, "warning");
    void poll();
  }

  /** `fm arm` asks on its own terminal; here pi shows the preview and asks instead. */
  async function arm(ctx: ExtensionContext, rest: string[]): Promise<void> {
    const name = rest.find((a) => !a.startsWith("-"));
    if (!name) return notify(ctx, "which automation? /automations arm <name>", "warning");
    const check = await runFm(["check", name], ctx.cwd);
    if (check.missing) return notify(ctx, INSTALL, "warning");
    if (check.code !== 0) return show(ctx, ["check", name], check);
    const preview = previewOf(check.stdout);
    if (!ctx.hasUI) {
      process.stdout.write(`${preview}\n\nTo arm it: fm arm ${name} --yes\n`);
      return;
    }
    const yes = await ctx.ui.confirm(`Arm ${name}?`, preview);
    if (!yes) return notify(ctx, `${name} is not armed`);
    const r = await runFm(["arm", name, "--yes"], ctx.cwd);
    show(ctx, ["arm", name], r);
    void poll();
  }

  async function stepOf(runId: string, cwd: string): Promise<string | undefined> {
    const r = await runFm(["status", "--run", runId, "--json"], cwd, 10_000);
    return r.code === 0 ? activeStep(r.stdout) : undefined;
  }

  /** Refresh the footer, and say how each run that ended since last time ended. */
  async function poll(): Promise<void> {
    const ctx = lastCtx;
    if (polling || !ctx?.hasUI) return;
    polling = true;
    try {
      const list = await runFm(["list", "--json"], ctx.cwd, 30_000);
      if (list.missing) {
        if (!toldMissing) notify(ctx, INSTALL, "warning");
        toldMissing = true;
        setFooter(undefined);
        return;
      }
      if (list.code !== 0) return;
      const statuses = JSON.parse(list.stdout) as FmStatus[];
      for (const r of ended(running, statuses)) {
        const log = await runFm(["log", r.name, "-n", "1", "--json"], ctx.cwd, 10_000);
        const last = log.stdout.trim().split("\n").pop() ?? "";
        const said = endedMessage(r.name, last);
        notify(ctx, said.text, said.level);
      }
      const now: RunningRun[] = [];
      for (const s of statuses) {
        if (!s.running) continue;
        now.push({
          key: s.key,
          name: s.name,
          runId: s.running.runId,
          startedAt: s.running.startedAt,
          step: await stepOf(s.running.runId, ctx.cwd),
        });
      }
      running = new Map(now.map((r) => [r.key, r]));
      if (polls++ % WATCHER_EVERY === 0) {
        const w = await runFm(["watcher", "status", "--json"], ctx.cwd, 10_000);
        try {
          watcherOn = ["on", "serve"].includes(JSON.parse(w.stdout).state);
        } catch {
          watcherOn = undefined;
        }
      }
      setFooter(footerText(now, new Date()) ?? idleText(statuses, watcherOn));
    } catch {
      // A footer that cannot be drawn this time is drawn next time.
    } finally {
      polling = false;
    }
  }

  pi.registerEntryRenderer(ENTRY, (entry, { expanded }, theme) => {
    const d = (entry.data ?? {}) as { command?: string; output?: string; code?: number | null };
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg(d.code === 0 ? "accent" : "warning", `$ ${d.command ?? "fm"}`), 0, 0));
    const lines = (d.output ?? "").split("\n");
    const shown = expanded ? lines : lines.slice(0, 40);
    const more = lines.length - shown.length;
    box.addChild(new Text(shown.join("\n") + (more > 0 ? theme.fg("dim", `\n… ${more} more lines`) : ""), 0, 0));
    return box;
  });

  pi.registerCommand("automations", {
    description: "Automations, run by fm: what needs you, what is running, what comes next",
    getArgumentCompletions: (prefix: string) => {
      if (/\s/.test(prefix)) return null;
      const items = VERBS.filter(([v]) => v.startsWith(prefix)).map(([v, what]) => ({ value: v, label: v, description: what }));
      return items.length > 0 ? items : null;
    },
    handler: async (text, ctx) => {
      lastCtx = ctx;
      const argv = splitArgs(text);
      const [verb, ...rest] = argv;
      if (!verb) return openFm(ctx);
      if (verb === "tui") return openFm(ctx, rest);
      if (verb === "help") return show(ctx, ["--help"], { code: 0, stdout: helpText(), stderr: "", missing: false });
      if (verb === "new") {
        const prompt = newPrompt(rest.join(" "));
        if (ctx.hasUI) ctx.ui.setEditorText(prompt);
        else pi.sendUserMessage(prompt);
        return;
      }
      if (verb === "arm" && !rest.includes("--yes") && !rest.includes("-y")) return arm(ctx, rest);
      // In pi a run goes in the background; fm's screen and the footer follow it.
      const args = verb === "run" && !rest.includes("--detach") ? [...argv, "--detach"] : argv;
      const r = await runFm(args, ctx.cwd, 5 * 60_000);
      if (r.missing) return notify(ctx, INSTALL, "warning");
      show(ctx, args, r);
      void poll();
    },
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Automations, run by fm: what needs you, what is running, what comes next",
    handler: async (ctx) => {
      lastCtx = ctx;
      await openFm(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    if (!ctx.hasUI) return;
    if (timer) clearInterval(timer);
    timer = setInterval(() => void poll(), POLL_MS);
    timer.unref?.();
    void poll();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    setFooter(undefined);
  });
}
