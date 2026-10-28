// The pi extension host. Only pi types are imported, so it loads under plain Node.

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { KeyId } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  applyArm,
  handleArm,
  handleCheck,
  handleDisarm,
  handleEnable,
  handleList,
  handleLog,
  handleReport,
  handleRun,
  handleRunning,
  handleStop,
  handleWatch,
  checkFacts,
  helpLines,
  logRuns,
  parseArgs,
  resolveName,
  SUBS,
  ambiguousLine,
  notFoundLine,
  refresh,
  type CommandDeps,
  type HandlerResult,
  type Refreshed,
} from "../../commands.js";

import { loadConfig, ms } from "../../config.js";
import { parseDuration } from "../../duration.js";
import { findFlowBlock } from "../../flow-block.js";
import { readFlowPlan } from "../../flow-plan.js";
import { readProgress, snapshotFromRecord, type ProgressSnapshot } from "../../progress.js";
import { findFmRenderer, fmRenderer } from "../../providers/fm/render.js";
import { createPiServices } from "./compose.js";
import { createFlowViewer } from "./flow-viewer.js";
import { withPanelKeyboard, type KeyMatcher } from "./keyboard.js";
import { createRunObserver } from "./run-observer.js";
import { createSessionViewer } from "./session-viewer.js";
import { ensureDir, readJson } from "../../jsonfile.js";
import { listingModel, statusLine } from "../../listing.js";
import { liveFile } from "../../live.js";
import { fireLogPath, packageDir, setAgentDir, stateDir, statePaths } from "../../paths.js";
import { readRunProblems } from "../../ui/firelog.js";
import { classifyWatcher, type WatcherFacts } from "../../ui/details.js";
import { findPiModule, PI_MODULE_ENV } from "../../pi-module.js";
import { piTranscriptReaders } from "../../providers/pi/transcript.js";
import { runLocalScript } from "../../providers/scripts.js";
import {
  exitCodeForCompletion,
  launchLocalWorker,
  readCompletion,
} from "../../providers/worker.js";

import { readRecords } from "../../records.js";
import { editLabel, runAction } from "../../plugins/actions.js";
import { NO_PLUGINS, pluginChartRenderer, type LoadedPlugins } from "../../plugins/loader.js";
import { loadConfiguredPlugins } from "./plugins.js";
import { readDismissedRuns, State } from "../../state.js";
import { Trust } from "../../trust.js";
import type { Config, Located, Status, Trigger } from "../../types.js";
import {
  entryDataFor,
  RUN_ENTRY_TYPE,
  runEntryComponent,
  type RunEntryData,
} from "../../ui/entry.js";
import {
  createListScreen,
  actionForToggle,
  listRunsFrom,
  type ListAction,
  type ListData,
  type ListExtras,
  type ListHeaderFacts,
  type ListFlash,
  type GlobalAction,
} from "../../ui/list.js";
import { consentActions, createPager, readerActions, type PagerKey } from "../../ui/pager.js";
import { checkPageLines } from "../../ui/check.js";
import { createRunsPage } from "../../ui/runs.js";
import { RunRegistry } from "../../ui/registry.js";
import {
  isRunning,
  parseFireLine,
  STDERR_TAIL_MAX,
  type RunView,
} from "../../ui/run-view.js";
import { runningFooter, widgetLines } from "../../ui/running.js";
import { sparkline, summarise } from "../../ui/sparkline.js";
import type { LineTheme } from "../../ui/theme.js";
import { createStatusWindow, type FlowPane } from "../../ui/window.js";
import { usualMs } from "../../ui/words.js";
import { detachedCli, status as detachedStatus } from "../../detached/index.js";

/** Every `/automations` page fills the whole terminal. */
const FULL_SCREEN = {
  anchor: "top-left",
  row: 0,
  col: 0,
  width: "100%",
  maxHeight: "100%",
  margin: 0,
} as const;

const EXIT_UNREADABLE_COMPLETION = 20;

export interface AutomationsExtensionOptions {
  readonly agentDir: string;
  readonly matchesKey?: KeyMatcher;
}

