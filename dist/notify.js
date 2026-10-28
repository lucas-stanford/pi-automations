// Tell somebody a run failed: best effort, `failed` only. This module provides the desktop toast.
import { execFile } from "node:child_process";
import { formatDuration } from "./duration.js";
import { summaryLine } from "./summary.js";
const TIMEOUT_MS = 5000;
function run(file, args) {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        try {
            const child = execFile(file, args, { windowsHide: true, timeout: TIMEOUT_MS }, () => done());
            child.on("error", done);
        }
        catch {
            done();
        }
    });
}
/** Single-quote for AppleScript / shell string literals. */
function quote(s) {
    return s.replace(/["\\]/g, "\\$&");
}
export function notificationText(rec) {
    // The same sentence the log, entry and report show.
    const said = summaryLine(rec, 180);
    const took = rec.startedAt && rec.endedAt
        ? ` (after ${formatDuration(Date.parse(rec.endedAt) - Date.parse(rec.startedAt))})`
        : "";
    return {
        title: `${rec.name} failed`,
        body: `${said}${took}`,
    };
}
export async function notifyFailed(rec, platform = process.platform) {
    if (rec.outcome !== "failed")
        return;
    const { title, body } = notificationText(rec);
    try {
        if (platform === "darwin") {
            await run("osascript", [
                "-e",
                `display notification "${quote(body)}" with title "pi-automations" subtitle "${quote(title)}"`,
            ]);
            return;
        }
        if (platform === "linux") {
            await run("notify-send", ["-a", "pi-automations", title, body]);
            return;
        }
        if (platform === "win32") {
            // Some Windows PowerShell hosts lack the toast API; ignore the failure.
            const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ` +
                `$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(` +
                `[Windows.UI.Notifications.ToastTemplateType]::ToastText02); ` +
                `$n = $t.GetElementsByTagName('text'); ` +
                `$n.Item(0).AppendChild($t.CreateTextNode("${quote(title)}")) > $null; ` +
                `$n.Item(1).AppendChild($t.CreateTextNode("${quote(body)}")) > $null; ` +
                `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('pi-automations').Show(` +
                `[Windows.UI.Notifications.ToastNotification]::new($t))`;
            await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
            return;
        }
    }
    catch {
        // Never throws. See the module comment.
    }
}
/** The desktop sink: a real toast on this machine. The only way a real notification is raised. */
export function desktopNotifier(platform = process.platform) {
    return (rec) => notifyFailed(rec, platform);
}
//# sourceMappingURL=notify.js.map