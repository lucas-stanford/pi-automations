import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  backendFor,
  crontabLine,
  detachedCli,
  install,
  installed,
  installedPaths,
  plist,
  SECRET_NAME,
  selfUnregister,
  selfUnregisterReason,
  serviceUnit,
  snapshotEnv,
  status,
  taskXml,
  tickVbs,
  timerUnit,
  uninstall,
} from "../src/detached/index.js";
import { serve } from "../src/detached/serve.js";
import { runPiTick as runTick } from "../src/hosts/pi/tick.js";
import type { Command, JobPaths, PlatformBackend } from "../src/detached/types.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const NOW = new Date("2026-09-17T12:00:00.000Z");

/** Records what would have been run, and never runs it. */
function fakeExec(codes: Record<string, number> = {}) {
  const calls: Command[] = [];
  const exec = async (cmd: Command) => {
    calls.push(cmd);
    return { code: codes[cmd.file] ?? 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function fakePaths(dir: string): JobPaths {
  return {
    jobFile: path.join(dir, "job"),
    shimPath: path.join(dir, "tick.vbs"),
    timerFile: path.join(dir, "timer"),
    nodePath: "/opt/node/bin/node",
    packageDir: "/pkg",
    tickPath: "/pkg/bin/tick.js",
    logFile: path.join(dir, "tick.log"),
    env: { vars: { PATH: "/usr/bin:/bin", HOME: "/home/alice" }, refused: [] },
  };
}

describe("snapshotEnv", () => {
  it("carries only the names a job needs", () => {
    const snap = snapshotEnv({ PATH: "/usr/bin", HOME: "/home/x", RANDOM_THING: "nope" });
    expect(snap.vars).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(snap.vars.RANDOM_THING).toBeUndefined();
  });

  it("never carries a credential-shaped variable, and says which it refused", () => {
    const snap = snapshotEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-secret",
      GH_TOKEN: "ghp_secret",
      MY_SECRET: "s",
      DB_PASSWORD: "p",
    });
    expect(Object.keys(snap.vars)).toEqual(["PATH"]);
    expect(snap.refused).toEqual(["ANTHROPIC_API_KEY", "DB_PASSWORD", "GH_TOKEN", "MY_SECRET"]);
  });

  it("matches the documented credential name shapes", () => {
    for (const n of ["X_API_KEY", "X_TOKEN", "X_SECRET", "X_PASSWORD", "X_CREDENTIAL", "X_CREDENTIALS"]) {
      expect(SECRET_NAME.test(n), n).toBe(true);
    }
    for (const n of ["PATH", "HOME", "TOKENIZER", "SECRETARY"]) {
      expect(SECRET_NAME.test(n), n).toBe(false);
    }
  });

  it("skips an empty value rather than writing a blank line", () => {
    expect(snapshotEnv({ PATH: "", HOME: "/h" }).vars).toEqual({ HOME: "/h" });
  });
});

// ---------------------------------------------------------------------------- templates

describe("Windows template", () => {
  const paths = fakePaths("/tmp/x");

  it("sets every option a minute-by-minute job needs", () => {
    const xml = taskXml(paths);
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<Hidden>true</Hidden>");
  });

  it("launches through wscript, which is what keeps the console window off the screen", () => {
    const xml = taskXml(paths);
    expect(xml).toContain("wscript.exe");
    expect(xml).toContain(paths.shimPath as string);
    // node is launched BY the shim, not by the task directly.
    expect(xml).not.toContain(paths.nodePath);
  });

  it("writes a shim that runs hidden and does not wait", () => {
    const vbs = tickVbs(paths);
    expect(vbs).toContain(paths.nodePath);
    expect(vbs).toContain(paths.tickPath);
    expect(vbs.trimEnd().endsWith(", 0, False")).toBe(true);
  });
});

describe("macOS template", () => {
  it("fires every minute and runs in the background band", () => {
    const text = plist(fakePaths("/tmp/x"));
    expect(text).toContain("<key>StartCalendarInterval</key>");
    expect(text).toContain("<dict/>");
    expect(text).toContain("<string>Background</string>");
    expect(text).toContain("<key>RunAtLoad</key>");
    expect(text).toContain("<false/>");
  });

  it("carries an absolute node path and the PATH snapshot", () => {
    const text = plist(fakePaths("/tmp/x"));
    expect(text).toContain("<string>/opt/node/bin/node</string>");
    expect(text).toContain("<key>PATH</key>");
    expect(text).toContain("/usr/bin:/bin");
  });

  it("escapes XML in a path", () => {
    const paths = { ...fakePaths("/tmp/x"), tickPath: "/pkg/a&b/tick.js" };
    expect(plist(paths)).toContain("/pkg/a&amp;b/tick.js");
  });
});

describe("Linux templates", () => {
  it("makes the timer persistent so a boot fires once, not once per missed minute", () => {
    const t = timerUnit();
    expect(t).toContain("OnCalendar=minutely");
    expect(t).toContain("Persistent=true");
    expect(t).toContain("AccuracySec=5s");
    expect(t).toContain("WantedBy=timers.target");
  });

  it("writes a oneshot service with an absolute node path and the environment", () => {
    const s = serviceUnit(fakePaths("/tmp/x"));
    expect(s).toContain("Type=oneshot");
    expect(s).toContain("ExecStart=/opt/node/bin/node /pkg/bin/tick.js");
    expect(s).toContain("Environment=PATH=/usr/bin:/bin");
  });

  it("falls back to a crontab line that carries its own PATH", () => {
    const line = crontabLine(fakePaths("/tmp/x"));
    expect(line.startsWith("* * * * * PATH=/usr/bin:/bin ")).toBe(true);
    expect(line).toContain("/opt/node/bin/node /pkg/bin/tick.js");
    expect(line).toContain(">>");
  });
});

describe("backendFor", () => {
  it("knows the three supported platforms and refuses the rest", () => {
    expect(backendFor("win32")?.method).toBe("schtasks");
    expect(backendFor("darwin")?.method).toBe("launchd");
    expect(backendFor("linux")?.method).toBe("systemd");
    expect(backendFor("aix")).toBeUndefined();
  });
});

describe("install", () => {
  it("writes the job files, registers, and records what it registered against", async () => {
    const dir = tempDir("pi-detached-install-");
    const { exec, calls } = fakeExec();

    const r = await install({ dir, exec, now: NOW, verifySeconds: 0 });

    expect(r.ok).toBe(true);
    expect(calls[0]?.file).toBe(
      process.platform === "win32" ? "schtasks" : process.platform === "darwin" ? "launchctl" : "systemctl",
    );
    expect(installed(dir)).toBe(true);

    const rec = installedPaths(dir);
    expect(rec?.nodePath).toBe(process.execPath);
    expect(rec?.tickPath.endsWith(path.join("bin", "tick.js"))).toBe(true);
    expect(rec?.installedAt).toBe(NOW.toISOString());
  });

  it("reports a registration failure instead of claiming success", async () => {
    const dir = tempDir("pi-detached-failreg-");
    const { exec } = fakeExec({ schtasks: 1, launchctl: 1, systemctl: 1 });
    const r = await install({ dir, exec, now: NOW, verifySeconds: 0 });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("could not register the job");
    expect(installed(dir)).toBe(false);
  });

  it("refuses a platform it has no back-end for, and points at serve", async () => {
    const dir = tempDir("pi-detached-aix-");
    const r = await install({ dir, platform: "aix", exec: fakeExec().exec, verifySeconds: 0 });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe("the watcher is not available on aix — use pa serve instead");
  });

  it("fails verification when no tick arrives, rather than reporting installed", async () => {
    // Registering a job proves nothing: a wrong node path or a blocked task only shows up when the
    // job actually runs.
    const dir = tempDir("pi-detached-verify-");
    const { exec } = fakeExec();
    const r = await install({ dir, exec, now: NOW, verifySeconds: 2 });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("first tick did not arrive");
  }, 15000);

  it("passes verification when the tick moves state.json", async () => {
    const dir = tempDir("pi-detached-verify-ok-");
    mkdirSync(dir, { recursive: true });

    const exec = async (cmd: Command) => {
      // The "test" command is the one that triggers a run; simulate the tick landing.
      if (cmd.args.some((a) => a === "/Run" || a === "kickstart" || a === "start")) {
        writeFileSync(
          path.join(dir, "state.json"),
          JSON.stringify({ version: 1, lastTickAt: new Date().toISOString(), claimed: {}, roots: [] }),
        );
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const r = await install({ dir, exec, now: NOW, verifySeconds: 10 });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("first tick ok");
  }, 20000);

  it("says which environment variables it refused to carry", async () => {
    const dir = tempDir("pi-detached-secrets-");
    process.env.PI_AUTOMATIONS_FAKE_API_KEY = "sk-not-real-abcdefgh";
    try {
      const r = await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0 });
      expect(r.lines.join("\n")).toContain("PI_AUTOMATIONS_FAKE_API_KEY");
      expect(r.lines.join("\n")).toContain("credentials never are");

      // And the value is nowhere in any file that was written.
      const backend = backendFor(process.platform);
      const paths = backend?.defaultPaths(dir, process.execPath, "/pkg");
      for (const f of backend?.files(paths as JobPaths) ?? []) {
        if (!existsSync(f.path)) continue;
        const text = readFileSync(f.path, "utf8");
        expect(text.includes("sk-not-real-abcdefgh"), f.path).toBe(false);
      }
    } finally {
      delete process.env.PI_AUTOMATIONS_FAKE_API_KEY;
    }
  });
});

describe("status", () => {
  it("says the watcher is off when there is no job", async () => {
    const r = await status({ dir: tempDir("pi-detached-none-"), exec: fakeExec().exec });
    expect(r.installed).toBe(false);
    expect(r.lines[0]).toContain("watcher: off");
    expect(r.lines.join("\n")).toContain("start it with: pa watcher start");
  });

  it("reports stale paths after the package moves", async () => {
    const dir = tempDir("pi-detached-stale-");
    await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0 });

    // Rewrite the record the way a reinstall to a new location would leave it.
    const rec = installedPaths(dir);
    writeFileSync(
      path.join(dir, "detached.json"),
      JSON.stringify({ ...rec, packageDir: "/somewhere/else", nodePath: "/old/node" }),
    );

    const r = await status({ dir, exec: fakeExec().exec, now: NOW });
    expect(r.stale).toBe(true);
    expect(r.lines.join("\n")).toContain("stale: registered for node /old/node");
    expect(r.lines.join("\n")).toContain("restart it: pa watcher start");
  });

  it("reports when the scheduler does not know about the job", async () => {
    const dir = tempDir("pi-detached-missing-");
    await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0 });
    const { exec } = fakeExec({ schtasks: 1, launchctl: 1, systemctl: 1 });
    const r = await status({ dir, exec, now: NOW });
    expect(r.lines.join("\n")).toContain("NOT found by the scheduler");
  });

  it("notices a last tick that is far too old", async () => {
    const dir = tempDir("pi-detached-oldtick-");
    await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0 });
    writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        version: 1,
        lastTickAt: new Date(NOW.getTime() - 3600_000).toISOString(),
        claimed: {},
        roots: [],
      }),
    );
    const r = await status({ dir, exec: fakeExec().exec, now: NOW });
    expect(r.lines.join("\n")).toContain("over ten minutes old");
  });
});

