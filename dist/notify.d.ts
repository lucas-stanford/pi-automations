import type { Notify } from "./core/contracts.js";
import type { RunRecord } from "./types.js";
export declare function notificationText(rec: RunRecord): {
    title: string;
    body: string;
};
export declare function notifyFailed(rec: RunRecord, platform?: NodeJS.Platform): Promise<void>;
/** The desktop sink: a real toast on this machine. The only way a real notification is raised. */
export declare function desktopNotifier(platform?: NodeJS.Platform): Notify;
