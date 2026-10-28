// macOS launchd: an empty `StartCalendarInterval` is every minute; missed firings coalesce.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { assertNoSecrets, snapshotEnv } from "./env.js";
export const LABEL = "io.agentautomations.pi.tick";
function xmlEscape(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
export function plist(paths) {
    const envEntries = Object.entries(paths.env.vars)
        .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
        .join("\n");
    const log = paths.logFile ?? "/dev/null";
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(paths.nodePath)}</string>
    <string>${xmlEscape(paths.tickPath)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict/>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}
function gui() {
    // launchctl needs the numeric uid; process.getuid exists on every platform this runs on.
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    return `gui/${uid}`;
}
export const macosBackend = {
    method: "launchd",
    jobName: LABEL,
    files(paths) {
        return [{ path: paths.jobFile, kind: "job" }];
    },
    write(paths) {
        const text = plist(paths);
        assertNoSecrets(text);
        writeFileSync(paths.jobFile, text, "utf8");
    },
    installCommand(paths) {
        return { file: "launchctl", args: ["bootstrap", gui(), paths.jobFile] };
    },
    uninstallCommand() {
        return { file: "launchctl", args: ["bootout", `${gui()}/${LABEL}`] };
    },
    queryCommand() {
        return { file: "launchctl", args: ["print", `${gui()}/${LABEL}`] };
    },
    testCommand() {
        return { file: "launchctl", args: ["kickstart", "-k", `${gui()}/${LABEL}`] };
    },
    defaultPaths(stateDir, nodePath, packageDir) {
        return {
            jobFile: path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
            nodePath,
            packageDir,
            tickPath: path.join(packageDir, "bin", "tick.js"),
            logFile: path.join(stateDir, "logs", "tick.log"),
            env: snapshotEnv(),
        };
    },
};
//# sourceMappingURL=macos.js.map