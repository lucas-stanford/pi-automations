import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  ambientHostRoots,
  findRepoRoot,
  key,
  packageDir,
  repoRoots,
  rootsForRegistered,
  slug,
  tildify,
  userRoots,
  userRootsFor,
} from "../src/paths.js";
import { discover } from "../src/discover.js";
import { piHostContext } from "../src/hosts/pi/compose.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

// A home directory that exists only for this test.
//
// Built rather than borrowed: the point of `userRootsFor` is that a host can say where its user
// automations are, so the test says so too and never touches the operator's.
function makeHome(opts: { agents?: boolean; pi?: boolean } = {}): {
  home: string;
  agentDir: string;
} {
  const home = tempDir("pi-host-home-");
  const agentDir = path.join(home, "agent-dir");
  mkdirSync(agentDir, { recursive: true });
  if (opts.agents !== false) mkdirSync(path.join(home, ".agents", "automations"), { recursive: true });
  if (opts.pi) mkdirSync(path.join(agentDir, "automations"), { recursive: true });
  return { home, agentDir };
}

describe("explicit host roots", () => {
  it("builds the user roots from the directories it is GIVEN, not from this process", () => {
    const h = makeHome({ pi: true });

    const roots = userRootsFor(h);

    expect(roots.map((r) => r.path)).toEqual([
      path.resolve(path.join(h.home, ".agents", "automations")),
      path.resolve(path.join(h.agentDir, "automations")),
    ]);
    // The order and the kind labels are load-bearing: state keys are built from these paths.
    expect(roots.map((r) => r.kind)).toEqual(["agents", "pi"]);
    expect(roots.every((r) => r.scope === "user")).toBe(true);
  });

  it("still filters out directories that do not exist", () => {
    const h = makeHome({ pi: false });
    expect(userRootsFor(h).map((r) => r.kind)).toEqual(["agents"]);

    const empty = makeHome({ agents: false, pi: false });
    expect(userRootsFor(empty)).toEqual([]);
  });

  it("leaves the ambient answer exactly as it was", () => {
    // `userRoots()` is a facade over `userRootsFor`. It must still answer for THIS process.
    expect(userRoots()).toEqual(userRootsFor(ambientHostRoots()));
  });

  it("lets discovery be pointed at an explicit host", () => {
    const h = makeHome();
    const dir = path.join(h.home, ".agents", "automations", "only-mine");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "AUTOMATION.md"),
      "---\nname: only-mine\ndescription: d\non:\n  manual: true\n---\n\nBody.\n",
    );

    const found = discover({ host: h });

    expect(found).toHaveLength(1);
    expect(found[0]?.ok && found[0].located.automation.name).toBe("only-mine");
  });
});

describe("the pi host context", () => {
  it("chooses the defaults in one place, and says what it chose", () => {
    const h = makeHome({ pi: true });

    const ctx = piHostContext(h);

    expect(ctx.host).toEqual(h);
    expect(ctx.stateDir).toBe(path.join(h.agentDir, "pi-automations"));
    expect(ctx.userRoots.map((r) => r.kind)).toEqual(["agents", "pi"]);
  });

  it("derives the state directory from the agent directory, as it always has", () => {
    const h = makeHome();
    expect(piHostContext(h).stateDir.endsWith(path.join("agent-dir", "pi-automations"))).toBe(true);
  });

  it("falls back to this process when told nothing, preserving every current caller", () => {
    const ctx = piHostContext();
    expect(ctx.host).toEqual(ambientHostRoots());
    expect(ctx.userRoots).toEqual(userRoots());
  });

  it("imports nothing from pi", () => {
    // The whole point of injecting the agent directory: `bin/tick.js` must stay plain node.
    // `test/guards.test.ts` enforces this across `src/`; this asserts it for the new module by
    // name, so a value import added here fails with a message that says where.
    const src = readFileSync(
      path.join(import.meta.dirname, "..", "src", "hosts", "pi", "compose.ts"),
      "utf8",
    );
    for (const line of src.split("\n")) {
      const trimmed = line.trim();
      if (!/^import\s/.test(trimmed)) continue;
      expect(trimmed.includes("@earendil-works"), trimmed).toBe(false);
    }
  });
});

