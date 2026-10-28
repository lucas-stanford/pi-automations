/** A Pi host that exists only in this process. */

import type { WindowComponent } from "../../src/ui/window.js";

export type PiMode = "tui" | "print" | "json" | "rpc";

export interface RecordedEntry {
  type: string;
  data: unknown;
}

export interface FakePi {
  /** Passed straight to the extension's default export. */
  api: Record<string, unknown>;
  commands: Map<string, Record<string, unknown>>;
  shortcuts: Map<string, Record<string, unknown>>;
  events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  renderers: Map<string, unknown>;
  entries: RecordedEntry[];
  /** Conversation APIs the extension must NEVER reach. */
  conversationCalls: string[];
  /** Deliver an event to every handler registered for it. */
  emit(event: string, payload: unknown, ctx: unknown): Promise<void>;
  /** Invoke a registered command exactly as Pi would. */
  run(command: string, args: string, ctx: unknown): Promise<void>;
  /** Invoke a registered shortcut exactly as Pi would. */
  press(id: string, ctx: unknown): Promise<void>;
}

export function createFakePi(): FakePi {
  const commands = new Map<string, Record<string, unknown>>();
  const shortcuts = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const renderers = new Map<string, unknown>();
  const entries: RecordedEntry[] = [];
  const conversationCalls: string[] = [];

  const conversationTrap =
    (name: string) =>
    (...args: unknown[]) => {
      conversationCalls.push(`${name}(${args.map((a) => typeof a).join(",")})`);
    };

  const api = {
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      const list = events.get(event) ?? [];
      list.push(handler);
      events.set(event, list);
    },
    registerCommand(name: string, options: Record<string, unknown>) {
      commands.set(name, options);
    },
    registerShortcut(id: string, options: Record<string, unknown>) {
      shortcuts.set(id, options);
    },
    registerEntryRenderer(type: string, renderer: unknown) {
      renderers.set(type, renderer);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    registerTool: conversationTrap("registerTool"),
    sendMessage: conversationTrap("sendMessage"),
    sendUserMessage: conversationTrap("sendUserMessage"),
  };

  return {
    api,
    commands,
    shortcuts,
    events,
    renderers,
    entries,
    conversationCalls,
    async emit(event, payload, ctx) {
      for (const h of events.get(event) ?? []) await h(payload, ctx);
    },
    async run(command, args, ctx) {
      const cmd = commands.get(command);
      if (!cmd) throw new Error(`no command registered as ${command}`);
      await (cmd.handler as (a: string, c: unknown) => Promise<void>)(args, ctx);
    },
    async press(id, ctx) {
      const sc = shortcuts.get(id);
      if (!sc) throw new Error(`no shortcut registered as ${id}`);
      await (sc.handler as (c: unknown) => Promise<void>)(ctx);
    },
  };
}

export interface FakeContextOptions {
  mode: PiMode;
  cwd: string;
  /** Defaults to true for `tui` and `rpc`, false for `print` and `json` — Pi's own split. */
  hasUI?: boolean;
  /** What `ctx.ui.confirm` answers. */
  confirm?: boolean;
  /** Keys fed to whatever component `ctx.ui.custom` builds, in order. */
  keys?: string[];
  /** Make `ctx.ui.custom` reject, so the prompt-error path is exercised. */
  customThrows?: boolean;
  /** Make every UI call throw, as a context belonging to a dead session does. */
  uiDead?: boolean;
  width?: number;
  height?: number;
}

export interface FakeContext {
  ctx: Record<string, unknown>;
  notifications: Array<{ text: string; level?: string }>;
  /** Pi's `setStatus(key, value)` — both arguments, because clearing passes `undefined`. */
  statuses: Array<{ key: string; value: unknown }>;
  widgets: Array<{ key: string; value: unknown }>;
  confirms: Array<{ title: string; body: string }>;
  /** One entry per `ctx.ui.custom` call, with the keys it actually consumed. */
  customCalls: Array<{ consumed: string[]; resolved: unknown; maxHeights: unknown[]; overlays: unknown[]; frames: string[][] }>;
  stdout: string[];
}

