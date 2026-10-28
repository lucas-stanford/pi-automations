import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { byKey, discover, located } from "../src/discover.js";
import { digestOf, fileHashesOf, scriptHooks } from "../src/digest.js";
import { AutomationError } from "../src/errors.js";
import { hasExecutableBit, resolveInterpreter, whichSync } from "../src/interpreters.js";
import { key as makeKey } from "../src/paths.js";
import type { Located, Root } from "../src/types.js";
// @ts-expect-error - plain JS fixture builder, deliberately untyped
import { buildFixtures } from "./helpers/fixtures.mjs";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

// Own fixture tree per test file — the digest tests below deliberately mutate it, and vitest runs
// files in parallel, so a shared tree would corrupt whatever else was reading it.
let F: { userRoot: string; projectRoot: string; projectAutomations: string; invalidRoot: string };
const rebuild = () => {
  F = buildFixtures(fixtureHome);
};
let fixtureHome: string;

beforeAll(() => {
  fixtureHome = tempDir("pi-fixtures-discover-");
  rebuild();
});
afterAll(cleanupTempDirs);

const userRoot = (): Root => ({ path: F.userRoot, scope: "user", kind: "agents" });
const projectRoot = (): Root => ({
  path: F.projectAutomations,
  scope: "repository",
  kind: "agents",
});
const invalidRoot = (): Root => ({
  path: F.invalidRoot,
  scope: "user",
  kind: "agents",
});

// Windows without Developer Mode cannot create symlinks. Detect that ONCE and mark the affected
// tests skipped rather than letting them return early — a security check that quietly reports
// "passed" when it never ran is worse than one that reports "skipped".
const symlinksWork = (() => {
  try {
    const d = tempDir("pi-symcap-");
    writeFileSync(path.join(d, "real.txt"), "x");
    symlinkSync(path.join(d, "real.txt"), path.join(d, "link.txt"));
    return true;
  } catch {
    return false;
  }
})();
const itSymlink = symlinksWork ? it : it.skip;

