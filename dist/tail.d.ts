export interface TailState {
    /** Bytes consumed so far. */
    offset: number;
    /** Bytes after the last newline, waiting for the rest of their line. */
    partial: string;
    /** Size at the last read, to notice a file that was replaced. */
    size: number;
}
export declare function newTail(): TailState;
export interface TailResult {
    /** Complete lines that arrived since the last read, newline-separated. */
    text: string;
    /** True when the file was replaced or truncated and reading started over. */
    restarted: boolean;
    /** True when there is a file and it has bytes. */
    present: boolean;
}
/** Read whatever is new, as complete lines. Never throws. */
export declare function readTail(file: string, state: TailState): TailResult;
