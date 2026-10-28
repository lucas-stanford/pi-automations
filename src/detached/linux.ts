// Linux: a systemd user timer (`Persistent=true` fires once after downtime), or a crontab line. A
// user timer stops at logout unless lingering is enabled; `status` says so.

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { assertNoSecrets, snapshotEnv } from "./env.js";
import type { JobPaths, PlatformBackend } from "./types.js";

export const UNIT = "pi-automations-tick";

export function serviceUnit(paths: JobPaths): string {
  const env = Object.entries(paths.env.vars)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");

  return `[Unit]
Description=Agent Automations tick (pi)

[Service]
Type=oneshot
ExecStart=${paths.nodePath} ${paths.tickPath}
${env}
`;
}

export function timerUnit(): string {
  return `[Unit]
Description=Agent Automations tick (pi)

[Timer]
OnCalendar=minutely
AccuracySec=5s
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** The crontab line used when there is no systemd. */
export function crontabLine(paths: JobPaths): string {
  const p = paths.env.vars.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const log = paths.logFile ?? "/dev/null";
  return `* * * * * PATH=${p} ${paths.nodePath} ${paths.tickPath} >> ${log} 2>&1`;
}

export const linuxBackend: PlatformBackend = {
  method: "systemd",
  jobName: `${UNIT}.timer`,

  files(paths) {
    return [
      { path: paths.jobFile, kind: "job" },
      ...(paths.timerFile ? [{ path: paths.timerFile, kind: "timer" as const }] : []),
    ];
  },

  write(paths) {
    const service = serviceUnit(paths);
    assertNoSecrets(service);
    writeFileSync(paths.jobFile, service, "utf8");
    writeFileSync(paths.timerFile as string, timerUnit(), "utf8");
  },

  installCommand() {
    return { file: "systemctl", args: ["--user", "enable", "--now", `${UNIT}.timer`] };
  },

  uninstallCommand() {
    return { file: "systemctl", args: ["--user", "disable", "--now", `${UNIT}.timer`] };
  },

  queryCommand() {
    return { file: "systemctl", args: ["--user", "list-timers", `${UNIT}.timer`] };
  },

  testCommand() {
    return { file: "systemctl", args: ["--user", "start", `${UNIT}.service`] };
  },

  defaultPaths(stateDir, nodePath, packageDir) {
    const unitDir = path.join(homedir(), ".config", "systemd", "user");
    return {
      jobFile: path.join(unitDir, `${UNIT}.service`),
      timerFile: path.join(unitDir, `${UNIT}.timer`),
      nodePath,
      packageDir,
      tickPath: path.join(packageDir, "bin", "tick.js"),
      logFile: path.join(stateDir, "logs", "tick.log"),
      env: snapshotEnv(),
    };
  },
};