describe("discover", () => {
  it("finds every automation in a root, keyed by scope, root and name", () => {
    const found = discover({ roots: [userRoot()] });
    const names = located(found).map((l) => l.automation.name).sort();
    expect(names).toEqual(["daily-briefing", "manual-only", "standup-notes", "weekly-report"]);

    const one = located(found).find((l) => l.automation.name === "daily-briefing") as Located;
    expect(one.key).toBe(makeKey("user", F.userRoot, "daily-briefing"));
    expect(one.file.endsWith(path.join("daily-briefing", "AUTOMATION.md"))).toBe(true);
  });

  it("includes disabled automations — they are listed, not hidden", () => {
    const found = discover({ roots: [userRoot()] });
    const standup = located(found).find((l) => l.automation.name === "standup-notes");
    expect(standup?.automation.enabled).toBe(false);
  });

  it("records the repository root for repository-scope automations", () => {
    const found = discover({ roots: [projectRoot()] });
    for (const l of located(found)) {
      expect(l.repoRoot).toBe(path.resolve(F.projectRoot));
    }
  });

  it("reports a parse failure as a one-line error instead of throwing", () => {
    const found = discover({ roots: [invalidRoot()] });
    expect(found.length).toBeGreaterThan(20);
    expect(found.every((d) => !d.ok)).toBe(true);

    const badCron = found.find((d) => !d.ok && d.dir.endsWith("bad-cron"));
    expect(badCron && !badCron.ok && badCron.error).toBe(
      'on.schedule.cron: "0 7 * * MON-FRI *" is not a 5-field cron expression',
    );
  });

  it("never throws, whatever is in the directory", () => {
    const dir = tempDir("pi-discover-junk-");
    mkdirSync(path.join(dir, "not-an-automation"), { recursive: true });
    writeFileSync(path.join(dir, "loose-file.md"), "hello");
    mkdirSync(path.join(dir, "broken"), { recursive: true });
    writeFileSync(path.join(dir, "broken", "AUTOMATION.md"), "not frontmatter at all");

    const found = discover({ roots: [{ path: dir, scope: "user", kind: "agents" }] });
    // The directory with no AUTOMATION.md is not an automation, so it is not reported at all.
    expect(found).toHaveLength(1);
    expect(found[0]?.ok).toBe(false);
  });

  it("skips a root that does not exist", () => {
    expect(discover({ roots: [{ path: path.join(tempDir(), "gone"), scope: "user", kind: "agents" }] }))
      .toEqual([]);
  });

  it("keeps the first root to claim a key when a root is visited twice", () => {
    const found = discover({ roots: [userRoot(), userRoot()] });
    expect(found).toHaveLength(4);
  });

  itSymlink("refuses a script that symlinks out of the automation directory", () => {
    const dir = tempDir("pi-symlink-");
    const root = path.join(dir, "automations");
    const outside = path.join(dir, "outside");
    mkdirSync(path.join(root, "sneaky", "scripts"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "evil.js"), "console.log('pwned');\n");
    writeFileSync(
      path.join(root, "sneaky", "AUTOMATION.md"),
      `---\nname: sneaky\ndescription: Looks relative, points away.\non:\n  manual: true\nhooks:\n  pre:\n    - script: scripts/helper.js\n---\n\nBody.\n`,
    );
    symlinkSync(path.join(outside, "evil.js"), path.join(root, "sneaky", "scripts", "helper.js"));

    const found = discover({ roots: [{ path: root, scope: "repository", kind: "agents" }] });
    expect(found).toHaveLength(1);
    expect(found[0]?.ok).toBe(false);
    expect(!found[0]?.ok && found[0]?.error).toBe(
      'hooks.pre[0].script: "scripts/helper.js" resolves outside the automation directory',
    );
  });

  itSymlink("allows a symlink that stays inside the automation directory", () => {
    const dir = tempDir("pi-symlink-ok-");
    const root = path.join(dir, "automations");
    mkdirSync(path.join(root, "fine", "scripts"), { recursive: true });
    writeFileSync(path.join(root, "fine", "real.js"), "console.log('ok');\n");
    writeFileSync(
      path.join(root, "fine", "AUTOMATION.md"),
      `---\nname: fine\ndescription: Links within itself.\non:\n  manual: true\nhooks:\n  pre:\n    - script: scripts/helper.js\n---\n\nBody.\n`,
    );
    symlinkSync(path.join(root, "fine", "real.js"), path.join(root, "fine", "scripts", "helper.js"));

    const found = discover({ roots: [{ path: root, scope: "repository", kind: "agents" }] });
    expect(found[0]?.ok).toBe(true);
  });

  it("byKey finds both good and bad entries", () => {
    const found = discover({ roots: [userRoot(), invalidRoot()] });
    const goodKey = makeKey("user", F.userRoot, "manual-only");
    expect(byKey(found, goodKey)?.ok).toBe(true);
    const badKey = makeKey("user", F.invalidRoot, "bad-cron");
    expect(byKey(found, badKey)?.ok).toBe(false);
    expect(byKey(found, "nope")).toBeUndefined();
  });
});

