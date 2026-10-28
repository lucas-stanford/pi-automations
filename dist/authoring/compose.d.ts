import type { Automation } from "../types.js";
import type { AutomationFields, HostError, HostErrorCode, Problem } from "../plugins/types.js";
export declare const AUTOMATION_FILE = "AUTOMATION.md";
/** The chart's older home, beside AUTOMATION.md. Read as a fallback; never written. */
export declare const FLOW_FILE = "flow.mmd";
/** The largest file read or written as text. */
export declare const MAX_FILE_BYTES = 1048576;
/** Folders the file browser never enters. They hold run state, dependencies or history. */
export declare const SKIPPED_DIRS: readonly [".git", "node_modules", ".flows", ".flow-runs"];
/** A host service refusing, in the shape a plugin can recognise without importing this class. */
export declare class HostServiceError extends Error implements HostError {
    readonly code: HostErrorCode;
    readonly problems?: Problem[];
    readonly current?: HostError["current"];
    constructor(code: HostErrorCode, message: string, extra?: {
        problems?: Problem[];
        current?: HostError["current"];
    });
}
export declare function sha256(bytes: Buffer | string): string;
export declare function stripBomBuffer(bytes: Buffer): {
    text: string;
    bom: boolean;
};
export declare function fieldsFromAutomation(a: Automation): AutomationFields;
export declare function problemFromError(e: unknown, file?: string): Problem;
/** The same, one problem per line when the error has several (a strict flow). */
export declare function problemsFromError(e: unknown, file?: string): Problem[];
export declare function composeAutomationText(currentText: string, dirName: string, fields: AutomationFields): string;
export declare function drivenIds(a: Automation | AutomationFields): string[];
export declare function flowProblems(text: string | null, driven: string[], file?: string, label?: string): Problem[];
