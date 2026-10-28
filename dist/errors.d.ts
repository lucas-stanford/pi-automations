/** Every user-facing error is one line: `<field path>: <what is wrong> — <what fixes it>`. */
export declare class AutomationError extends Error {
    readonly field: string;
    readonly fix: string;
    /** When one check finds several things wrong (a strict flow), each as its own line. */
    readonly problems?: readonly string[];
    constructor(field: string, fix: string, problems?: readonly string[]);
}
/** A model that cannot be resolved. Same one-line shape; a distinct type so callers can branch. */
export declare class ModelError extends AutomationError {
    constructor(field: string, fix: string);
}
/** Collapse anything throwable into a single line fit for a listing or a run record. */
export declare function oneLine(e: unknown): string;
