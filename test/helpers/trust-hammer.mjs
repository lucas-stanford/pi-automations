#!/usr/bin/env node
// Arm automations one by one as `pa arm --yes` would, or tick like the watcher: load trust.json,
// look around for a while, then save what it saw. Run several at once to race them.
import { existsSync } from "node:fs";
import path from "node:path";

import { digestOf } from "../../dist/digest.js";
import { discover, located } from "../../dist/discover.js";
import { Trust } from "../../dist/trust.js";

const [dir, root, role, ...rest] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const deadline = Date.now() + 20_000;
while (!existsSync(path.join(dir, "go")) && Date.now() < deadline) sleep(5);

const all = located(discover({ roots: [{ path: root, scope: "user", kind: "agents" }] }));
const byName = new Map(all.map((l) => [l.automation.name, l]));
let done = 0;

if (role === "arm") {
  for (const name of rest) {
    const l = byName.get(name);
    new Trust(dir).arm(l, digestOf(l), {}, new Date(), 0);
    done++;
    sleep(20);
  }
} else {
  const until = Date.now() + Number(rest[0]);
  while (Date.now() < until) {
    const trust = new Trust(dir);
    // Discovery and model checks take a while: the window where another process arms.
    sleep(30);
    for (const l of all) trust.touch(l, new Date());
    trust.save();
    done++;
  }
}

process.stdout.write(`${JSON.stringify({ done })}\n`);
