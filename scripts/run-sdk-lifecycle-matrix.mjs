import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const versions = ["0.84.4", "0.85.1", "0.99.2", "1.2.0"];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-automations-sdk-matrix-"));
const fixture = path.resolve("test/fixtures/sdk-lifecycle-extension.mjs");
const probe = path.resolve("scripts/sdk-lifecycle-probe.mjs");
const npmCli = [
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((candidate) => fs.existsSync(candidate));
assert(npmCli, "npm-cli.js was not found beside the active Node installation");

try {
  const results = versions.map((version) => {
    const prefix = path.join(root, version);
    execFileSync(
      process.execPath,
      [
        npmCli,
        "install",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `@earendil-works/pi-coding-agent@${version}`,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const sdkRoot = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
    const output = execFileSync(process.execPath, [probe, sdkRoot, fixture], {
      encoding: "utf8",
    });
    return JSON.parse(output);
  });

  for (const [index, result] of results.entries()) {
    assert.equal(result.sdkVersion, versions[index]);
    assert.equal(result.factoryInvocations, 3);
    assert.equal(result.newSessionCalls, 2);
    assert.equal(result.startsOnDisposedInstance, 0);
    assert.equal(result.shutdowns, 3);
  }
  process.stdout.write(`${JSON.stringify({ minimumSupported: versions[0], results }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