describe("resolveInterpreter", () => {
  const all: WhichMap = {
    python3: "/usr/bin/python3",
    python: "/usr/bin/python",
    py: "C:\\Windows\\py.exe",
    bash: "/bin/bash",
    sh: "/bin/sh",
    pwsh: "/usr/local/bin/pwsh",
    powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    cmd: "C:\\Windows\\System32\\cmd.exe",
  };
  type WhichMap = Record<string, string>;
  const which = (map: WhichMap) => (b: string) => map[b];
  const none = () => undefined;

  it("runs JavaScript with the node that is running us, on both platforms", () => {
    for (const platform of ["linux", "win32"] as const) {
      for (const ext of [".js", ".mjs", ".cjs"]) {
        const r = resolveInterpreter(`/a/s${ext}`, platform, which(all), `s${ext}`);
        expect(r.ok && r.file, ext).toBe(process.execPath);
        expect(r.ok && r.args).toEqual([`/a/s${ext}`]);
      }
    }
  });

  it("prefers python3 on POSIX and the py launcher on Windows", () => {
    const posix = resolveInterpreter("/a/s.py", "linux", which(all), "scripts/s.py");
    expect(posix.ok && posix.file).toBe("/usr/bin/python3");
    expect(posix.ok && posix.display).toBe("/usr/bin/python3 scripts/s.py");

    const win = resolveInterpreter("C:\\a\\s.py", "win32", which(all), "scripts/s.py");
    expect(win.ok && win.file).toBe("C:\\Windows\\py.exe");
    expect(win.ok && win.args?.[0]).toBe("-3");
  });

  it("falls back to python when python3 is absent", () => {
    const r = resolveInterpreter("/a/s.py", "linux", which({ python: "/usr/bin/python" }));
    expect(r.ok && r.file).toBe("/usr/bin/python");
  });

  it("refuses python when neither is installed", () => {
    const r = resolveInterpreter("/a/s.py", "linux", none);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("needs python3");
  });

  it("prefers bash over sh on POSIX", () => {
    expect(resolveInterpreter("/a/s.sh", "linux", which(all)).ok && "/bin/bash").toBe("/bin/bash");
    const shOnly = resolveInterpreter("/a/s.sh", "linux", which({ sh: "/bin/sh" }));
    expect(shOnly.ok && shOnly.file).toBe("/bin/sh");
  });

  it("refuses a .sh on Windows without bash, and says how to fix it", () => {
    const r = resolveInterpreter("C:\\a\\s.sh", "win32", none);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("Git Bash");
  });

  it("accepts a .sh on Windows when Git Bash is installed", () => {
    const r = resolveInterpreter("C:\\a\\s.sh", "win32", which({ bash: "C:\\Git\\bin\\bash.exe" }));
    expect(r.ok && r.file).toBe("C:\\Git\\bin\\bash.exe");
  });

  it("prefers pwsh everywhere and falls back to powershell only on Windows", () => {
    const posix = resolveInterpreter("/a/s.ps1", "linux", which(all));
    expect(posix.ok && posix.args?.slice(0, 2)).toEqual(["-NoProfile", "-File"]);

    const win = resolveInterpreter("C:\\a\\s.ps1", "win32", which({ powershell: all.powershell as string }));
    expect(win.ok && win.file).toBe(all.powershell);
    expect(win.ok && win.args?.slice(0, 4)).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
  });

  it("refuses a .ps1 on POSIX without pwsh, using the specification's own wording", () => {
    const r = resolveInterpreter("/a/count.ps1", "linux", none, "scripts/count.ps1");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("cannot run here — needs pwsh (PowerShell 7) on this OS");
  });

  it("runs .cmd and .bat through cmd /c on Windows and refuses them elsewhere", () => {
    for (const ext of [".cmd", ".bat"]) {
      const win = resolveInterpreter(`C:\\a\\s${ext}`, "win32", which(all));
      expect(win.ok && win.args?.[0]).toBe("/c");
      const posix = resolveInterpreter(`/a/s${ext}`, "linux", which(all));
      expect(posix.ok).toBe(false);
      expect(!posix.ok && posix.reason).toContain("need Windows");
    }
  });

  it("refuses an unknown extension and names it", () => {
    const r = resolveInterpreter("/a/s.rb", "linux", which(all));
    expect(!r.ok && r.reason).toBe('cannot run here — no interpreter for ".rb" on this OS');
  });

  it("runs an extensionless file directly on POSIX only when it is executable", () => {
    const dir = tempDir("pi-noext-");
    const script = path.join(dir, "runner");
    writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o755 });

    const r = resolveInterpreter(script, "linux", none, "runner");
    if (hasExecutableBit(script)) {
      expect(r.ok && r.file).toBe(script);
      expect(r.ok && r.args).toEqual([]);
    } else {
      // Windows filesystems report no executable bit; the refusal is then the correct answer.
      expect(r.ok).toBe(false);
    }

    const win = resolveInterpreter(script, "win32", none, "runner");
    expect(win.ok).toBe(false);
    expect(!win.ok && win.reason).toContain("file extension");
  });

  it("refuses an extensionless file that does not exist", () => {
    const r = resolveInterpreter(path.join(tempDir(), "missing"), "linux", none);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("missing");
  });
});

describe("whichSync", () => {
  it("finds a real executable on this host", () => {
    const found = whichSync("node");
    expect(found).toBeTruthy();
    expect(path.basename(String(found)).toLowerCase().startsWith("node")).toBe(true);
  });

  it("returns undefined for something that is not there", () => {
    expect(whichSync("definitely-not-a-real-binary-zzz")).toBeUndefined();
  });

  it("resolves an explicit path without consulting PATH", () => {
    expect(whichSync(process.execPath)).toBe(path.resolve(process.execPath));
  });
});

