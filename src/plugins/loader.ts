// Loading plugins from the person's config only, each bounded; a failure is a warning.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BUNDLED_PLUGINS } from "../config.js";
import { oneLine } from "../errors.js";
import { packageDir } from "../paths.js";
import type {
  ActionContext,
  ActionResult,
  ChartRenderRequest,
  HostServices,
  PiAutomationsPlugin,
  PluginAction,
  PluginApi,
  PluginEventName,
  PluginEvents,
  PluginRenderer,
  PluginWhere,
} from "./types.js";

/** How long any one call into a plugin may take. */
export const PLUGIN_CALL_MS = 5000;

/** Verbs a plugin action may not take over: `pa run` is always this package's `run`. */
export const RESERVED_VERBS: ReadonlySet<string> = new Set([
  "list", "run", "running", "arm", "disarm", "enable", "disable", "log", "runs", "check", "watch",
  "report", "watcher", "detached", "help", "tick", "fire", "serve", "step", "next", "say", "note", "message",
  "status", "stop",
]);

type Handler<E extends PluginEventName> = (event: PluginEvents[E]) => void | Promise<void>;

export interface RegisteredAction {
  plugin: string;
  action: PluginAction;
}

/** The events a run reports to its observers. */
export type RunEventName = Exclude<PluginEventName, "shutdown">;

/** Who is told about a run; `problems` are load failures for the record. */
export interface RunObservers {
  readonly observing: boolean;
  readonly problems: readonly string[];
  emit<E extends RunEventName>(event: E, payload: PluginEvents[E]): Promise<string[]>;
}

export interface LoadedPlugins extends RunObservers {
  /** `name (entry)` of each plugin that loaded. */
  readonly loaded: readonly { entry: string; name: string }[];
  /** Everything worth telling the person: load failures, refused registrations, `api.warn`. */
  readonly warnings: readonly string[];
  readonly actions: readonly RegisteredAction[];
  action(id: string): RegisteredAction | undefined;
  readonly renderer: { plugin: string; render: PluginRenderer } | undefined;
  /** Run an action, bounded. A failure or a timeout is a `problem` to show, never a throw. */
  runAction(id: string, ctx: ActionContext): Promise<{ result?: ActionResult; problem?: string }>;
  /** Tell every plugin the process is letting it go. Bounded. */
  shutdown(): Promise<void>;
}

export interface LoadPluginsOptions {
  entries: readonly string[];
  where: PluginWhere;
  /** Built on first use, so a plugin that never asks costs nothing. */
  host: () => HostServices;
  timeoutMs?: number;
  home?: string;
  /** Where `manager` and any other bundled name resolve. Defaults to this package. */
  packageRoot?: string;
}

/** The module file a `plugins` entry names. */
export function resolvePluginEntry(entry: string, opts: { home?: string; packageRoot?: string } = {}): string {
  if ((BUNDLED_PLUGINS as readonly string[]).includes(entry)) {
    return path.join(opts.packageRoot ?? packageDir(), "packages", entry, "plugin", "index.js");
  }
  const expanded = entry.startsWith("~/") || entry.startsWith("~\\") ? path.join(opts.home ?? homedir(), entry.slice(2)) : entry;
  const file = path.resolve(expanded);
  try {
    if (statSync(file).isDirectory()) return path.join(file, "index.js");
  } catch {
    // Reported when it is imported.
  }
  return file;
}

/** `p`, or a rejection once `ms` have passed. The timer never holds the process open. */
export function bounded<T>(p: Promise<T> | T, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(oneLine(e)));
      },
    );
  });
}

