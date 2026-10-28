// Watching runs: the registry subscription and repaint timers, behind one dispose.

import type { RunRegistry } from "../../ui/registry.js";

export interface RunObserverOptions {
  readonly registry: RunRegistry;
  /** Repaint the footer. Called on every change and on the footer's own tick. */
  paintFooter(): void;
  /** Repaint the strip above the editor; `tick` advances its animation. */
  paintWidget(tick: number): void;
  /** Re-read what the observed runs are doing. Failures here are never fatal. */
  poll(): void;
  /** Injected only so a test can drive time without waiting for it. */
  readonly clock?: {
    setInterval: (fn: () => void, ms: number) => { unref?: () => void };
    clearInterval: (handle: unknown) => void;
  };
}

export interface RunObserver {
  /** Subscribe and bring the timers into line with what is running. */
  start(): void;
  /** Bring the timers into line after something changed outside the subscription. */
  sync(): void;
  /** Which timers are armed. For tests, and for asserting that disposal left none. */
  readonly armed: { footer: boolean; widget: boolean; poll: boolean };
  readonly subscribed: boolean;
  /** Stop observing. Idempotent, and it touches no run. */
  dispose(): void;
}

const DEFAULTS = { footerMs: 1000, widgetMs: 80, pollMs: 1000 };

export function createRunObserver(options: RunObserverOptions): RunObserver {
  const timings = DEFAULTS;
  const clock = options.clock ?? {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  let footer: unknown;
  let widget: unknown;
  let poll: unknown;
  let unsubscribe: (() => void) | undefined;
  let widgetTick = 0;
  let disposed = false;

  const arm = (
    current: unknown,
    wanted: boolean,
    fn: () => void,
    ms: number,
  ): unknown => {
    if (wanted && !current) {
      const handle = clock.setInterval(fn, ms);
      handle.unref?.();
      return handle;
    }
    if (!wanted && current) {
      clock.clearInterval(current);
      return undefined;
    }
    return current;
  };

  function sync(): void {
    if (disposed) return;
    const running = options.registry.running().length > 0;
    footer = arm(footer, running, () => options.paintFooter(), timings.footerMs);
    widget = arm(
      widget,
      running,
      () => {
        widgetTick++;
        options.paintWidget(widgetTick);
      },
      timings.widgetMs,
    );
    poll = arm(
      poll,
      running,
      () => {
        try {
          options.poll();
        } catch {
          // A poll that fails must never take the session down.
        }
      },
      timings.pollMs,
    );
  }

  return {
    start() {
      if (disposed || unsubscribe) return;
      unsubscribe = options.registry.subscribe(() => {
        sync();
        options.paintFooter();
        options.paintWidget(widgetTick);
      });
      sync();
    },

    sync,

    get armed() {
      return { footer: footer !== undefined, widget: widget !== undefined, poll: poll !== undefined };
    },

    get subscribed() {
      return unsubscribe !== undefined;
    },

    dispose() {
      disposed = true;
      for (const handle of [footer, widget, poll]) {
        if (handle !== undefined) clock.clearInterval(handle);
      }
      footer = undefined;
      widget = undefined;
      poll = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
