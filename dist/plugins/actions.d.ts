import type { Status } from "../types.js";
import { type EditorChoice } from "./editor.js";
import type { LoadedPlugins } from "./loader.js";
import type { ActionTarget } from "./types.js";
export interface ActionOutcome {
    lines: string[];
    exitCode?: number;
    /** A plugin keeps serving after its action returned: `pa` stays in the foreground. */
    keepAlive?: boolean;
    url?: string;
}
export declare function actionTarget(s: Pick<Status, "key" | "name" | "scope" | "dir">): ActionTarget;
/** What `e` does here, in the words of the list's menu. */
export declare function editLabel(plugins: LoadedPlugins): {
    label: string;
    why: string;
};
export declare function runAction(args: {
    id: string;
    plugins: LoadedPlugins;
    status?: Pick<Status, "key" | "name" | "scope" | "dir">;
    where: "cli" | "host";
    open?: boolean;
    /** Tests choose the editor; everyone else gets `chooseEditor`. */
    editor?: (file: string) => EditorChoice;
    openEditor?: (choice: EditorChoice, file: string) => Promise<string | undefined>;
}): Promise<ActionOutcome>;