/**
 * A context for one Pi session, in one mode.
 *
 * `ui.custom` really builds the component the extension asked for and really feeds it keys, so a
 * consent overlay is accepted or refused by the same code path a person drives.
 */
export function createFakeContext(opts: FakeContextOptions): FakeContext {
  const notifications: Array<{ text: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const widgets: Array<{ key: string; value: unknown }> = [];
  const confirms: Array<{ title: string; body: string }> = [];
  const customCalls: Array<{ consumed: string[]; resolved: unknown; maxHeights: unknown[]; overlays: unknown[]; frames: string[][] }> = [];
  const stdout: string[] = [];

  const hasUI = opts.hasUI ?? (opts.mode === "tui" || opts.mode === "rpc");
  const width = opts.width ?? 80;
  const height = opts.height ?? 40;
  const dead = () => {
    if (opts.uiDead) throw new Error("this context belongs to a session that has ended");
  };

  const ui = {
    notify(text: string, level?: string) {
      dead();
      notifications.push({ text, ...(level ? { level } : {}) });
    },
    setStatus(key: string, value: unknown) {
      dead();
      statuses.push({ key, value });
    },
    setWidget(key: string, value: unknown) {
      dead();
      widgets.push({ key, value });
    },
    async confirm(title: string, body: string) {
      dead();
      confirms.push({ title, body });
      return opts.confirm ?? false;
    },
    custom<T>(
      factory: (
        tui: { requestRender(force?: boolean): void },
        theme: { fg(color: string, text: string): string },
        keybindings: Record<string, unknown>,
        done: (value: T) => void,
      ) => WindowComponent,
      options?: {
        overlayOptions?: { maxHeight?: unknown } | (() => { maxHeight?: unknown });
      },
    ): Promise<T> {
      dead();
      if (opts.customThrows) return Promise.reject(new Error("the prompt could not be shown"));

      return new Promise<T>((resolve) => {
        const consumed: string[] = [];
        const maxHeights: unknown[] = [];
        const overlays: unknown[] = [];
        const frames: string[][] = [];
        const captureHeight = () => {
          const overlay =
            typeof options?.overlayOptions === "function"
              ? options.overlayOptions()
              : options?.overlayOptions;
          maxHeights.push(overlay?.maxHeight);
          overlays.push(overlay);
        };
        let settled = false;
        const done = (value: T) => {
          if (settled) return;
          settled = true;
          customCalls.push({ consumed: [...consumed], resolved: value, maxHeights, overlays, frames });
          try {
            component.dispose();
          } catch {
            // A component that will not close cleanly is not what this harness is measuring.
          }
          resolve(value);
        };

        const component = factory(
          { requestRender: captureHeight, terminal: { rows: height } },
          { fg: (_c, text) => text },
          {},
          done,
        );

        // Render once, so a component that throws while drawing fails here rather than silently.
        captureHeight();
        frames.push(component.render(width));

        for (const key of opts.keys ?? []) {
          if (settled) break;
          consumed.push(key);
          component.handleInput(key);
          if (!settled) frames.push(component.render(width));
        }

        if (!settled) {
          // The overlay is still open. That is a real state — `otherwise: "ignore"` keeps a reader
          // open — so record it and close with undefined rather than hanging the test.
          customCalls.push({ consumed: [...consumed], resolved: undefined, maxHeights, overlays, frames });
          settled = true;
          try {
            component.dispose();
          } catch {
            // As above.
          }
          resolve(undefined as T);
        }
      });
    },
  };

  return {
    ctx: { mode: opts.mode, hasUI, cwd: opts.cwd, ui },
    notifications,
    statuses,
    widgets,
    confirms,
    customCalls,
    stdout,
  };
}

/** Everything the notifications say, joined, for a readable assertion. */
export function saidBy(c: FakeContext): string {
  return c.notifications.map((n) => n.text).join("\n");
}

/**
 * Run `fn` with `process.stdout.write` captured.
 *
 * `print` and `json` modes write their answer to stdout by design, so a test that drives them
 * either asserts on what was written or drowns the runner's output in listings.
 */
export async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return written.join("");
}
