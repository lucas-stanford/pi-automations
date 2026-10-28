// A scrollable pane for consent, `log` and `check`; consent logic stays elsewhere.

import { bodyRows, type Hint, pageRows, renderPage } from "./page.js";
import { type LineTheme, PLAIN_THEME, strong } from "./theme.js";
import type { RenderHost, WindowComponent } from "./window.js";
import { wrapHanging } from "./width.js";

export interface PagerKey {
  /** Matched against the raw key data. */
  keys: string[];
  /** Shown in the footer. */
  hint: string;
  /** What the pager resolves with. */
  value?: boolean;
  /** Called instead of resolving. */
  run?: () => void;
}

export interface PagerHost {
  tui: RenderHost;
  theme?: LineTheme;
  title: string;
  /** Already styled; shown on the right of line 1. */
  right?: string;
  lines: string[];
  /** Footer hints and the keys that produce a result. */
  actions: PagerKey[];
  // What any other key does. Explicit, because for consent every key that is not `y` must mean no.
  otherwise: "ignore" | "reject";
  resolve(value: boolean): void;
  /** Visible rows for the body when the terminal's height is unknown. Defaults to 20. */
  pageSize?: number;
}

/** A scrollable page that wraps rather than truncates: a cut command is a different command. */
export function createPager(host: PagerHost): WindowComponent {
  const theme = host.theme ?? PLAIN_THEME;
  let offset = 0;
  let disposed = false;
  let lastWidth = 80;

  function requestRender(): void {
    if (disposed) return;
    try {
      host.tui.requestRender();
    } catch {
      disposed = true;
    }
  }

  function wrapped(width: number): string[] {
    return host.lines.flatMap((l) => wrapHanging(l, width));
  }

  function pageSize(): number {
    const rows = pageRows(host.tui);
    return rows === undefined ? Math.max(3, host.pageSize ?? 20) : bodyRows(rows);
  }

  function scroll(delta: number, width: number): void {
    const total = wrapped(width).length;
    const max = Math.max(0, total - pageSize());
    const next = Math.min(max, Math.max(0, offset + delta));
    if (next === offset) return;
    offset = next;
    requestRender();
  }

  return {
    render(width: number): string[] {
      lastWidth = width;
      const body = wrapped(width);
      const size = pageSize();
      offset = Math.min(offset, Math.max(0, body.length - size));
      const view = body.slice(offset, offset + size);
      const more = body.length - (offset + view.length);
      const hints: Hint[] =
        more > 0 || offset > 0 ? [{ text: `↑↓ scroll · rows ${offset + 1}-${offset + view.length} of ${body.length}`, rank: 1 }] : [];
      return renderPage(
        { title: strong(theme, host.title), ...(host.right ? { right: host.right } : {}), body: view, hints, pinned: host.actions.map((a) => a.hint) },
        width,
        pageRows(host.tui),
        theme,
      );
    },

    handleInput(data: string): void {
      if (data === "\u001b[A" || data === "\u001bOA") return scroll(-1, lastWidth);
      if (data === "\u001b[B" || data === "\u001bOB") return scroll(1, lastWidth);
      if (data === "\u001b[5~") return scroll(-pageSize(), lastWidth);
      if (data === "\u001b[6~") return scroll(pageSize(), lastWidth);
      if (data === "\u001b[H" || data === "\u001b[1~") return scroll(-1e9, lastWidth);
      if (data === "\u001b[F" || data === "\u001b[4~") return scroll(1e9, lastWidth);

      for (const a of host.actions) {
        if (!a.keys.includes(data)) continue;
        if (a.run) return a.run();
        if (a.value !== undefined) return host.resolve(a.value);
      }

      // Anything else. For consent this is the whole safety property.
      if (host.otherwise === "reject") host.resolve(false);
    },

    invalidate(): void {
      requestRender();
    },

    dispose(): void {
      disposed = true;
    },
  };
}

/** The consent overlay's keys: `y` arms; every other key keeps it off. */
export function consentActions(): PagerKey[] {
  return [
    { keys: ["y", "Y"], hint: "y arm", value: true },
    { keys: ["n", "N", "\u001b"], hint: "n / esc keep off", value: false },
  ];
}

/** Read-only pages only ever close. */
export function readerActions(onEnter?: () => void): PagerKey[] {
  const out: PagerKey[] = [];
  if (onEnter) out.push({ keys: ["\r", "\n"], hint: "enter record", run: onEnter });
  out.push({ keys: ["\u001b", "q"], hint: "esc back", value: false });
  return out;
}
