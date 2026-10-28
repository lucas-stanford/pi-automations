// Windows Task Scheduler: interactive token for the person's credentials, hidden wscript shim.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { assertNoSecrets, snapshotEnv } from "./env.js";
export const TASK_NAME = "pi-automations\\tick";
export function taskXml(paths) {
    // UTF-16 with a BOM is what schtasks expects from /XML; the caller writes it that way.
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agent Automations tick (pi) — runs due automations every minute.</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <WakeToRun>false</WakeToRun>
    <AllowHardTerminate>true</AllowHardTerminate>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\\Windows\\System32\\wscript.exe</Command>
      <Arguments>"${paths.shimPath}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
/** The hidden launcher. `0` is the window style and `False` means do not wait. */
export function tickVbs(paths) {
    const cmd = `""${paths.nodePath}"" ""${paths.tickPath}""`;
    return `' Written by pi-automations. Runs the tick with no console window.\r\nCreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`;
}
export const windowsBackend = {
    method: "schtasks",
    jobName: TASK_NAME,
    files(paths) {
        return [
            { path: paths.jobFile, kind: "job" },
            ...(paths.shimPath ? [{ path: paths.shimPath, kind: "shim" }] : []),
        ];
    },
    write(paths) {
        const xml = taskXml(paths);
        assertNoSecrets(xml);
        // schtasks /XML wants UTF-16LE with a BOM; anything else fails with a parse error.
        writeFileSync(paths.jobFile, `\uFEFF${xml}`, "utf16le");
        const vbs = tickVbs(paths);
        assertNoSecrets(vbs);
        writeFileSync(paths.shimPath, vbs, "utf8");
    },
    installCommand(paths) {
        return { file: "schtasks", args: ["/Create", "/TN", TASK_NAME, "/XML", paths.jobFile, "/F"] };
    },
    uninstallCommand() {
        return { file: "schtasks", args: ["/Delete", "/TN", TASK_NAME, "/F"] };
    },
    queryCommand() {
        return { file: "schtasks", args: ["/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"] };
    },
    testCommand() {
        return { file: "schtasks", args: ["/Run", "/TN", TASK_NAME] };
    },
    defaultPaths(stateDir, nodePath, packageDir) {
        return {
            jobFile: path.join(stateDir, "tick.xml"),
            shimPath: path.join(stateDir, "tick.vbs"),
            nodePath,
            packageDir,
            tickPath: path.join(packageDir, "bin", "tick.js"),
            env: snapshotEnv(),
        };
    },
};
//# sourceMappingURL=windows.js.map