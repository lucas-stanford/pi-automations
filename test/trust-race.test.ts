// Consent is shared by every process on the machine: the tick, pi sessions, `pa` and runs. A copy
// that is seconds old must never put back what another process changed since.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { discover, located } from "../src/discover.js";
import { Trust } from "../src/trust.js";
import { cleanupTempDirs, tempDir } from "./helpers/temp.js";

afterAll(cleanupTempDirs);

const NAMES = Array.from({ length: 24 }, (_, i) => `race-${String(i + 1).padStart(2, "0")}`);

function automations(root: string): void {
  for (const name of NAMES) {
    mkdirSync(path.join(root, name), { recursive: true });
    writeFileSync(
      path.join(root, name, "AUTOMATION.md"),
      `---\nname: ${name}\ndescription: Consent race fixture ${name}.\non:\n  manual: true\n---\n\nSay hello.\n`,
    );
  }
}

function run(args: string[]): Promise<{ done: number }> {
  const hammer = path.join(import.meta.dirname, "helpers", "trust-hammer.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hammer, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
  });
}

describe("trust.json shared by many processes", () => {
  it("keeps every arm while tickers load, look around and save at the same time", async () => {
    const dir = tempDir("pa-trust-race-");
    const root = tempDir("pa-trust-race-root-");
    automations(root);
    setTimeout(() => writeFileSync(path.join(dir, "go"), ""), 1500);

    const outs = await Promise.all([
      run([dir, root, "tick", "1500"]),
      run([dir, root, "tick", "1500"]),
      ...[0, 1, 2, 3].map((i) => run([dir, root, "arm", ...NAMES.filter((_, n) => n % 4 === i)])),
    ]);

    expect(outs.slice(2).reduce((a, o) => a + o.done, 0)).toBe(NAMES.length);
    expect(outs[0]!.done + outs[1]!.done).toBeGreaterThan(10);

    const trust = new Trust(dir);
    const now = new Date();
    const lost = located(discover({ roots: [{ path: root, scope: "user", kind: "agents" }] }))
      .filter((l) => !trust.isArmed(l, now))
      .map((l) => l.automation.name);
    expect(lost).toEqual([]);
    // Every writer used its own temporary file, and none was left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 60_000);
});