export function createAutomationsExtension(
  pi: ExtensionAPI,
  options: AutomationsExtensionOptions,
): void {
  setAgentDir(options.agentDir);

  const dir = stateDir();
  let notifiedThisSession = false;

  // After `/reload` the old context throws; the new instance re-finds runs from their locks.
  let uiAlive = true;
  // Run `fn` on a live, UI-capable context, or do nothing (print/json mode, or after `/reload`).
  function withUI(ctx: ExtensionContext | undefined, fn: (c: ExtensionContext) => void): void {
    if (!uiAlive || !ctx || !ctx.hasUI) return;
    try {
      fn(ctx);
    } catch {
      uiAlive = false;
    }
  }

  let cachedConfig: Config | undefined;
  function config(): Config {
    if (!cachedConfig) cachedConfig = loadConfig(dir).config;
    return cachedConfig;
  }

  const registry = new RunRegistry({
    stateDir: dir,
    config: config(),
    now: () => new Date(),
    progress: (flow) => readProgress(dir, flow.run),
  });

  // --- the flowchart: fm draws it when installed, otherwise the step list.

  // A plugin's renderer, when one is configured, draws first; fm is the default.
  const fm = fmRenderer(() => findFmRenderer(config().fmPath));
  const byPlugin = pluginChartRenderer(
    () => loadedPlugins?.renderer,
    (message) => withUI(lastCtx, (c) => c.ui.notify(message, "warning")),
  );
  const flowViewer = createFlowViewer({
    render: (args) => byPlugin(args) ?? fm(args),
    theme: () => themeOrPlain(),
  });

  function snapshotFor(view: RunView): ProgressSnapshot | undefined {
    if (!view.flow) return undefined;
    const live = isRunning(view) ? readProgress(dir, view.flow.run) : undefined;
    return live ?? (view.record ? snapshotFromRecord(view.record) : undefined);
  }

  function flowPaneFor(view: RunView, width: number): FlowPane | undefined {
    return flowViewer.pane(snapshotFor(view), width);
  }

  let activeTheme: LineTheme | undefined;
  function themeOrPlain(): LineTheme | undefined {
    return activeTheme;
  }

  // --- plugins: loaded once per instance from the person's config, never from a repository.

  let pluginsLoading: Promise<LoadedPlugins> | undefined;
  let loadedPlugins: LoadedPlugins | undefined;

  function plugins(): Promise<LoadedPlugins> {
    pluginsLoading ??= loadConfiguredPlugins({
      config: config(),
      stateDir: dir,
      where: "host",
      cwd: () => lastCtx?.cwd ?? process.cwd(),
    })
      .catch(() => NO_PLUGINS)
      .then((p) => {
        loadedPlugins = p;
        return p;
      });
    return pluginsLoading;
  }

  // `e`, `/automations edit` and every plugin action, with the outcome said where pi can say it.
  async function act(ctx: ExtensionContext, id: string, status: Pick<Status, "key" | "name" | "scope" | "dir"> | undefined): Promise<ListFlash> {
    const outcome = await runAction({ id, plugins: await plugins(), ...(status ? { status } : {}), where: "host" });
    return { tone: outcome.exitCode ? "warning" : "success", message: outcome.lines.join("\n") };
  }
  let lastCtx: ExtensionContext | undefined;

  // True in `print` and `json` mode; set per command.
  let waitForRuns = false;

  // --- footer: one timer, only while something runs; `setStatus` only on change.

  let footerText: string | undefined;
  /** The last quiet summary, so the footer can fall back to it without re-running discovery. */
  let idleFooter: string | undefined;

  function setFooter(text: string | undefined): void {
    if (text === footerText) return;
    footerText = text;
    withUI(lastCtx, (c) => c.ui.setStatus("automations", text));
  }

  function paintFooter(): void {
    const views = registry.all().map((e) => e.view);
    setFooter(runningFooter(views, new Date()) ?? idleFooter);
  }

  // --- the compact strip above the editor: one line per running run while the Running page is closed.

  let widgetShown = false;

  function paintWidget(tick = 0): void {
    const views = registry.all().map((e) => e.view);
    const lines = windowOpen ? [] : widgetLines(views, new Date(), tick);

    if (lines.length === 0) {
      if (!widgetShown) return;
      widgetShown = false;
      withUI(lastCtx, (c) => c.ui.setWidget("automations", undefined));
      return;
    }
    widgetShown = true;
    withUI(lastCtx, (c) => c.ui.setWidget("automations", lines, { placement: "aboveEditor" }));
  }

  /** The one-second poll: observed runs from the locks, and progress for tracked runs. */
  /** One owner for the subscription and timers, so `/reload` can dispose all of them. */
  const observer = createRunObserver({
    registry,
    paintFooter,
    paintWidget,
    poll: () => {
      registry.refreshObserved((lastStatuses ?? []).map((s) => s.key));
      registry.refreshFlow();
    },
  });
  observer.start();

  // --- the Running page: overlays are disposed on close, so each open calls `custom()` again.

  let windowOpen = false;
  let nextHintText: string | undefined;
  let lastStatuses: Status[] | undefined;

  // The subcommands, and the ones that take an automation name. Kept together so they cannot drift.
  const SUB_COMPLETIONS: { value: string; description: string }[] = [
    { value: "list", description: "every automation, grouped by scope" },
    { value: "running", description: "every run in flight, with its steps" },
    { value: "run", description: "run one now" },
    { value: "arm", description: "arm it, after the consent preview" },
    { value: "disarm", description: "withdraw consent; it stays listed" },
    { value: "enable", description: "set enabled: true" },
    { value: "disable", description: "set enabled: false" },
    { value: "log", description: "the same as runs" },
    { value: "runs", description: "the last n runs, with their notes and links" },
    { value: "check", description: "re-check everything, or one in detail" },
    { value: "watch", description: "every watch and its last check, or run one check now" },
    { value: "edit", description: "edit it: in the Automation Manager (or another editing plugin), else AUTOMATION.md in your editor" },
    { value: "report", description: "write an HTML report" },
    { value: "watcher", description: "start | stop | status — the watcher, which fires schedules and runs watch checks" },
    { value: "help", description: "the command list" },
  ];
  const NAME_TAKING = new Set(["run", "arm", "disarm", "enable", "disable", "log", "runs", "check", "watch", "edit"]);

  /** A literal rather than pi-tui's `Key.ctrlAlt("a")`, which would be a runtime import. */
  const SHORTCUT: KeyId = "ctrl+alt+a";

  const sessionViewer = createSessionViewer({ readers: piTranscriptReaders });

  function sessionPaneFor(view: RunView, width: number): string[] | undefined {
    // While a run is going, read its live file: pi writes the session only per completed turn.
    const live = isRunning(view) ? liveFile(stateDir(), view.key) : undefined;

    return sessionViewer.pane({
      source: { ...(live ? { live } : {}), ...(view.session ? { session: view.session } : {}) },
      width,
      ...(activeTheme ? { theme: activeTheme } : {}),
    });
  }
  // `x` asks the run to stop; the run's own process records and releases its lock.
  function stopRun(ctx: ExtensionContext, view: Pick<RunView, "key" | "name" | "runId">): void {
    // A newer extension against an older dist. Say so rather than throwing from a keystroke.
    if (typeof handleStop !== "function") {
      withUI(ctx, (c) => {
        c.ui.notify("restart pi to pick up the compiled library before stopping a run", "warning");
      });
      return;
    }
    const result = handleStop({ stateDir: dir }, view);
    withUI(ctx, (c) => {
      c.ui.notify(result.lines.join("\n"), result.exitCode ? "warning" : "info");
    });
    registry.refreshObserved((lastStatuses ?? []).map((s) => s.key));
  }

  function openStatusWindow(ctx: ExtensionContext, opts: { graphFor?: string; runFor?: string } = {}): void {
    if (ctx.mode !== "tui" || windowOpen) return;
    windowOpen = true;
    paintWidget();
    let component: { dispose(): void } | undefined;

    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          const c = createStatusWindow({
            registry,
            tui,
            theme,
            now: () => new Date(),
            close: () => done(undefined),
            nextHint: () => nextHintText,
            ...(opts.graphFor ? { openGraphFor: opts.graphFor } : {}),
            ...(opts.runFor ? { openRunFor: opts.runFor } : {}),
            flowView: (view, width) => flowPaneFor(view, width),
            sessionView: (view, width) => sessionPaneFor(view, width),
            onStop: (view) => stopRun(ctx, view),
            onEditAutomation: (view) => {
              void refresh(makeDeps(ctx))
                .then((r) => act(ctx, "edit", r.statuses.find((s) => s.key === view.key)))
                .then((flash) => withUI(ctx, (c) => c.ui.notify(flash.message, flash.tone === "success" ? "info" : "warning")))
                .catch(() => undefined);
            },
            onLog: (view) => {
              void showRunsPage(ctx, { key: view.key, name: view.name });
            },
            usual: (key) => usualMs(readRecords(dir, key, 7)),
          });
          activeTheme = theme;
          component = c;
          return withPanelKeyboard(c, options.matchesKey, () => done(undefined));
        },
        {
          overlay: true,
          overlayOptions: () => ({ ...FULL_SCREEN }),
        },
      )
      .catch(() => {
        // A session that went away while the overlay was open.
      })
      .finally(() => {
        windowOpen = false;
        component?.dispose();
        paintWidget();
      });
  }

  async function showRunsPage(ctx: ExtensionContext, status: Pick<Status, "key" | "name">, n = 10): Promise<boolean> {
    if (ctx.mode !== "tui") return false;
    try {
      const runs = logRuns({ stateDir: dir }, status.key, n);
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          withPanelKeyboard(
            createRunsPage({ tui, theme, name: status.name, runs, close: () => done(undefined) }),
            options.matchesKey,
            () => done(undefined),
          ),
        { overlay: true, overlayOptions: () => ({ ...FULL_SCREEN }) },
      );
      return true;
    } catch {
      // A log that cannot be read must not take the window down with it.
      return false;
    }
  }

  async function showCheckPage(ctx: ExtensionContext, deps: CommandDeps, r: Refreshed, status: Status): Promise<boolean> {
    if (ctx.mode !== "tui") return false;
    try {
      const facts = checkFacts(deps, r, status, watcherNow());
      await ctx.ui.custom<boolean>(
        (tui, theme, _keybindings, done) => {
          const t: LineTheme = theme;
          const state = status.running ? "running" : status.state;
          const colour = status.running ? "accent" : status.state === "armed" ? "success" : status.state === "disabled" ? "dim" : status.state === "invalid" ? "error" : "warning";
          return withPanelKeyboard(
            createPager({
              tui,
              theme,
              title: `${status.name} · check`,
              right: t.fg(colour, state),
              lines: checkPageLines(facts, t),
              actions: readerActions(),
              otherwise: "ignore",
              resolve: done,
            }),
            options.matchesKey,
            () => done(false),
          );
        },
        { overlay: true, overlayOptions: () => ({ ...FULL_SCREEN }) },
      );
      return true;
    } catch {
      return false;
    }
  }

  // --- the /automations page -------------------------------------------------------------------

  let listOpen = false;
  // How often an open /automations page re-reads, so it keeps up with runs the watcher fires.
  const LIST_REFRESH_MS = 10_000;

  async function listData(ctx: ExtensionContext, opts: { background?: boolean } = {}): Promise<{ data: ListData; deps: CommandDeps }> {
    const deps: CommandDeps = { ...makeDeps(ctx), ...(await runtimeOpt()) };
    // Ask the scheduler again when its answer is old, so R notices a job stopped from elsewhere.
    // The timed re-read asks less often: the query spawns a process.
    const hintMaxAge = opts.background ? 60_000 : 20_000;
    if (!jobStatus || Date.now() - jobStatus.at > hintMaxAge) await refreshDetachedHint();
    const r = await refresh(deps);
    rememberIdleFooter(r);
    registry.refreshObserved(r.statuses.map((s: Status) => s.key));

    const details: NonNullable<ListData["details"]> = {};
    const dismissedRuns = readDismissedRuns(dir);
    const model = listingModel(r.statuses, {
      home: deps.home,
      projectRoots: r.projectRoots,
      now: deps.now(),
      ...(deps.width ? { width: deps.width } : {}),
      decorate: (row) => {
        const records = readRecords(dir, row.status.key, 7);
        const outcomes = records.map((rec) => rec.outcome);
        const lastRecord = records.at(-1);
        const flowSource = row.status.flow
          ? automationHasFlowBlock(row.status.dir)
            ? "automation"
            : readFlowPlan(row.status.dir) !== undefined
              ? "file"
              : config().flowTracking[row.status.key] === true
                ? "config"
                : "none"
          : "none";
        details[row.status.key] = {
          ...(lastRecord ? { lastRecord } : {}),
          records,
          ...(dismissedRuns[row.status.key] ? { dismissedRunId: dismissedRuns[row.status.key] } : {}),
          flowSource,
          history: outcomes,
        };
        if (outcomes.length === 0) return;
        row.sparkline = sparkline(outcomes);
        row.summary = summarise(outcomes);
      },
    });

    const counts = { armed: 0, off: 0, disabled: 0, invalid: 0 };
    for (const s of r.statuses as Status[]) counts[s.state]++;

    const watcher = watcherNow();
    const facts: ListHeaderFacts = {
      counts,
      running: (r.statuses as Status[]).filter((s) => s.running).length,
      ...(watcher ? { watcher } : {}),
    };

    const p = await plugins();
    const extras: ListExtras = {
      edit: editLabel(p),
      actions: p.actions
        .filter((a) => a.action.id !== "edit")
        .map((a) => ({
          id: a.action.id,
          label: a.action.label,
          ...(a.action.key ? { key: a.action.key } : {}),
          ...(a.action.description ? { why: a.action.description } : {}),
        })),
    };

    return { data: { model, facts, details, config: deps.config, home: deps.home, now: deps.now(), extras }, deps };
  }

  // Whether the watcher is on. Asked rarely: the query spawns a process.
  let jobStatus: { installed: boolean; stale: boolean; at: number } | undefined;
  async function refreshDetachedHint(): Promise<void> {
    try {
      const s = await detachedStatus({ dir });
      jobStatus = { installed: s.installed, stale: s.stale, at: Date.now() };
    } catch {
      jobStatus = undefined;
    }
  }

  // The watcher as of now: the scheduler's answer (cached briefly) and the last tick, read fresh.
  function watcherNow(): WatcherFacts | undefined {
    if (!jobStatus) return undefined;
    const st = readJson<{ lastTickAt?: string; lastTickBy?: string }>(statePaths(dir).state);
    return classifyWatcher(jobStatus, st?.lastTickAt, new Date(), st?.lastTickBy);
  }

  async function performGlobalAction(action: GlobalAction): Promise<ListFlash> {
    const out = await detachedCli([action === "watcher-start" ? "start" : "stop"], { stateDir: dir });
    await refreshDetachedHint();
    if (out.exitCode !== 0) {
      return { tone: "error", message: out.lines.filter(Boolean).at(-1) ?? "the watcher did not start" };
    }
    return action === "watcher-start"
      ? { tone: "success", message: "Watcher on — it fires schedules and runs watch checks once a minute" }
      : { tone: "success", message: "Watcher off — schedules and watch checks wait until you start it again with w" };
  }

  function openList(ctx: ExtensionContext, initial: ListData): void {
    if (ctx.mode !== "tui" || listOpen) return;
    listOpen = true;
    let component: { dispose(): void } | undefined;

    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          const c = createListScreen(
            {
              tui,
              theme,
              close: () => done(undefined),
              reload: async (opts) => (await listData(ctx, opts)).data,
              act: (action, status) => performListAction(ctx, action, status),
              actGlobal: (action) => performGlobalAction(action),
              now: () => new Date(),
              runs: listRunsFrom(registry),
              refreshMs: LIST_REFRESH_MS,
            },
            initial,
          );
          component = c;
          return withPanelKeyboard(c, options.matchesKey, () => done(undefined));
        },
        {
          overlay: true,
          overlayOptions: () => ({ ...FULL_SCREEN }),
        },
      )
      .catch(() => {})
      .finally(() => {
        listOpen = false;
        component?.dispose();
      });
  }

  // Run one action chosen from the list, through the same `handle*` functions as the slash command.
  async function performListAction(
    ctx: ExtensionContext,
    action: ListAction,
    status: Status,
  ): Promise<ListFlash | void> {
    if (action === "window") {
      openStatusWindow(ctx, { runFor: status.key });
      return;
    }
    if (action === "stop") {
      // Keep both the key and the runId from the selected row, so a stop never hits the next run.
      stopRun(ctx, { key: status.key, name: status.name, runId: status.running?.runId });
      return { tone: "info", message: `stop requested for ${status.name}` };
    }
    if (action === "edit") return act(ctx, "edit", status);
    if (action.startsWith("plugin:")) return act(ctx, action.slice("plugin:".length), status);
    if (action === "dismiss-run") {
      const last = readRecords(dir, status.key, 1).at(-1);
      if (!last || last.outcome !== "failed") {
        return { tone: "warning", message: `${status.name} has no failed run to dismiss` };
      }
      new State(dir).update((state) => {
        state.dismissRun(status.key, last.id);
      });
      return { tone: "success", message: `Dismissed ${status.name}'s failed run until a newer run finishes` };
    }
    const deps: CommandDeps = { ...makeDeps(ctx), ...(await runtimeOpt()) };
    const r = await refresh(deps);
    const name = status.key;

    let result: HandlerResult;
    let actual: ListAction = action;
    if (action === "toggle") {
      const refreshed = r.statuses.find((s) => s.key === status.key) ?? status;
      actual = actionForToggle(refreshed) ?? action;
      if (actual === "toggle") {
        return { tone: "warning", message: "space has no action for this row" };
      }
    }

    if (actual === "log" || actual === "check") {
      const current = r.statuses.find((s) => s.key === status.key) ?? status;
      const shown = actual === "log" ? await showRunsPage(ctx, current) : await showCheckPage(ctx, deps, r, current);
      if (shown) return;
    }

    switch (actual) {
      case "run":
        result = await handleRun(deps, r, name);
        break;
      case "run-flow":
        result = await handleRun(deps, r, name, { flow: true });
        break;
      case "arm":
      case "arm-and-run":
        result = await handleArm(deps, r, name, actual === "arm-and-run");
        break;
      case "disarm":
        result = await handleDisarm(deps, r, name);
        break;
      case "enable":
        result = await handleEnable(deps, r, name, true);
        break;
      case "disable":
        result = await handleEnable(deps, r, name, false);
        break;
      case "toggle":
        return;
      case "log":
        result = await handleLog(deps, r, name, 10, false);
        break;
      case "check":
        result = await handleCheck(deps, r, name);
        break;
      case "pause-watch":
      case "resume-watch": {
        const paused = await handleWatch(deps, r, name, actual === "pause-watch" ? "pause" : "resume");
        return { tone: (paused.exitCode ?? 0) === 0 ? "success" : "warning", message: paused.lines[0] ?? status.name };
      }
      default:
        return;
    }

    await finishCommand(
      ctx,
      deps,
      result,
      actual === "run" || actual === "run-flow"
        ? "run"
        : actual === "log"
          ? "log"
          : actual === "check"
            ? "check"
            : "other",
      actual === "run-flow" ? status.key : undefined,
    );
    const ok = (result.exitCode ?? 0) === 0;
    if (actual === "log" || actual === "check") return;
    const message =
      actual === "run" || actual === "run-flow"
        ? `started ${status.name}`
        : (result.lines[0] ?? `${status.name}: ${labelForFlash(actual)}`);
    return { tone: ok ? "success" : "warning", message };
  }

  function labelForFlash(action: ListAction): string {
    switch (action) {
      case "run":
        return "run started";
      case "run-flow":
        return "run started — following its flowchart";
      case "arm":
        return "armed";
      case "arm-and-run":
        return "armed and run started";
      case "disarm":
        return "disarmed";
      case "enable":
        return "enabled";
      case "disable":
        return "disabled";
      default:
        return action;
    }
  }

  // --- consent, log and check as overlays ------------------------------------------------------

  function pager(
    ctx: ExtensionContext,
    args: { title: string; lines: string[]; actions: PagerKey[]; otherwise: "ignore" | "reject" },
  ): Promise<boolean> {
    // `custom` is TUI-only; guard here since this is the one place it is called.
    if (ctx.mode !== "tui") return Promise.resolve(false);
    return ctx.ui.custom<boolean>(
      (tui, theme, _keybindings, done) =>
        withPanelKeyboard(
          createPager({
            tui,
            theme,
            title: args.title,
            lines: args.lines,
            actions: args.actions,
            otherwise: args.otherwise,
            resolve: done,
          }),
          options.matchesKey,
          () => done(false),
        ),
      {
        overlay: true,
        overlayOptions: () => ({ ...FULL_SCREEN }),
      },
    );
  }

  // Ask for consent: a scrollable preview in a terminal, `ctx.ui.confirm` elsewhere.
  async function askConsent(
    ctx: ExtensionContext,
    title: string,
    preview: string[],
  ): Promise<boolean> {
    if (ctx.mode === "tui") {
      try {
        return await pager(ctx, {
          title,
          lines: preview,
          actions: consentActions(),
          // Only `y` arms. Anything else keeps it off.
          otherwise: "reject",
        });
      } catch {
        return false;
      }
    }
    if (ctx.hasUI) return ctx.ui.confirm(title, preview.join("\n"));
    return false;
  }

  async function showReader(ctx: ExtensionContext, title: string, lines: string[]): Promise<boolean> {
    if (ctx.mode !== "tui" || lines.length === 0) return false;
    try {
      await pager(ctx, { title, lines, actions: readerActions(), otherwise: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  function makeDeps(ctx: ExtensionContext): CommandDeps {
    cachedConfig = loadConfig(dir).config;
    return {
      config: cachedConfig,
      stateDir: dir,
      trust: new Trust(dir),
      state: new State(dir),
      now: () => new Date(),
      home: homedir(),
      cwd: ctx.cwd,
      spawnFire,
      runScript: runLocalScript,
    };
  }

  function timeoutFor(l: Located): number {
    return parseDuration(l.automation.timeout ?? "") ?? ms(config(), "defaultTimeout");
  }

  // The environment a spawned run gets: ours plus the pi SDK location, since `bin/fire.js` has no
  // pi loader aliases. Must never throw: the child can find pi by itself.
  function piEnv(): NodeJS.ProcessEnv {
    try {
      // An inherited hint wins: the session that spawned us already decided which pi to use.
      if (process.env[PI_MODULE_ENV]) return process.env;
      const here = findPiModule();
      return here?.dir ? { ...process.env, [PI_MODULE_ENV]: here.dir } : process.env;
    } catch {
      // The child searches for itself. Losing the hint costs nothing; crashing pi costs everything.
      return process.env;
    }
  }

  // Spawn one run via `bin/fire.js`: attached for a manual run, in the background otherwise. In a terminal
  // this returns once the child exists; print and json mode wait for the result.
  function spawnFire(
    args: string[],
    opts: { attached: boolean; located?: Located },
  ): Promise<number> {
    const wait = waitForRuns;
    return new Promise<number>((resolve) => {
      const child = launchLocalWorker({
        entry: process.execPath,
        args: [path.join(packageDir(), "bin", "fire.js"), ...args],
        detached: !opts.attached,
        output: { kind: opts.attached ? "pipe" : "ignore" },
        env: piEnv() as Record<string, string>,
      });

      if (!opts.attached) {
        // Released, not abandoned: the run outlives this session.
        child.release();
        resolve(0);
        return;
      }

      const trigger: Trigger = args.includes("--manual") ? "manual" : "schedule";
      const id = opts.located
        ? registry.addAttached({
            located: opts.located,
            trigger,
            timeoutMs: timeoutFor(opts.located),
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
          })
        : undefined;

      // Attached runs tee the same NDJSON as background ones, so step detail survives `/reload`.
      const key = args[0];
      let logFile: string | undefined;
      if (key) {
        try {
          ensureDir(statePaths(dir).logs);
          logFile = fireLogPath(dir, key);
        } catch {
          logFile = undefined;
        }
      }

      const tee = (line: string): void => {
        if (!logFile) return;
        try {
          appendFileSync(logFile, `${line}\n`, "utf8");
        } catch {
          logFile = undefined;
        }
      };

      let sawRecord = false;
      let exitCode = 0;
      const stderrTail: string[] = [];

      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => {
          tee(line);
          const event = parseFireLine(line);
          if (!event) return;
          if (event.event === "record") {
            sawRecord = true;
            exitCode = EXIT_FOR[event.record.outcome] ?? 0;
            if (id) {
              registry.applyEvent(id, event);
              const e = registry.all().find((x) => x.id === id);
              if (e) appendRunEntry(e.view);
            }
            if (!wait) announce(event.record.name, event.record.outcome, event.record.reason);
            if (wait) {
              // Print mode has no transcript to notify into; the lines ARE the answer.
              process.stdout.write(
                `${event.record.name} ${event.record.outcome}${event.record.reason ? ` · ${event.record.reason}` : ""}\n`,
              );
            }
            return;
          }
          if (id) registry.applyEvent(id, event);
        });
        rl.on("error", () => {});
      }

      if (child.stderr) {
        const rl = createInterface({ input: child.stderr });
        rl.on("line", (line) => {
          stderrTail.push(line);
          if (stderrTail.length > STDERR_TAIL_MAX) stderrTail.shift();
          tee(line);
        });
        rl.on("error", () => {});
      }

      child.completion.then(
        (completion) => {
          // A signalled worker reports 0, as before; an unreadable completion is the failure.
          const read = readCompletion(completion);
          const code = read ? exitCodeForCompletion(read) : EXIT_UNREADABLE_COMPLETION;
          if (!sawRecord) {
            if (id) {
              registry.crash(id, code, stderrTail);
              const e = registry.all().find((x) => x.id === id);
              if (e) appendRunEntry(e.view);
            }
            if (wait) {
              process.stdout.write(
                [
                  `${(key ?? "automation").slice((key ?? "").lastIndexOf(":") + 1)} exited ${code} without a record`,
                  ...stderrTail.map((l) => `  ${l}`),
                ].join("\n") + "\n",
              );
            } else {
              announceCrash(key ?? "automation", code);
            }
          }
          if (wait) resolve(sawRecord ? exitCode : code);
        },
        () => {
          if (id) registry.crash(id, 20, [...stderrTail, "the run process could not be started"]);
          if (wait) resolve(20);
        },
      );

      // "Started", not "finished" — unless this mode has nowhere to report completion.
      if (!wait) resolve(0);
    });
  }

  const EXIT_FOR: Record<string, number> = {
    ok: 0,
    skipped: 10,
    failed: 20,
    missed: 20,
    aborted: 30,
  };

  function announce(name: string, outcome: string, reason?: string): void {
    const detail = reason ? ` · ${reason}` : "";
    withUI(lastCtx, (c) =>
      c.ui.notify(`${name} ${outcome}${detail}`, outcome === "failed" ? "error" : "info"),
    );
  }

  function announceCrash(key: string, code: number): void {
    const name = key.slice(key.lastIndexOf(":") + 1);
    withUI(lastCtx, (c) =>
      c.ui.notify(`${name} exited ${code} without a record — /automations running`, "error"),
    );
  }

  // --- transcript entries: `appendEntry`, never `sendMessage`, so output stays out of the LLM context.

  pi.registerEntryRenderer<RunEntryData>(RUN_ENTRY_TYPE, (entry, options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    // Read when the entry is expanded, so a fault reported after the receipt is still shown.
    const shown = options.expanded
      ? { ...data, problems: problemsForEntry(data) ?? data.problems }
      : data;
    return runEntryComponent(shown, options.expanded, theme);
  });

  // The stored copy survives a rotated log; a read that finds nothing never erases it.
  function problemsForEntry(data: RunEntryData): string[] | undefined {
    const stored = data.problems ?? [];
    const key = data.key ?? data.record?.key;
    const runId = data.runId ?? data.record?.id;

    let found: string[] = [];
    if (key && runId) {
      try {
        found = readRunProblems(stateDir(), key, runId);
      } catch {
        found = [];
      }
    }

    const all = [...stored];
    for (const p of found) if (!all.includes(p)) all.push(p);
    return all.length > 0 ? all : undefined;
  }

  function appendRunEntry(view: RunView): void {
    try {
      // Rendered NOW and stored on the entry: a transcript is a record of what happened.
      pi.appendEntry<RunEntryData>(RUN_ENTRY_TYPE, entryDataFor(view, flowLinesFor(view)));
    } catch {
      // A transcript that will not take an entry must never affect the run.
    }
  }

  function flowLinesFor(view: RunView): string[] | undefined {
    return flowViewer.lines(snapshotFor(view));
  }

  // Every session start rebuilds observed runs from the locks.
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    uiAlive = true;

    try {
      const deps = makeDeps(ctx);
      const resolveModel = await safeResolver();
      const r = await refresh({ ...deps, ...(resolveModel ? { resolveModel } : {}) });

      registry.refreshObserved(r.statuses.map((s: Status) => s.key));
      rememberIdleFooter(r);

      if (!ctx.hasUI) return;

      paintFooter();
      observer.sync();

      if (notifiedThisSession) return;
      notifiedThisSession = true;

      void plugins().then((p) => {
        for (const w of p.warnings) withUI(ctx, (c) => c.ui.notify(w, "warning"));
      });

      for (const s of r.statuses.filter((x: Status) => x.state === "invalid")) {
        ctx.ui.notify(`${s.name}: ${s.reason ?? "invalid"}`, "warning");
      }

      const off = r.statuses.filter((s: Status) => s.state === "off");
      if (off.length > 0) {
        const kind = off.every((s: Status) => s.scope === "repository")
          ? "repository automation"
          : off.every((s: Status) => s.scope === "user")
            ? "user automation"
            : "automation";
        ctx.ui.notify(
          `${off.length} ${kind}${off.length === 1 ? "" : "s"} found — off until armed. /automations arm <name>`,
          "info",
        );
      }
    } catch {
      // Discovery must never stop a pi session from starting.
    }
  });

  // The session is ending: stop watching. Runs keep their own lock and record.
  pi.on("session_shutdown", async () => {
    observer.dispose();
    sessionViewer.dispose();
    void loadedPlugins?.shutdown();
    flowViewer.clear();
    footerText = undefined;
    withUI(lastCtx, (c) => {
      c.ui.setStatus("automations", undefined);
      if (widgetShown) c.ui.setWidget("automations", undefined);
    });
    widgetShown = false;
    registry.clear();
    lastStatuses = undefined;
    idleFooter = undefined;
    nextHintText = undefined;
    jobStatus = undefined;
    lastCtx = undefined;
  });

  // `ctrl+alt+a` opens the list. Neither pi nor pi-tui binds any `ctrl+alt+<letter>` by default.
  pi.registerShortcut(SHORTCUT, {
    description: "Automations — what needs you, what is running, what comes next",
    handler: async (ctx) => {
      lastCtx = ctx;
      uiAlive = true;
      if (ctx.mode !== "tui") return;
      try {
        const deps = makeDeps(ctx);
        const r = await refresh(deps);
        registry.refreshObserved(r.statuses.map((s: Status) => s.key));
        rememberIdleFooter(r);

        await refreshDetachedHint();

        const { data } = await listData(ctx);
        openList(ctx, data);
      } catch {
        // A shortcut that cannot answer must not take the session down.
      }
    },
  });

  pi.registerCommand("automations", {
    description: "Agent Automations — list, run and arm scheduled automations",
    /** Completions come from the last refresh, never a per-keystroke discovery. */
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const firstSpace = trimmed.indexOf(" ");

      if (firstSpace === -1) {
        return SUB_COMPLETIONS.filter((s) => s.value.startsWith(trimmed)).map((s) => ({
          value: s.value,
          label: s.value,
          description: s.description,
        }));
      }

      const sub = trimmed.slice(0, firstSpace);
      if (!NAME_TAKING.has(sub)) return null;

      const partial = trimmed.slice(firstSpace + 1).trimStart();
      return (lastStatuses ?? [])
        .filter((s) => s.name.startsWith(partial))
        .map((s) => ({
          value: `${sub} ${s.name}`,
          label: s.name,
          description: `${s.scope} · ${s.state}`,
        }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      lastCtx = ctx;
      uiAlive = true;
      waitForRuns = ctx.mode === "print" || ctx.mode === "json";
      const parsed = parseArgs(args);
      const full: CommandDeps = { ...makeDeps(ctx), ...(await runtimeOpt()) };

      const r = await refresh(full);
      let result: HandlerResult;

      const [first, second] = args.trim().split(/\s+/);
      if (first && !SUBS.has(first) && (await plugins()).action(first)) {
        await finishCommand(ctx, full, await actOnName(full, r, first, second), "other");
        return;
      }

      switch (parsed.sub) {
        case "list":
          // In a terminal the list is an interactive screen; elsewhere plain text.
          if (ctx.mode === "tui" && !parsed.name) {
            await refreshDetachedHint();
            const { data } = await listData(ctx);
            openList(ctx, data);
            return;
          }
          result = await handleList(full, r);
          break;
        case "run":
          result = await handleRun(full, r, parsed.name);
          break;
        case "running":
          if (ctx.mode === "tui") {
            // In a terminal the window is the answer; re-read observed runs first.
            registry.refreshObserved(r.statuses.map((s: Status) => s.key));
            rememberIdleFooter(r);
            openStatusWindow(ctx);
            result = { lines: [] };
          } else {
            result = await handleRunning(full, r);
          }
          break;
        case "arm":
          result = await handleArm(full, r, parsed.name);
          break;
        case "disarm":
          result = await handleDisarm(full, r, parsed.name);
          break;
        case "enable":
          result = await handleEnable(full, r, parsed.name, true);
          break;
        case "disable":
          result = await handleEnable(full, r, parsed.name, false);
          break;
        case "log":
        case "runs": {
          const one = ctx.mode === "tui" && !parsed.flags.has("json") && parsed.name ? resolveName(r.statuses, parsed.name) : undefined;
          if (one?.kind === "one" && (await showRunsPage(ctx, one.status, parsed.n ?? 10))) return;
          result = await handleLog(full, r, parsed.name, parsed.n ?? 10, parsed.flags.has("json"));
          break;
        }
        case "check": {
          const one = ctx.mode === "tui" && parsed.name ? resolveName(r.statuses, parsed.name) : undefined;
          if (one?.kind === "one") {
            if (!jobStatus) await refreshDetachedHint();
            if (await showCheckPage(ctx, full, r, one.status)) return;
          }
          result = await handleCheck(full, r, parsed.name);
          break;
        }
        case "watch":
          result = await handleWatch(full, r, parsed.name, parsed.verb);
          break;
        case "edit":
          result = await actOnName(full, r, "edit", parsed.name);
          break;
        case "report":
          result = await handleReport(full, r, parsed.flags.has("open"));
          break;
        case "watcher": {
          const out = await detachedCli([parsed.verb ?? "status", ...(parsed.flags.has("purge") ? ["--purge"] : [])], {
            stateDir: dir,
          });
          await refreshDetachedHint();
          result = { lines: out.lines, exitCode: out.exitCode };
          break;
        }
        case "help":
          result = { lines: helpLines(helpExtras(await plugins())) };
          break;
        default:
          result = { lines: [`${parsed.sub} is not available yet`, ...helpLines(helpExtras(await plugins()))], exitCode: 2 };
      }

      // Consent is the one thing this layer decides, because only it can ask a person.
      await finishCommand(ctx, full, result, readerKind(parsed.sub, parsed.flags));
    },
  });

  async function actOnName(deps: CommandDeps, r: Refreshed, id: string, name: string | undefined): Promise<HandlerResult> {
    let status: Status | undefined;
    if (name) {
      const match = resolveName(r.statuses, name);
      if (match.kind !== "one") {
        return { lines: [match.kind === "ambiguous" ? ambiguousLine(name, match.matches, deps.home) : notFoundLine(name)], exitCode: 2 };
      }
      status = match.status;
    }
    const outcome = await runAction({ id, plugins: await plugins(), ...(status ? { status } : {}), where: "host" });
    return { lines: outcome.lines, ...(outcome.exitCode ? { exitCode: outcome.exitCode } : {}) };
  }

  function helpExtras(p: LoadedPlugins): Parameters<typeof helpLines>[0] {
    const edit = p.action("edit");
    return {
      ...(edit ? { edit: `${edit.action.label} (${edit.plugin} plugin)` } : {}),
      actions: p.actions.map((a) => ({ id: a.action.id, label: `${a.action.label} (${a.plugin} plugin)` })),
    };
  }

  /** The tail every command shares: consent, output, and the footer. */
  async function finishCommand(
    ctx: ExtensionContext,
    deps: CommandDeps,
    result: HandlerResult,
    kind: "run" | "log" | "check" | "other",
    graphFor?: string,
  ): Promise<void> {
    if (result.consent) {
      const { located, preview, andRun } = result.consent;
      const title = `${andRun ? "Arm and run" : "Arm"} ${located.automation.name}`;

      if (ctx.mode !== "tui") emit(ctx, preview);
      const accepted = await askConsent(ctx, title, preview);

      if (!accepted) {
        emit(ctx, [
          ctx.hasUI
            ? `${located.automation.name} stays off`
            : `${located.automation.name} stays off — arming needs a terminal that can ask`,
        ]);
        return;
      }

      emit(ctx, applyArm(deps, located));
      if (andRun) {
        await spawnFire([located.key, "--manual"], { attached: true, located });
        openStatusWindow(ctx);
      }
      return;
    }

    // If the overlay cannot open, the lines still go to the transcript.
    if ((kind === "log" || kind === "check") && result.lines.length > 0) {
      const shown = await showReader(ctx, titleForReader(kind, result.lines), result.lines);
      if (!shown) emit(ctx, result.lines);
    } else {
      emit(ctx, result.lines);
    }

    if (kind === "run" && (result.exitCode ?? 0) === 0) {
      openStatusWindow(ctx, graphFor ? { graphFor } : {});
    }

    const after = await refresh(deps);
    rememberIdleFooter(after);
    paintFooter();
  }

  function titleForReader(kind: "log" | "check", lines: string[]): string {
    const first = (lines[0] ?? "").trim();
    const name = first.split(/\s+/)[0] ?? "";
    return kind === "log" ? `Log · ${name}` : `Check · ${name}`;
  }

  /** `--json` stays in the transcript so it can be piped or copied. */
  function readerKind(sub: string, flags: Set<string>): "run" | "log" | "check" | "other" {
    if (sub === "run") return "run";
    if (flags.has("json")) return "other";
    if (sub === "log" || sub === "runs") return "log";
    if (sub === "check" || sub === "watch") return "check";
    return "other";
  }

  /** Remember the quiet footer and next-fire hint so the footer timer never re-runs discovery. */
  function rememberIdleFooter(r: Refreshed): void {
    const now = new Date();
    lastStatuses = r.statuses;
    idleFooter = statusLine(r.statuses, now);
    const next = r.statuses
      .filter((s: Status) => s.state === "armed" && s.nextFire)
      .sort(
        (a: Status, b: Status) =>
          Date.parse(a.nextFire as string) - Date.parse(b.nextFire as string),
      )[0];
    nextHintText = next
      ? `next ${new Date(next.nextFire as string).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${next.name}`
      : undefined;
  }

  function automationHasFlowBlock(dir: string): boolean {
    try {
      const block = findFlowBlock(readFileSync(path.join(dir, "AUTOMATION.md"), "utf8"));
      return block !== null && block.text.trim() !== "";
    } catch {
      return false;
    }
  }

  function emit(ctx: ExtensionContext, lines: string[]): void {
    if (lines.length === 0) return;
    // Print mode has no UI, so output goes to stdout.
    if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    else process.stdout.write(`${lines.join("\n")}\n`);
  }

  /** The model resolver for a listing, or undefined. Guarded because an older dist may lack it. */
  async function safeResolver() {
    try {
      return await createPiServices().modelResolver();
    } catch {
      return undefined;
    }
  }

  async function runtimeOpt(): Promise<Pick<CommandDeps, "resolveModel">> {
    const resolveModel = await safeResolver();
    return resolveModel ? { resolveModel } : {};
  }
}
