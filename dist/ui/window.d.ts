import { type RunView } from "./run-view.js";
import type { RunRegistry } from "./registry.js";
import { type LineTheme } from "./theme.js";
/** The one thing the window needs from pi's TUI. */
export interface RenderHost {
    requestRender(force?: boolean): void;
    /** Present in pi; optional for pure hosts. */
    terminal?: {
        readonly rows: number;
    };
}
/** pi's `Component`, structurally. Declared here so `src/` never imports pi-tui. */
export interface WindowComponent {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    dispose(): void;
}
export interface StatusWindowHost {
    registry: RunRegistry;
    tui: RenderHost;
    theme?: LineTheme;
    now: () => Date;
    /** Closes the overlay. This is `done` from `ctx.ui.custom`'s factory. */
    close: () => void;
    /** `l` on a row. */
    onLog?: (view: RunView) => void;
    /** `e` — open this automation in the browser editor. */
    onEditAutomation?: (view: RunView) => void;
    flowView?: (view: RunView, width: number) => FlowPane | undefined;
    /** The run's session as lines for the `s` view. The caller owns tailing and parsing. */
    sessionView?: (view: RunView, width: number) => string[] | undefined;
    /** `x` on a running row asks this run to stop. The run's own process ends itself and records. */
    onStop?: (view: RunView) => void;
    /** Shown in the empty state, e.g. `next 07:00 daily-briefing`. */
    nextHint?: () => string | undefined;
    /** Open straight onto this automation's flowchart. */
    openGraphFor?: string;
    /** Open straight onto this automation's run page: `s` on a running row of the list. */
    openRunFor?: string;
    /** Spinner period. Injected so a test does not have to wait 80 ms per frame. */
    spinnerMs?: number;
    usual?: (key: string) => number | undefined;
}
/** What can be shown of a run's chart, already fitted to the pane. */
export interface FlowPane {
    kind: "graph" | "list" | "none";
    lines: string[];
}
export declare function createStatusWindow(host: StatusWindowHost): WindowComponent;