function pluginOf(mod: unknown): PiAutomationsPlugin | undefined {
  const d = (mod as { default?: unknown })?.default;
  if (typeof d === "function") return { name: d.name || "plugin", setup: d as PiAutomationsPlugin["setup"] };
  if (d && typeof d === "object" && typeof (d as PiAutomationsPlugin).setup === "function") {
    const p = d as PiAutomationsPlugin;
    return { name: typeof p.name === "string" && p.name.trim() ? p.name : "plugin", setup: p.setup.bind(p) };
  }
  return undefined;
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadedPlugins> {
  const ms = opts.timeoutMs ?? PLUGIN_CALL_MS;
  const warnings: string[] = [];
  const loaded: { entry: string; name: string }[] = [];
  const actions: RegisteredAction[] = [];
  const handlers: { plugin: string; event: PluginEventName; handler: Handler<PluginEventName> }[] = [];
  let renderer: LoadedPlugins["renderer"];
  let host: HostServices | undefined;

  for (const entry of opts.entries) {
    const file = resolvePluginEntry(entry, { ...(opts.home ? { home: opts.home } : {}), ...(opts.packageRoot ? { packageRoot: opts.packageRoot } : {}) });
    if (!existsSync(file)) {
      warnings.push(`plugin ${entry}: ${file} does not exist — not loaded`);
      continue;
    }
    let plugin: PiAutomationsPlugin | undefined;
    try {
      plugin = pluginOf(await bounded(import(pathToFileURL(file).href), ms, "loading it"));
    } catch (e) {
      warnings.push(`plugin ${entry}: ${oneLine(e)} — not loaded`);
      continue;
    }
    if (!plugin) {
      warnings.push(`plugin ${entry}: it exports no plugin (a default { name, setup } or setup function) — not loaded`);
      continue;
    }

    const name = plugin.name;
    // Registrations are kept only if setup finishes, so a plugin that fails halfway leaves nothing.
    const staged = { open: true, actions: [] as PluginAction[], handlers: [] as typeof handlers, renderer: undefined as PluginRenderer | undefined };
    const api: PluginApi = {
      apiVersion: 1,
      where: opts.where,
      entry,
      get host() {
        host ??= opts.host();
        return host;
      },
      on(event, handler) {
        if (!staged.open || typeof handler !== "function") return;
        staged.handlers.push({ plugin: name, event, handler: handler as Handler<PluginEventName> });
      },
      addAction(action) {
        if (!staged.open) return;
        staged.actions.push(action);
      },
      setRenderer(render) {
        if (!staged.open || typeof render !== "function") return;
        staged.renderer = render;
      },
      warn(message) {
        warnings.push(`plugin ${name}: ${oneLine(message)}`);
      },
    };
    try {
      await bounded(plugin.setup(api), ms, "its setup");
    } catch (e) {
      staged.open = false;
      warnings.push(`plugin ${name}: ${oneLine(e)} — not loaded`);
      continue;
    }
    staged.open = false;

    for (const action of staged.actions) {
      const id = typeof action?.id === "string" ? action.id : "";
      if (!/^[a-z][a-z0-9-]*$/.test(id) || typeof action.run !== "function" || typeof action.label !== "string") {
        warnings.push(`plugin ${name}: action ${JSON.stringify(id)} needs an id like "open-dashboard", a label and run() — ignored`);
      } else if (RESERVED_VERBS.has(id)) {
        warnings.push(`plugin ${name}: action "${id}" is a pa command already — ignored`);
      } else if (actions.some((a) => a.action.id === id)) {
        warnings.push(`plugin ${name}: action "${id}" is already added by ${actions.find((a) => a.action.id === id)?.plugin} — ignored`);
      } else {
        actions.push({ plugin: name, action });
      }
    }
    handlers.push(...staged.handlers);
    if (staged.renderer) {
      if (renderer) warnings.push(`plugin ${name}: ${renderer.plugin} already draws charts — its renderer is ignored`);
      else renderer = { plugin: name, render: staged.renderer };
    }
    loaded.push({ entry, name });
  }

  async function emitTo<E extends PluginEventName>(event: E, payload: PluginEvents[E]): Promise<string[]> {
    const mine = handlers.filter((h) => h.event === event);
    const results = await Promise.all(
      mine.map(async (h) => {
        try {
          await bounded(h.handler(payload as PluginEvents[PluginEventName]), ms, `its ${event} observer`);
          return undefined;
        } catch (e) {
          return `plugin ${h.plugin}: ${oneLine(e)}`;
        }
      }),
    );
    return results.filter((r): r is string => r !== undefined);
  }

  return {
    loaded,
    warnings,
    actions,
    problems: warnings,
    observing: handlers.some((h) => h.event !== "shutdown"),
    renderer,
    action: (id) => actions.find((a) => a.action.id === id),
    emit: (event, payload) => emitTo(event, payload),
    async runAction(id, ctx) {
      const found = actions.find((a) => a.action.id === id);
      if (!found) return { problem: `no plugin adds ${id}` };
      try {
        const result = await bounded(found.action.run(ctx), ms, `its ${id} action`);
        return result && typeof result === "object" ? { result } : {};
      } catch (e) {
        return { problem: `${found.plugin}: ${oneLine(e)}` };
      }
    },
    async shutdown() {
      await emitTo("shutdown", undefined);
    },
  };
}

/** The plugin renderer's chart, or undefined for fm. A slow renderer is dropped for the process. */
export function pluginChartRenderer(
  current: () => LoadedPlugins["renderer"],
  onProblem: (message: string) => void,
  ms: number = PLUGIN_CALL_MS,
): (args: { plan: string; state: ChartRenderRequest["state"]; format: "text" | "svg" }) => { text: string } | undefined {
  let dropped = false;
  let reported = false;
  return (args) => {
    const r = current();
    if (!r || dropped) return undefined;
    const started = Date.now();
    let drawn: { text: string } | { problem: string };
    try {
      drawn = r.render({ chart: args.plan, state: args.state, format: args.format, timeoutMs: ms });
    } catch (e) {
      drawn = { problem: oneLine(e) };
    }
    if (Date.now() - started > ms) {
      dropped = true;
      onProblem(`plugin ${r.plugin}: its renderer took ${Date.now() - started}ms — charts are drawn without it now`);
      return undefined;
    }
    if (drawn && "text" in drawn && typeof drawn.text === "string") return { text: drawn.text };
    if (!reported) {
      reported = true;
      onProblem(`plugin ${r.plugin}: its renderer ${drawn && "problem" in drawn ? `failed: ${drawn.problem}` : "returned nothing"} — that chart is drawn without it`);
    }
    return undefined;
  };
}

/** No plugins: what every caller gets when `plugins` is not set. */
export const NO_PLUGINS: LoadedPlugins = {
  loaded: [],
  warnings: [],
  actions: [],
  problems: [],
  observing: false,
  renderer: undefined,
  action: () => undefined,
  emit: async () => [],
  runAction: async (id) => ({ problem: `no plugin adds ${id}` }),
  shutdown: async () => {},
};
