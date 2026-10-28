/** The suite must never touch the person's real automations, real plugin state, or the OS. */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const thisFile = fileURLToPath(import.meta.url);
const testDir = path.dirname(thisFile);

const SCANNED = [".ts", ".js", ".mjs"];

// Every file under `test/`, at any depth, except this one — which names the forbidden paths in
// order to forbid them.
function scannedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SCANNED.includes(path.extname(entry.name))) continue;
      if (full === thisFile) continue;
      out.push(full);
    }
  };
  walk(testDir);
  return out;
}

/** The substring from `open` (a `(`) through its matching `)`. */
function balanced(src: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return undefined;
}

// --- the rules, each a pure function of one file's source ---------------------------------------

/** A dispatcher call that does not restrict discovery. Shorthand (`{ roots }`) counts. */
function unrestrictedDispatch(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(runTick|serve)\s*\(/g)) {
    const call = balanced(src, (m.index ?? 0) + m[0].length - 1);
    if (call === undefined) continue;
    // `roots` injects the list outright; `host` says which user directories to build it from.
    // Either is an explicit answer to "where do you discover from", which is the question this scan
    // exists to force — `discover(…)` below has accepted both since the host became sayable.
    const restricted = /\broots\s*[:,}]/.test(call) || /\bhost\s*[:,}]/.test(call);
    if (!restricted) out.push(`${m[1]}(…) with no roots or host`);
  }
  return out;
}

/** A discovery call that does not say where to look. */
function unrestrictedDiscovery(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bdiscover\s*\(/g)) {
    const call = balanced(src, (m.index ?? 0) + m[0].length - 1);
    if (call === undefined) continue;
    const restricted =
      /\broots\s*[:,}]/.test(call) || /\bcwd\s*[:,}]/.test(call) || /\bhost\s*[:,}]/.test(call);
    if (!restricted) out.push("discover(…) with no roots, cwd or host");
  }
  return out;
}

/** A path built into the operator's real automation or state directories. */
function realHomePaths(src: string): string[] {
  const out: string[] = [];
  if (/homedir\(\)[^)\n]*["']\.agents["']/.test(src) || /USERPROFILE[^\n]*\.agents/.test(src)) {
    out.push("builds a path into the real user automations directory");
  }
  if (
    /["']\.pi["']\s*,\s*["']agent["']/.test(src) ||
    /homedir\(\)[^)\n]*["']\.pi["']/.test(src)
  ) {
    out.push("builds a path into the real agent directory");
  }
  return out;
}

/** A real OS scheduler registration. */
function realSchedulerRegistration(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+["'][^"']*detached\/(windows|macos|linux)\.js["']/g)) {
    out.push(`imports the real ${m[1]} scheduler backend`);
  }
  if (/\b(schtasks|launchctl|crontab)\b/.test(src) && !/backend|template|command|fake/i.test(src)) {
    out.push("names a real OS scheduler command outside a template or fake");
  }
  return out;
}

/** A command host built without any restriction on discovery. */
/** The `{` of the literal that ENCLOSES `from`. */
function enclosingBrace(src: string, from: number): number {
  let closed = 0;
  for (let i = from; i >= 0; i--) {
    const c = src[i];
    if (c === "}") closed++;
    else if (c === "{") {
      if (closed === 0) return i;
      closed--;
    }
  }
  return -1;
}

function hostWithoutRoots(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bspawnFire\s*[:,}]/g)) {
    const open = enclosingBrace(src, m.index ?? 0);
    if (open === -1) continue;
    let depth = 0;
    let literal = "";
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          literal = src.slice(open, i + 1);
          break;
        }
      }
    }
    if (literal === "") continue;
    if (
      /\broots\s*[:,}]/.test(literal) ||
      /\bcwd\s*[:,}]/.test(literal) ||
      /\bhost\s*[:,}]/.test(literal) ||
      /\bstatuses\s*[:,}]/.test(literal)
    ) {
      continue;
    }
    out.push("declares a discovering test host but restricts discovery nowhere");
  }
  return [...new Set(out)];
}

function offendersInSource(src: string, label: string): string[] {
  return [
    ...unrestrictedDispatch(src),
    ...unrestrictedDiscovery(src),
    ...realHomePaths(src),
    ...realSchedulerRegistration(src),
    ...hostWithoutRoots(src),
  ].map((why) => `${label}: ${why}`);
}

function offendersIn(file: string): string[] {
  return offendersInSource(readFileSync(file, "utf8"), path.relative(testDir, file));
}

// --- negative controls ---------------------------------------------------------------------------

const planted: string[] = [];

