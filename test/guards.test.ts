// Static guards for properties whose failure is silent: a second file in extensions/ stops pi from
// loading the package, and a value import of pi from src/ makes the CLI load the SDK. Each scan has
// a negative control so it cannot pass vacuously.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tempDir } from "./helpers/temp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = path.join(repoRoot, "extensions");
const extensionSrc = readFileSync(
  path.join(repoRoot, "src", "hosts", "pi", "extension.ts"),
  "utf8",
);
export const SCANS = {
  /** The top-level `.ts` files pi will try to load as extensions. */
  extensionFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => e.name);
  },

  /** Files under a source tree that import a VALUE from the pi packages. */
  eagerPeerImports(root: string, files: string[]): string[] {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(path.join(root, f), "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!/^import\s/.test(trimmed)) continue;
        if (!trimmed.includes("@earendil-works")) continue;
        if (trimmed.startsWith("import type ")) continue;
        offenders.push(`${f}: ${trimmed}`);
      }
    }
    return offenders;
  },

  /** Files that reach the SDK directly, bypassing the one lazy loader. */
  bareSdkImports(root: string, files: string[]): string[] {
    return files.filter((f) =>
      /await import\(\s*["']@earendil-works/.test(readFileSync(path.join(root, f), "utf8")),
    );
  },

  /** Files that call the lazy loader. */
  importPiCallers(root: string, files: string[]): string[] {
    return files
      .filter((f) => /\bimportPi\(/.test(readFileSync(path.join(root, f), "utf8")))
      .map((f) => f.replace(/\\/g, "/"))
      .sort();
  },

  /** Files that compose the fire-log filename by hand instead of through `fireLogPath`. */
  handBuiltFireLog(root: string, files: string[]): string[] {
    return files
      .filter((f) => !f.endsWith(path.join("ui", "firelog.ts")))
      .filter((f) => /`fire-\$\{/.test(readFileSync(path.join(root, f), "utf8")))
      .map((f) => path.basename(f));
  },
};

/** Every `.ts` under `src/`, as paths relative to it. */
function srcFiles(): string[] {
  return readdirSync(path.join(repoRoot, "src"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"));
}

/** A throwaway source tree, for proving a scan fails when its target is absent. */
function syntheticTree(files: Record<string, string>): { root: string; names: string[] } {
  const root = tempDir("guards-negative-");
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return { root, names: Object.keys(files) };
}

describe("the extensions directory holds exactly one extension", () => {
  // pi loads EVERY `.ts` directly in the directory named by `pi.extensions` as an extension, and a
  // file that is not one makes pi refuse to start — for the whole package, not just that file.
  it("has no second .ts file for pi to try to load", () => {
    expect(SCANS.extensionFiles(extensionsDir)).toEqual(["automations.ts"]);
  });

  it("declares that directory as the extension root", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      pi?: { extensions?: string[] };
    };
    expect(pkg.pi?.extensions).toEqual(["./extensions"]);
  });

  it("fails on a second .ts, and on a directory with none", () => {
    // Missing-target negatives: the scan must reject BOTH an extra extension and an empty
    // directory. An empty directory passing would mean the scan says nothing when the one file it
    // exists to protect has been deleted or renamed.
    const two = syntheticTree({
      "automations.ts": "export default () => {};\n",
      "helper.ts": "export const x = 1;\n",
    });
    expect(SCANS.extensionFiles(two.root)).not.toEqual(["automations.ts"]);

    const none = syntheticTree({ "README.md": "not an extension\n" });
    expect(SCANS.extensionFiles(none.root)).not.toEqual(["automations.ts"]);
    expect(SCANS.extensionFiles(none.root)).toEqual([]);
  });
});

describe("run output never enters the model's context", () => {
  it("publishes through registerEntryRenderer and appendEntry", () => {
    expect(extensionSrc).toContain("pi.appendEntry<RunEntryData>(RUN_ENTRY_TYPE");
    expect(extensionSrc).toContain("pi.registerEntryRenderer<RunEntryData>(RUN_ENTRY_TYPE");
  });
});

describe("the tick's own spawn path is never reimplemented", () => {
  // A fixture or a helper that rebuilds `fire-<slug(key)>.log` writes to a file nothing reads, and
  // the resulting "no step detail yet" looks like a bug in the reader.
  it("has exactly one definition, and it is not hand-built anywhere", () => {
    expect(SCANS.handBuiltFireLog(path.join(repoRoot, "src"), srcFiles())).toEqual(["paths.ts"]);
  });

  it("fails when no owner composes it, and when a second one does", () => {
    const none = syntheticTree({ "a.ts": "export const p = fireLogPath(dir, key);\n" });
    expect(SCANS.handBuiltFireLog(none.root, none.names)).toEqual([]);

    const two = syntheticTree({
      "paths.ts": "const f = `fire-${slug(key)}.log`;\n",
      "sneaky.ts": "const g = `fire-${slug(key)}.log`;\n",
    });
    expect(SCANS.handBuiltFireLog(two.root, two.names).sort()).toEqual(["paths.ts", "sneaky.ts"]);
  });
});

describe("pi-tui is imported for types only", () => {
  /**
   * `verbatimModuleSyntax` erases `import type`, so a type-only import costs nothing at runtime.
   */
  it("never imports a value from pi-tui", () => {
    const lines = extensionSrc
      .split("\n")
      .filter((l) => l.includes('from "@earendil-works/pi-tui"'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.trim().startsWith("import type ")).toBe(true);
  });

  it("keeps src/ free of pi at module scope", () => {
    // The invariant is that nothing under `src/` LOADS pi when it is imported, so `bin/tick.js` and
    // `bin/fire.js` stay plain node until a run actually needs a model. A doc comment naming the
    // package is harmless; a static value import is not. Assert on imports, not on mentions.
    expect(SCANS.eagerPeerImports(path.join(repoRoot, "src"), srcFiles())).toEqual([]);
  });

  it("loads pi from exactly one place", () => {
    // Every dynamic import of the SDK goes through `pi-module.ts`, because a background run cannot
    // resolve the bare specifier — pi does not install itself beside an extension package. A second
    // call site would be a second chance to get that wrong, silently, on somebody else's machine.
    const root = path.join(repoRoot, "src");
    const files = srcFiles();
    expect(SCANS.bareSdkImports(root, files)).toEqual([]);
    // TWO callers, and only two: `pi-module.ts` defines the loader, and the pi runtime provider is
    // the only module that speaks to the SDK.
    expect(SCANS.importPiCallers(root, files)).toEqual([
      "pi-module.ts",
      "providers/pi/runtime.ts",
    ]);
  });

  it("would notice a value import", () => {
    const mutated = 'import { Key } from "@earendil-works/pi-tui";';
    expect(mutated.trim().startsWith("import type ")).toBe(false);
  });

  it("fails on a value import, and passes a type-only one", () => {
    const bad = syntheticTree({
      "a.ts": 'import { getAgentDir } from "@earendil-works/pi-coding-agent";\nexport const x = 1;\n',
    });
    expect(SCANS.eagerPeerImports(bad.root, bad.names)).toHaveLength(1);

    const good = syntheticTree({
      "a.ts": 'import type { KeyId } from "@earendil-works/pi-tui";\nexport type K = KeyId;\n',
    });
    expect(SCANS.eagerPeerImports(good.root, good.names)).toEqual([]);
  });

  it("fails when the lazy loader's caller set changes in either direction", () => {
    // Missing target: a file that is renamed or deleted silently drops out and the remaining list
    // still looks plausible. Both directions must be caught.
    const missing = syntheticTree({
      "pi-module.ts": "export const importPi = () => 0;\n",
      "providers/pi/runtime.ts": "export const r = 1;\n",
    });
    expect(SCANS.importPiCallers(missing.root, missing.names)).not.toEqual([
      "pi-module.ts",
      "providers/pi/runtime.ts",
    ]);

    const extra = syntheticTree({
      "pi-module.ts": "importPi();\n",
      "providers/pi/runtime.ts": "importPi();\n",
      "sneaky.ts": "importPi();\n",
    });
    expect(SCANS.importPiCallers(extra.root, extra.names)).toEqual([
      "pi-module.ts",
      "providers/pi/runtime.ts",
      "sneaky.ts",
    ]);

    // A caller at a DIFFERENT path with the same file name is a different caller, and the scan must
    // say so rather than reporting a set that happens to read correctly.
    const twin = syntheticTree({
      "pi-module.ts": "importPi();\n",
      "providers/other/runtime.ts": "importPi();\n",
    });
    expect(SCANS.importPiCallers(twin.root, twin.names)).toEqual([
      "pi-module.ts",
      "providers/other/runtime.ts",
    ]);

    const bare = syntheticTree({
      "a.ts": 'const pi = await import("@earendil-works/pi-coding-agent");\n',
    });
    expect(SCANS.bareSdkImports(bare.root, bare.names)).toEqual(["a.ts"]);
  });

});
