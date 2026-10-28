#!/usr/bin/env node
/** Take one file lock many times from one process, and now and then "die" holding it. */
import { closeSync, existsSync, openSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { withFileLock } from "../../dist/locks.js";

const [dir, n, every] = process.argv.slice(2);
const lock = path.join(dir, "hammer.lock");
const marker = path.join(dir, "inside");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const deadline = Date.now() + 20_000;
while (!existsSync(path.join(dir, "go")) && Date.now() < deadline) sleep(5);

let entered = 0;
let overlaps = 0;
for (let i = 1; i <= Number(n); i++) {
  withFileLock(lock, () => {
    entered++;
    let fd;
    try {
      fd = openSync(marker, "wx");
    } catch {
      overlaps++;
      return;
    }
    closeSync(fd);
    sleep(1);
    rmSync(marker, { force: true });
    if (i % Number(every) === 0) {
      // Killed while holding it: the lock stays, owned by a process that is gone.
      writeFileSync(lock, JSON.stringify({ pid: 0, at: new Date().toISOString(), token: `dead-${process.pid}-${i}` }));
    }
  }, { timeoutMs: 30_000 });
}
process.stdout.write(`${JSON.stringify({ entered, overlaps })}\n`);
