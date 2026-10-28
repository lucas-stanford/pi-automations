/** Tests leave the temp folder as they found it. */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SELF = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF);

/** A `mkdtemp` whose parent is the OS temp dir, however the call spells it. */
const BARE_TEMP = /mkdtemp(?:Sync)?\(\s*(?:\w+\.)?join\(\s*(?:\w+\.)?tmpdir\(\)/;

/** The files, by path relative to `test/`, that make a temp directory without the helper. */
export function bareTempDirs(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([, text]) => BARE_TEMP.test(text))
    .map(([file]) => file)
    .sort();
}

/** Every script under `test/`, except this file, whose controls spell out bare calls on purpose. */
function testSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(TEST_DIR, { recursive: true }).map(String)) {
    if (!/\.(?:ts|mjs|js)$/.test(rel)) continue;
    const full = path.join(TEST_DIR, rel);
    if (full === SELF) continue;
    out[rel.replace(/\\/g, "/")] = readFileSync(full, "utf8");
  }
  return out;
}

// The only bare calls there may be: the helper itself, and three throwaway homes made inside a
// `node:os` mock factory, which runs before the helper can be imported. Those files hand their home
// to `trackTempDir` when they finish.
const ALLOWED = ["helpers/temp.ts", "pi-host.test.ts", "pi-lifecycle.test.ts", "stale-dist.test.ts"];

describe("test temp directories are always removed", () => {
  it("are made only through helpers/temp.ts", () => {
    expect(bareTempDirs(testSources())).toEqual(ALLOWED);
  });

  it("include the homes the node:os mocks make", () => {
    const sources = testSources();
    for (const file of ALLOWED.filter((f) => f.endsWith(".test.ts"))) {
      expect(sources[file], file).toContain("trackTempDir(FAKE.home)");
    }
  });

  it("are removed after every test file, without each file having to ask", () => {
    const config = readFileSync(path.join(TEST_DIR, "..", "vitest.config.ts"), "utf8");
    expect(config).toContain('setupFiles: ["test/setup/temp.ts"]');
    expect(readFileSync(path.join(TEST_DIR, "setup", "temp.ts"), "utf8")).toContain(
      "afterAll(cleanupTempDirs)",
    );
  });

  it("would notice a bare call however it is spelled, and not the helper", () => {
    // The control: a pattern that matched nothing would make the first case pass vacuously.
    expect(
      bareTempDirs({
        "a.test.ts": 'mkdtempSync(path.join(os.tmpdir(), "x-"))',
        "b.test.ts": 'fs.mkdtempSync(nodePath.join(actual.tmpdir(), "x-"))',
        "c.test.ts": 'await mkdtemp(\n  join(tmpdir(), "x-"),\n)',
        "d.test.ts": 'tempDir("x-")',
        "e.test.ts": 'mkdtempSync(path.join(repoRoot, "node_modules", ".probe-"))',
      }),
    ).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
  });
});