/** A repo with automations at two levels, so the walk-up has something to find. */
function makeRepo() {
  const root = tempDir("pi-repo-");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  mkdirSync(path.join(root, ".agents", "automations", "top"), { recursive: true });
  mkdirSync(path.join(root, "packages", "app", ".agents", "automations", "inner"), {
    recursive: true,
  });
  mkdirSync(path.join(root, "packages", "app", ".pi", "automations", "piscoped"), {
    recursive: true,
  });
  return root;
}

describe("findRepoRoot", () => {
  it("finds the directory holding .git from a nested cwd", () => {
    const root = makeRepo();
    expect(findRepoRoot(path.join(root, "packages", "app"))).toBe(path.resolve(root));
  });

  it("treats a .git FILE as a root, because that is a worktree", () => {
    const root = tempDir("pi-worktree-");
    writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere\n");
    expect(findRepoRoot(root)).toBe(path.resolve(root));
  });

  it("returns undefined outside any repository", () => {
    expect(findRepoRoot(tempDir("pi-bare-"))).toBeUndefined();
  });
});

describe("repoRoots", () => {
  it("yields every level between cwd and the git root, nearest first", () => {
    const root = makeRepo();
    const cwd = path.join(root, "packages", "app");
    const { repoRoot, roots } = repoRoots(cwd);

    expect(repoRoot).toBe(path.resolve(root));
    expect(roots.map((r) => r.path)).toEqual([
      path.resolve(path.join(cwd, ".agents", "automations")),
      path.resolve(path.join(cwd, ".pi", "automations")),
      path.resolve(path.join(root, ".agents", "automations")),
    ]);
    expect(roots.every((r) => r.scope === "repository")).toBe(true);
    expect(roots.map((r) => r.kind)).toEqual(["agents", "pi", "agents"]);
  });

  it("filters out directories that do not exist", () => {
    const root = tempDir("pi-empty-repo-");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    expect(repoRoots(root).roots).toEqual([]);
  });

  it("returns no roots at all when there is no repository", () => {
    const dir = tempDir("pi-norepo-");
    mkdirSync(path.join(dir, ".agents", "automations", "x"), { recursive: true });
    expect(repoRoots(dir)).toEqual({ roots: [] });
  });
});

describe("rootsForRegistered", () => {
  it("looks only at the registered root itself, not its parents", () => {
    const root = makeRepo();
    expect(rootsForRegistered(root).map((r) => r.path)).toEqual([
      path.resolve(path.join(root, ".agents", "automations")),
    ]);
  });
});

describe("key", () => {
  it("normalizes the root path so two spellings produce one identity", () => {
    const a = key("user", "/tmp/roots/", "daily-briefing");
    const b = key("user", "/tmp/roots", "daily-briefing");
    expect(a).toBe(b);
  });

  it("separates the scopes", () => {
    expect(key("user", "/r", "x")).not.toBe(key("repository", "/r", "x"));
  });
});

describe("slug", () => {
  it("is filesystem-safe and suffixed with a hash", () => {
    const s = slug("repository:/Users/alice/src/webapp/.agents/automations:stale-pr-nudge");
    expect(s).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(s).not.toMatch(/[/\\:]/);
  });

  it("keeps distinct keys distinct even when the readable part is truncated", () => {
    const long = "x".repeat(200);
    expect(slug(`user:/a:${long}1`)).not.toBe(slug(`user:/a:${long}2`));
  });

  it("is deterministic", () => {
    expect(slug("user:/a:b")).toBe(slug("user:/a:b"));
  });
});

describe("packageDir", () => {
  it("resolves to the package root that holds package.json", () => {
    expect(packageDir()).toBe(path.resolve(process.cwd()));
  });
});

describe("tildify", () => {
  it("substitutes the home prefix and uses forward slashes", () => {
    const home = path.resolve("/home/alice");
    expect(tildify(path.join(home, ".agents", "automations"), home)).toBe("~/.agents/automations");
    expect(tildify(home, home)).toBe("~");
  });

  it("leaves unrelated paths alone", () => {
    const home = path.resolve("/home/alice");
    const other = path.resolve("/srv/shared");
    expect(tildify(other, home)).toBe(other.split(path.sep).join("/"));
  });
});
