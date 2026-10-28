/** Where a run's live view lives. Beside the locks, because it has the same lifetime. */
export declare function liveFile(dir: string, key: string): string;
/** How often streaming text is flushed: often enough to read as live, rarely enough to be free. */
export declare const PARTIAL_MS = 1000;
export declare class LiveWriter {
    private readonly file;
    private lastPartialAt;
    private lastPartial;
    private closed;
    constructor(file: string);
    private write;
    /** Text still arriving: throttled, marked `partial`, and skipped when unchanged. */
    partial(text: string, now?: number): void;
    /** A tool call, as it starts — the most useful single signal that something is happening. */
    tool(name: string, args: unknown, now?: number): void;
    /** Reasoning still arriving, so a thinking model does not look like an empty pane. */
    thinking(text: string, now?: number): void;
    /** A completed assistant message — the settled version of whatever the partials were drafting. */
    message(message: unknown, now?: number): void;
    /** The run is over: remove the file so a finished run never looks live. */
    close(): void;
}