describe("digestOf", () => {
  function locate(root: string, name: string): Located {
    const found = discover({ roots: [{ path: root, scope: "user", kind: "agents" }] });
    const l = located(found).find((x) => x.automation.name === name);
    if (!l) throw new Error(`fixture ${name} not found`);
    return l;
  }

  it("is stable and prefixed", () => {
    const l = locate(F.userRoot, "daily-briefing");
    const a = digestOf(l);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOf(l)).toBe(a);
  });

  it("changes when the body changes", () => {
    rebuild();
    const l = locate(F.userRoot, "daily-briefing");
    const before = digestOf(l);
    writeFileSync(l.file, `${readBack(l.file)}\nOne more sentence.\n`);
    expect(digestOf(l)).not.toBe(before);
    rebuild();
  });

  it("changes when a hook script changes", () => {
    rebuild();
    const l = locate(F.userRoot, "daily-briefing");
    const before = digestOf(l);
    const script = path.join(l.dir, "scripts", "overnight_counts.js");
    writeFileSync(script, "console.log('different');\n");
    expect(digestOf(l)).not.toBe(before);
    rebuild();
  });

  it("does not change when only the modification time moves", () => {
    rebuild();
    const l = locate(F.userRoot, "daily-briefing");
    const before = digestOf(l);
    const script = path.join(l.dir, "scripts", "overnight_counts.js");
    writeFileSync(script, readBack(script));
    expect(digestOf(l)).toBe(before);
  });

  it("covers the scripts in run order, so reordering them changes the digest", () => {
    const l = locate(F.userRoot, "daily-briefing");
    expect(scriptHooks(l).map((s) => `${s.phase}[${s.index}] ${s.script}`)).toEqual([
      "pre[0] scripts/overnight_counts.js",
      "post[0] scripts/mark_run.js",
    ]);

    const swapped: Located = {
      ...l,
      automation: {
        ...l.automation,
        hooks: { pre: l.automation.hooks.post, post: l.automation.hooks.pre },
      },
    };
    expect(digestOf(swapped)).not.toBe(digestOf(l));
  });

  it("refuses when a referenced script is missing, naming the field", () => {
    const dir = tempDir("pi-digest-missing-");
    const root = path.join(dir, "automations");
    mkdirSync(path.join(root, "gap"), { recursive: true });
    writeFileSync(
      path.join(root, "gap", "AUTOMATION.md"),
      `---\nname: gap\ndescription: References a script that is not there.\non:\n  manual: true\nhooks:\n  pre:\n    - script: scripts/missing.js\n---\n\nBody.\n`,
    );
    const l = locate(root, "gap");
    expect(() => digestOf(l)).toThrow(AutomationError);
    expect(() => digestOf(l)).toThrow('hooks.pre[0].script: "scripts/missing.js" not found');
  });

  it("reports per-file hashes so a mismatch can name the file", () => {
    rebuild();
    const l = locate(F.userRoot, "daily-briefing");
    const hashes = fileHashesOf(l);
    expect(Object.keys(hashes).sort()).toEqual([
      "AUTOMATION.md",
      "scripts/mark_run.js",
      "scripts/overnight_counts.js",
    ]);
    expect(hashes["AUTOMATION.md"]).toMatch(/^sha256:/);
  });

  it("reports a missing file as null rather than throwing", () => {
    const dir = tempDir("pi-digest-null-");
    const root = path.join(dir, "automations");
    mkdirSync(path.join(root, "gap2"), { recursive: true });
    writeFileSync(
      path.join(root, "gap2", "AUTOMATION.md"),
      `---\nname: gap2\ndescription: References a script that is not there.\non:\n  manual: true\nhooks:\n  post:\n    - script: scripts/missing.js\n---\n\nBody.\n`,
    );
    const l = locate(root, "gap2");
    expect(fileHashesOf(l)["scripts/missing.js"]).toBeNull();
  });
});

function readBack(p: string): string {
  return readFileSync(p, "utf8");
}
