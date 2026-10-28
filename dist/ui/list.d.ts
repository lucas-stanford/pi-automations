import type { ListingModel, Row } from "../listing.js";
import type { Config, RunRecord, Status } from "../types.js";
import { type DetailsData, type WatcherFacts } from "./details.js";
import { type RunView } from "./run-view.js";
import { type LineTheme, type UiColor } from "./theme.js";
import type { RenderHost, WindowComponent } from "./window.js";
export type ListAction = "run" | "run-flow" | "stop" | "arm" | "arm-and-run" | "disarm" | "enable" | "disable" | "toggle" | "edit" | "log" | "check" | "window" | "pause-watch" | "resume-watch" | "dismiss-run" | `plugin:${string}`;
export type GlobalAction = "watcher-start" | "watcher-stop";
export interface ListAffordance {
    action: ListAction;
    label: string;
    /** The key that does the same from the list, shown beside it on the automation's page. */
    key?: string;
    why?: string;
}
/** What a person may do to this automation right now, derived from its state. */
export declare function actionsFor(status: Status): ListAffordance[];
export interface ListExtras {
    edit: {
        label: string;
        why: string;
    };
    actions: {
        id: string;
        label: string;
        key?: string;
        why?: string;
    }[];
}
/** The automation page's actions: its own, with edit before check and plugins after it. */
export declare function menuFor(status: Status, extras?: ListExtras): ListAffordance[];
export interface ListHeaderFacts {
    counts: {
        armed: number;
        off: number;
        disabled: number;
        invalid: number;
    };
    running: number;
    watcher?: WatcherFacts;
}
/** The pseudo-key of the watcher's card. Never a real automation key, which always has a scope. */
export declare const WATCHER_KEY = "watcher";
export type SectionId = "needs" | "running" | "coming" | "watching" | "off";
export declare const SECTION_TITLE: Record<SectionId, string>;
export type EntryKind = "watcher" | "invalid" | "failed" | "watch" | "consent" | "running"
/** Coming up: on its schedule, held by the watcher, or by hand only. */
 | "coming" | "hold" | "manual"
/** Watching: a watch with no schedule, checking, paused, or held by the watcher. */
 | "watched" | "paused"
/** Off and disabled: disabled, or an automation nobody has armed yet. */
 | "off" | "not-armed";
export interface InboxEntry {
    key: string;
    status?: Status;
    section: SectionId;
    kind: EntryKind;
    name: string;
}
export interface Triage {
    sections: {
        id: SectionId;
        title: string;
        items: InboxEntry[];
    }[];
    needs: number;
    running: number;
    paused: number;
    /** Armed automations that only run on their own while the watcher is on. */
    dependents: Status[];
}
export interface Cell {
    text: string;
    color?: UiColor;
}
type RecordsData = DetailsData & {
    records?: RunRecord[];
    dismissedRunId?: string;
};
/** Sort every automation into its section, the watcher first when it needs you. */
export declare function triage(data: ListData, now: Date, _opts?: {
    canControlWatcher?: boolean;
}): Triage;
export interface RunStepNow {
    label: string;
    note?: string;
}
/** A card: what happened, why, the one key, and when it runs again on its own. */
export interface Card {
    glyph: Cell;
    name: string;
    rest: string;
    why?: Cell;
    /** A dim line about earlier runs: `2 of the last 7 runs failed · l shows them`. */
    pattern?: string;
    /** Absent when nothing here can fix it; `does` then says where it is fixed. */
    key?: string;
    does: string;
    /** `it runs again on its own today 22:00`, then shorter ways to say it for a narrow terminal. */
    leave?: string[];
}
export interface CardOptions {
    canControl?: boolean;
    step?: RunStepNow;
}
export declare function cardFor(entry: InboxEntry, data: ListData, now: Date, opts?: CardOptions): Card;
export interface AgendaRow {
    when?: Cell;
    last?: Cell;
    note?: Cell;
}
export declare function agendaRow(entry: InboxEntry, now: Date): AgendaRow;
/** The sentence an automation's page opens with, in its state's colour. */
export declare function automationLead(s: Status, data: Pick<ListData, "details" | "facts">, now: Date): Cell;
/** Line 1: `Automations` and the watcher state on the right. */
export declare function headerLines(facts: ListHeaderFacts, width: number, theme?: LineTheme, now?: Date): string[];
export interface ListData {
    model: ListingModel;
    facts: ListHeaderFacts;
    details?: Record<string, RecordsData>;
    config?: Config;
    home?: string;
    now?: Date;
    /** Absent: `e` opens AUTOMATION.md in an editor and no plugin adds anything. */
    extras?: ListExtras;
    steps?: Record<string, RunStepNow>;
}
/** The runs going on in this host, for a page that should notice one start or end. */
export interface ListRuns {
    running(): string[];
    step?(key: string): RunStepNow | undefined;
    subscribe(listener: () => void): () => void;
}
/** The part of the run registry the page reads. Structural, so this module needs no registry. */
export interface RunsSource {
    all(): {
        view: RunView;
    }[];
    subscribe(listener: () => void): () => void;
}
/** The registry as the page sees it: what runs, and the deepest step each is on. */
export declare function listRunsFrom(registry: RunsSource): ListRuns;
export interface ListHost {
    tui: RenderHost;
    theme?: LineTheme;
    close(): void;
    reload(opts?: {
        background?: boolean;
    }): Promise<ListData>;
    act(action: ListAction, status: Status): Promise<ListFlash | void> | ListFlash | void;
    /** Start or stop the watcher. Absent where the host cannot, and then `w` says so. */
    actGlobal?(action: GlobalAction): Promise<ListFlash | void> | ListFlash | void;
    /** The clock the page's times are read from. Ticks redraw times but never re-sort. */
    now?: () => Date;
    runs?: ListRuns;
    tickMs?: number;
    /**
     * Re-read everything this often, so an open page keeps up with what other processes do: runs
     * the watcher fires, watch checks, new records and messages. Absent: only runs in this process.
     */
    refreshMs?: number;
}
export interface ListFlash {
    message: string;
    tone: "success" | "info" | "warning" | "error";
}
export declare function createListScreen(host: ListHost, initial: ListData): WindowComponent;
export declare function actionForToggle(status: Status): ListAction | undefined;
export type { Row };
