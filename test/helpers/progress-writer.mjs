#!/usr/bin/env node
// Hammer one run's progress from one process: many `say`s with a small set of request ids, and a
// `next` per branch, as fast as it can.
import { existsSync } from "node:fs";
import path from "node:path";

import { progressNext, progressSay } from "../../dist/progress.js";

const [dir, run, branch, n] = process.argv.slice(2);
const go = path.join(dir, "go");
const deadline = Date.now() + 20_000;
while (!existsSync(go) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
let changed = 0;
for (let i = 0; i < Number(n); i++) {
  if (progressSay(dir, run, { text: `tick ${i % 5}`, node: "gather", requestId: `k${i % 5}` }).changed) changed++;
  if (progressNext(dir, run, { to: "gather", from: branch }).changed) changed++;
}
process.stdout.write(`${JSON.stringify({ changed })}\n`);