describe("uninstall", () => {
  it("removes the job and its files", async () => {
    const dir = tempDir("pi-detached-uninstall-");
    await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0 });

    const backend = backendFor(process.platform);
    const paths = backend?.defaultPaths(dir, process.execPath, "/pkg") as JobPaths;

    const { exec, calls } = fakeExec();
    const r = await uninstall({ dir, exec });

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(installed(dir)).toBe(false);
    for (const f of backend?.files(paths) ?? []) {
      expect(existsSync(f.path), f.path).toBe(false);
    }
  });

  it("purge removes plugin state and says what it did NOT touch", async () => {
    const dir = tempDir("pi-detached-purge-");
    await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0 });
    writeFileSync(path.join(dir, "trust.json"), "{}");

    const r = await uninstall({ dir, exec: fakeExec().exec, purge: true });

    expect(existsSync(dir)).toBe(false);
    expect(r.lines.join("\n")).toContain("~/.agents/automations and every repository were left untouched");
  });

  it("is safe to run when nothing is installed", async () => {
    const dir = tempDir("pi-detached-uninstall-none-");
    const r = await uninstall({ dir, exec: fakeExec().exec });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------- self-unregister

describe("selfUnregisterReason", () => {
  const record = {
    platform: "win32" as NodeJS.Platform,
    jobName: "j",
    nodePath: "/opt/node",
    packageDir: "/pkg",
    tickPath: "/pkg/bin/tick.js",
    installedAt: NOW.toISOString(),
    method: "schtasks" as const,
  };

  it("leaves a healthy job alone", () => {
    expect(selfUnregisterReason(record, () => true)).toBeUndefined();
  });

  it("removes the job when the package is gone — pi remove must not leave one behind", () => {
    const reason = selfUnregisterReason(record, (p) => p !== "/pkg");
    expect(reason).toContain("package is gone");
    expect(reason).toContain("/pkg");
  });

  it("removes the job when tick.js is gone", () => {
    expect(selfUnregisterReason(record, (p) => p !== "/pkg/bin/tick.js")).toContain("tick.js is gone");
  });

  it("removes the job when node is gone", () => {
    expect(selfUnregisterReason(record, (p) => p !== "/opt/node")).toContain("node is gone");
  });

  it("does nothing when no job is installed", () => {
    expect(selfUnregisterReason(undefined, () => false)).toBeUndefined();
  });
});

describe("selfUnregister", () => {
  it("removes the job, its files and the record, and says why", async () => {
    const dir = tempDir("pi-detached-self-");
    await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0 });

    const backend = backendFor(process.platform);
    const paths = backend?.defaultPaths(dir, process.execPath, "/pkg") as JobPaths;

    const logged: string[] = [];
    const { exec, calls } = fakeExec();
    const removed = await selfUnregister("package is gone", {
      dir,
      exec,
      log: (l) => logged.push(l),
    });

    expect(removed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(installed(dir)).toBe(false);
    for (const f of backend?.files(paths) ?? []) {
      expect(existsSync(f.path), f.path).toBe(false);
    }
    expect(logged.join("\n")).toContain("package is gone");
  });

  it("is a no-op when nothing is installed", async () => {
    const { exec, calls } = fakeExec();
    const removed = await selfUnregister("x", { dir: tempDir("pi-detached-self-none-"), exec });
    expect(removed).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------- serve

describe("serve", () => {
  it("ticks until it is stopped, and a failing tick does not end the loop", async () => {
    const dir = tempDir("pi-serve-");
    const controller = new AbortController();
    const lines: string[] = [];

    const p = serve({
      stateDir: dir,
      intervalSec: 0.05,
      signal: controller.signal,
      log: (l) => lines.push(l),
      // MUST be set. Without it runTick discovers ~/.agents/automations and spawns real runs of
      // whatever the person actually has armed — this test did exactly that, four times, with a
      // real model call each time, before the isolation was added.
      roots: [],
    });

    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await p;

    expect(lines[0]).toContain("ticking every");
    // It survived several iterations without throwing.
    expect(existsSync(path.join(dir, "state.json"))).toBe(true);
  }, 15000);

  it("discovers nothing at all when given an empty root list", async () => {
    // The guard the test above depends on: an empty list means empty, not "fall back to the
    // person's home directory".
    const dir = tempDir("pi-serve-roots-");
    const summary = await runTick({ stateDir: dir, roots: [] });
    expect(summary?.considered).toBe(0);
    expect(summary?.fired).toEqual([]);
  });
});

describe("the scheduler is chosen at composition", () => {
  /** This platform's real backend with only its COMMANDS replaced. */
  function fakeBackend(): PlatformBackend {
    const real = backendFor() as PlatformBackend;
    return {
      ...real,
      installCommand: () => ({ file: "fixture-install", args: [] }),
      uninstallCommand: () => ({ file: "fixture-uninstall", args: [] }),
      queryCommand: () => ({ file: "fixture-query", args: [] }),
    };
  }

  it("installs with the commands of the backend it was handed", async () => {
    const dir = tempDir("pi-detached-composed-");
    const f = fakeExec();

    await install({ dir, exec: f.exec, now: NOW, verifySeconds: 0, backend: fakeBackend() });

    expect(f.calls.map((c) => c.file)).toContain("fixture-install");
  });

  it("uninstalls with it too, so both verbs mean the same job", async () => {
    const dir = tempDir("pi-detached-composed-un-");
    await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0, backend: fakeBackend() });

    const f = fakeExec();
    await uninstall({ dir, exec: f.exec, backend: fakeBackend() });

    expect(f.calls.map((c) => c.file)).toContain("fixture-uninstall");
  });

  it("queries with it, so status is about the job that was installed", async () => {
    const dir = tempDir("pi-detached-composed-st-");
    await install({ dir, exec: fakeExec().exec, now: NOW, verifySeconds: 0, backend: fakeBackend() });

    const f = fakeExec();
    await status({ dir, exec: f.exec, now: NOW, backend: fakeBackend() });

    expect(f.calls.map((c) => c.file)).toContain("fixture-query");
  });

  it("still falls back to this platform's backend when none is composed", async () => {
    // The whole point of the default: every existing caller keeps registering exactly the job it
    // registered before, so nothing about a real installation changes.
    const dir = tempDir("pi-detached-default-");
    const f = fakeExec();

    await install({ dir, exec: f.exec, now: NOW, verifySeconds: 0 });

    const expected = backendFor();
    expect(expected).toBeDefined();
    expect(f.calls.map((c) => c.file)).not.toContain("fixture-install");
    expect(f.calls.length).toBeGreaterThan(0);
  });

  it("routes the composed backend through the CLI as well", async () => {
    const dir = tempDir("pi-detached-cli-");
    // `detachedCli` is what bin/pi-automations.js calls; it must not quietly drop the choice.
    const r = await detachedCli(["status"], { stateDir: dir, backend: fakeBackend() });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toBeTruthy();
  });
});