/** Write a synthetic offender at a nested path under `test/<relDir>/`, returning its path. */
function plant(relDir: string, name: string, body: string): string {
  mkdirSync(path.join(testDir, relDir), { recursive: true });
  const base = mkdtempSync(path.join(testDir, relDir, "isolation-probe-"));
  planted.push(base);
  const file = path.join(base, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

afterEach(() => {
  while (planted.length) {
    const dir = planted.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("test isolation", () => {
  it("scans every .ts, .js and .mjs under test/, at any depth", () => {
    const files = scannedFiles().map((f) => path.relative(testDir, f));

    // Helpers are in scope, not exempt.
    expect(files).toContain(path.join("helpers", "temp.ts"));
    expect(files).toContain(path.join("helpers", "isolated-host.ts"));
    expect(files).toContain(path.join("helpers", "fake-pi.ts"));
    // A non-.ts extension is really covered.
    expect(files.some((f) => f.endsWith(".mjs"))).toBe(true);
    // And this file is excluded, because it must name what it forbids.
    expect(files).not.toContain(path.basename(thisFile));
  });

  it("finds no offender anywhere under test/", () => {
    const offenders = scannedFiles().flatMap(offendersIn);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  // --- negative controls, nested, written and removed ----------------------------------------

  it("rejects a bare runTick nested under helpers/", () => {
    const file = plant(
      "helpers",
      "bare-runtick.ts",
      "export async function go() {\n  await runTick({ stateDir: dir });\n}\n",
    );
    expect(scannedFiles()).toContain(file);
    expect(offendersIn(file).join("\n")).toContain("runTick(…) with no roots");
  });

  it("rejects a bare serve nested two levels under fixtures/", () => {
    mkdirSync(path.join(testDir, "fixtures"), { recursive: true });
    const base = mkdtempSync(path.join(testDir, "fixtures", "isolation-probe-"));
    planted.push(base);
    const dir = path.join(base, "nested");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "bare-serve.mjs");
    writeFileSync(file, "export const go = () => serve({ stateDir: d });\n");

    expect(scannedFiles()).toContain(file);
    expect(offendersIn(file).join("\n")).toContain("serve(…) with no roots");
  });

  it("accepts a restricted call, so the rule is not simply always-fail", () => {
    const file = plant(
      "helpers",
      "restricted.ts",
      "export const go = () => serve({ stateDir: d, roots: [] });\n",
    );
    expect(offendersIn(file)).toEqual([]);
  });

  it("rejects a constructed path into the real user automations directory", () => {
    const file = plant(
      "helpers",
      "real-agents.ts",
      'import { homedir } from "node:os";\nexport const p = join(homedir(), ".agents", "automations");\n',
    );
    expect(offendersIn(file).join("\n")).toContain("real user automations directory");
  });

  it("rejects a constructed path into the real agent directory", () => {
    const file = plant(
      "helpers",
      "real-agent-dir.ts",
      'export const p = join(base, ".pi", "agent", "pi-automations");\n',
    );
    expect(offendersIn(file).join("\n")).toContain("real agent directory");
  });

  it("rejects an import of a real OS scheduler backend", () => {
    const file = plant(
      "helpers",
      "real-backend.ts",
      'import { windows } from "../../src/detached/windows.js";\nexport const b = windows;\n',
    );
    expect(offendersIn(file).join("\n")).toContain("real windows scheduler backend");
  });

  it("rejects a host that names a state directory but restricts discovery nowhere", () => {
    const file = plant(
      "helpers",
      "loose-host.mjs",
      "export const deps = { stateDir: dir, spawnFire: () => 0, config: DEFAULTS };\n",
    );
    expect(offendersIn(file).join("\n")).toContain("restricts discovery nowhere");
  });

  it("accepts a host that restricts discovery by roots", () => {
    const file = plant(
      "helpers",
      "tight-host.mjs",
      "export const deps = { stateDir: dir, spawnFire: () => 0, roots: [{ path: r }] };\n",
    );
    expect(offendersIn(file)).toEqual([]);
  });

  it("accepts a host handed its statuses outright, which discovers nothing", () => {
    const file = plant(
      "helpers",
      "injected-host.mjs",
      "export const deps = { stateDir: dir, spawnFire: () => 0, statuses: [] };\n",
    );
    expect(offendersIn(file)).toEqual([]);
  });

  it("reads the ENCLOSING literal, so a sibling object before spawnFire does not hide the restriction", () => {
    const file = plant(
      "helpers",
      "sibling-restricted.mjs",
      'export const deps = { host: { home: h, agentDir: a }, spawnFire: () => 0 };\n',
    );
    expect(offendersIn(file)).toEqual([]);
  });

  it("still rejects an unrestricted host that happens to contain a sibling object", () => {
    // The counterpart to the case above: skipping past a closed sibling must not skip past the
    // check itself.
    const file = plant(
      "helpers",
      "sibling-unrestricted.mjs",
      'export const deps = { output: { kind: "ignore" }, stateDir: dir, spawnFire: () => 0 };\n',
    );
    expect(offendersIn(file).join("\n")).toContain("restricts discovery nowhere");
  });

  it("ignores a state directory that discovers nothing, so the rule is precise", () => {
    // A flow tracker, a status computation and a UI fixture all name a state directory and never
    // discover. A coarser rule reported all of them; this one does not.
    const file = plant(
      "helpers",
      "non-host.mjs",
      "export const t = trackerFor({ stateDir: dir, key, flowTracking: {} });\n",
    );
    expect(offendersIn(file)).toEqual([]);
  });

  it("rejects a bare discover, which walks the real home", () => {
    const file = plant("helpers", "bare-discover.ts", "export const found = discover();\n");
    expect(offendersIn(file).join("\n")).toContain("discover(…) with no roots, cwd or host");
  });

  it("accepts a discover given an explicit host, and still rejects one given nothing", () => {
    const good = plant(
      "helpers",
      "host-discover.ts",
      "export const found = discover({ host: { home: h, agentDir: a } });\n",
    );
    expect(offendersIn(good)).toEqual([]);

    const bad = plant("helpers", "host-missing.ts", "export const found = discover({});\n");
    expect(offendersIn(bad).join("\n")).toContain("discover(…) with no roots, cwd or host");
  });

  it("knows where the real directories are", () => {
    // If these ever stop being the real locations, the guards above guard nothing.
    expect(path.join(homedir(), ".agents", "automations")).toContain(".agents");
    expect(path.join(homedir(), ".pi", "agent", "pi-automations")).toContain(".pi");
  });

  it("removes every probe it planted", () => {
    // `afterEach` is what makes the negative controls safe to run in a shared tree. If it ever
    // stopped working, this assertion is the one that notices.
    const strays = readdirSync(testDir, { recursive: true })
      .map(String)
      .filter((f) => f.includes("isolation-probe-"));
    expect(strays).toEqual([]);
  });
});
