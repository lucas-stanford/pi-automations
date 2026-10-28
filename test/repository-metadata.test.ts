import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");

describe("repository review metadata", () => {
  it("marks committed dist output as generated for GitHub review tooling", () => {
    const value = execFileSync(
      "git",
      ["check-attr", "linguist-generated", "--", "dist/index.js"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(value.trim()).toBe("dist/index.js: linguist-generated: true");
  });
});

describe("Pi SDK lifecycle compatibility", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const evidence = JSON.parse(
    readFileSync(path.join(ROOT, "docs", "pi-sdk-lifecycle-matrix.json"), "utf8"),
  );

  it("declares pi as a host-provided peer and keeps evidence for the versions it is tested with", () => {
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(pkg.peerDependencies["@earendil-works/pi-tui"]).toBe("*");
    expect(pkg.dependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(evidence.minimumSupported).toBe(evidence.results[0].sdkVersion);
    expect(evidence.results.map((result: { sdkVersion: string }) => result.sdkVersion)).toEqual([
      "0.84.4",
      "0.85.1",
      "0.99.2",
      "1.2.0",
    ]);
  });

  it("retains the measured replacement and disposal invariants at every endpoint", () => {
    for (const result of evidence.results) {
      expect(result).toMatchObject({
        factoryInvocations: 3,
        newSessionCalls: 2,
        startsOnDisposedInstance: 0,
        shutdowns: 3,
      });
    }
  });

  it("documents the signal-terminated CLI mapping", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("| run process ended by an operating-system signal | `0` |");
  });
});
