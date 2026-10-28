export type EditorChoice = {
    kind: "command";
    command: string;
} | {
    kind: "code";
    bin: string;
} | {
    kind: "opener";
    file: string;
    args: string[];
};
export declare function chooseEditor(args: {
    file: string;
    /** `cli`: `pa edit` in a shell. `host`: inside pi. */
    where: "cli" | "host";
    env?: NodeJS.ProcessEnv;
    which?: (bin: string) => string | undefined;
    platform?: NodeJS.Platform;
}): EditorChoice;
/** How the choice is said to the person: `opened daily in $EDITOR (vim)`. */
export declare function describeEditor(choice: EditorChoice): string;
/** Why `file` cannot go through cmd: `%NAME%` expands and `"` ends quoting. */
export declare function unsafeForShell(file: string, platform: NodeJS.Platform): string | undefined;
/** Open `file`; a terminal editor is waited for. Resolves with a reason when it cannot. */
export declare function openInEditor(choice: EditorChoice, file: string, platform?: NodeJS.Platform): Promise<string | undefined>;
