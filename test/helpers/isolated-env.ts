/** One owned home for a child that resolves its own paths. */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tempDir } from "./temp.js";
import { armForTest } from "./arm.js";
import { discover, located } from "../../src/discover.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

/** Every variable that can move where a child looks. All are replaced, never inherited. */
const PATH_OVERRIDES = ["HOME", "USERPROFILE", "PI_AGENT_DIR", "PI_HOME", "XDG_CONFIG_HOME"] as const;

export interface IsolatedHome {
  /** The fixture root. Everything the child touches is under here. */
  readonly home: string;
  /** Where `PI_AGENT_DIR` points. */
  readonly agentDir: string;
  /** `<home>/.agents/automations` — where discovery looks. */
  readonly roots: string;
  /** Where the child will resolve its state to. */
  readonly stateDir: string;
  /** A complete environment: the caller's, minus every path override, plus this fixture's. */
  readonly env: NodeJS.ProcessEnv;
  /** A cwd inside the fixture, so a relative path cannot reach the real tree. */
  readonly cwd: string;
}

/** Build an owned home. Nothing is created inside it yet except the directories themselves. */
export function isolatedHome(label = "pi-iso-"): IsolatedHome {
  const home = tempDir(label);
  const agentDir = path.join(home, "owned-agent");

  const roots = path.join(home, ".agents", "automations");
  const cwd = path.join(home, "cwd");
  for (const d of [agentDir, roots, cwd]) mkdirSync(d, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of PATH_OVERRIDES) delete env[k];
  env.HOME = home;
  env.USERPROFILE = home;
  env.PI_AGENT_DIR = agentDir;

  return { home, agentDir, roots, stateDir: path.join(agentDir, "pi-automations"), env, cwd };
}

/** Write one automation into the fixture's discovery root, armed as `pa arm --yes` would arm it. */
export function automationIn(iso: IsolatedHome, name: string, frontmatter: string, files: Record<string, string> = {}): string {
  const dir = path.join(iso.roots, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "AUTOMATION.md"),
    `---\nname: ${name}\ndescription: A test automation.\n${frontmatter}---\n\nDo the thing.\n`,
  );
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(dir, rel), body);
  const l = located(discover({ roots: [{ path: iso.roots, scope: "user", kind: "agents" }] })).find(
    (x) => x.automation.name === name,
  );
  if (l) armForTest(l, iso.stateDir);
  return dir;
}

export interface Resolved {
  readonly stateDir: string;
  readonly agentDir: string;
  readonly host: { readonly home: string; readonly agentDir: string };
  readonly roots: readonly string[];
}

/**
 * Ask the real code where it would go, in a child running under this environment.
 *
 * A separate process, because the answer depends on `process.env` at call time.
 */
export function resolveIn(iso: IsolatedHome): Resolved {
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      "const p=require(process.argv[1]);" +
        // The host a real run builds when nobody passes one.
        "const h=p.ambientHostRoots();" +
        "process.stdout.write(JSON.stringify({stateDir:p.stateDir(),agentDir:p.agentDir(),host:h,roots:p.userRootsFor(h).map(r=>r.path)}))",
      path.join(REPO, "dist", "paths.js"),
    ],
    { encoding: "utf8", env: iso.env, cwd: iso.cwd, windowsHide: true, timeout: 60_000 },
  );
  return JSON.parse(out.trim()) as Resolved;
}

/** Is `p` the fixture itself or beneath it? */
export function within(home: string, p: string): boolean {
  const rel = path.relative(path.resolve(home), path.resolve(p));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).includes("..");
}

/**
 * Refuse to go further unless the child would stay inside the fixture.
 *
 * Both halves: a child can write records into the fixture while discovering automations outside it.
 */
export function proveIsolated(iso: IsolatedHome): Resolved {
  const resolved = resolveIn(iso);
  const inside = (p: string): boolean => within(iso.home, p);

  if (!inside(resolved.stateDir)) {
    throw new Error(`state would resolve OUTSIDE the fixture: ${resolved.stateDir} (home ${iso.home})`);
  }
  for (const r of resolved.roots) {
    if (!inside(r)) throw new Error(`discovery would reach OUTSIDE the fixture: ${r} (home ${iso.home})`);
  }

  if (!inside(resolved.host.home) || !inside(resolved.host.agentDir)) {
    throw new Error(`host would resolve OUTSIDE the fixture: ${JSON.stringify(resolved.host)}`);
  }
  return resolved;
}
