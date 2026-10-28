/** `dist/` is committed, so it can go stale. */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tempDir } from "./helpers/temp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every emitted file, relative to its outDir, with its bytes. */
function emitted(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      // Source maps embed the outDir path, so they differ for a reason that is not drift.
      if (name.endsWith(".map")) continue;
      out.set(path.relative(dir, full).replace(/\\/g, "/"), readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
}

describe("dist/ is committed and must match src/", () => {
  it("is present, because a git install cannot build it", () => {
    expect(existsSync(path.join(ROOT, "dist", "index.js"))).toBe(true);
  });

  it("is exactly what tsc emits from the current src/", () => {
    const tmp = tempDir("pa-dist-check-");
    try {
      execFileSync(
        process.execPath,
        [
          path.join(ROOT, "node_modules", "typescript", "lib", "tsc.js"),
          "-p",
          path.join(ROOT, "tsconfig.json"),
          "--outDir",
          tmp,
        ],
        { cwd: ROOT, stdio: "pipe" },
      );

      const fresh = emitted(tmp);
      const committed = emitted(path.join(ROOT, "dist"));

      const missing = [...fresh.keys()].filter((f) => !committed.has(f));
      const extra = [...committed.keys()].filter((f) => !fresh.has(f));
      const changed = [...fresh.keys()].filter(
        (f) => committed.has(f) && committed.get(f) !== fresh.get(f),
      );

      const hint = " — run `npm run build` and commit dist/";
      expect(missing, `dist/ is missing files${hint}`).toEqual([]);
      expect(extra, `dist/ has files src/ no longer produces${hint}`).toEqual([]);
      expect(changed, `dist/ is stale${hint}`).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
