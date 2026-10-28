/** A tick driven through a published default, in a home of its own. */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, kind, key] = process.argv.slice(2);
if (!repo || !kind || !key) {
  process.stderr.write("usage: isolated-tick-host.mjs <repo> <path-kind> <key>\n");
  process.exit(64);
}

const load = (rel) => import(pathToFileURL(path.join(repo, "dist", rel)).href);

const paths = await load("paths.js");
const dir = paths.stateDir();

// Named explicitly as well as set in the environment. The environment is what the worker resolves
// from, so that remains the real proof; naming the roots here keeps the tick deterministic and
// satisfies the suite's isolation guard, which reads call sites.
const roots = paths.userRootsFor(paths.ambientHostRoots());

/** Every record this fixture's state directory holds, newest last. */
function records() {
  const runs = path.join(dir, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs).flatMap((f) =>
    readFileSync(path.join(runs, f), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l)),
  );
}

let summary;
let error = null;
// `serve` reports through its own logger and returns no summary, so collecting the lines is the
// only way to assert what it said.
const serveLog = [];
try {
  if (kind === "root") {
    const m = await load("index.js");
    summary = await m.runTick({ stateDir: dir, roots });

  } else if (kind === "serve") {
    const m = await load("detached/serve.js");
    const stop = new AbortController();
    // The real loop: it ticks, then waits its interval, so aborting during the wait gives one tick.
    const running = m.serve({ stateDir: dir, roots, signal: stop.signal, log: (line) => serveLog.push(String(line)) });
    setTimeout(() => stop.abort(), 2000);
    await running;
    summary = null;
  } else {
    process.stderr.write(`unknown path kind: ${kind}\n`);
    process.exit(64);
  }
} catch (e) {
  error = String(e?.message ?? e);
}

// A record reports that a worker ran; the exit receipt reports that it finished.
const expectWorker = process.env.EXPECT_WORKER !== "0";
const receiptPath = process.env.WORKER_EXIT_RECEIPT ?? null;

const until = (deadline, done) =>
  new Promise((resolve) => {
    const poll = () => {
      const answer = done();
      if (answer !== null || Date.now() >= deadline) return resolve(answer);
      setTimeout(poll, 250);
    };
    poll();
  });

/** Exit lines this process's own children wrote, keyed by the script they were running. */
function receipts(label) {
  if (!receiptPath || !existsSync(receiptPath)) return [];
  return readFileSync(receiptPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .filter((r) => r.label === label);
}

let mine = records().filter((r) => r.key === key);
let worker = null;
let workerExit = null;
let workerGone = null;

if (expectWorker) {
  worker = await until(Date.now() + 40_000, () => {
    mine = records().filter((r) => r.key === key);
    return mine.find((r) => r.outcome !== "missed") ?? null;
  });

  // Its own exit, not merely the absence of further writing.
  workerExit = await until(Date.now() + 20_000, () => receipts("fire.js")[0] ?? null);
  const pid = workerExit?.pid;
  if (Number.isInteger(pid) && pid > 0) {
    workerGone = await until(Date.now() + 20_000, () => {
      try {
        process.kill(pid, 0);
        return null;
      } catch (e) {
        // ESRCH is the only error that means "no such process". EPERM means it is alive and owned
        // by somebody else, and anything else is a fault in the check rather than proof.
        if (e?.code === "ESRCH") return true;
        if (e?.code === "EPERM") return null;
        return { error: String(e?.code ?? e) };
      }
    });
  }
}
process.stdout.write(
  `${JSON.stringify({
    kind,
    stateDir: dir,
    error,
    serveLog,
    summary: summary
      ? {
          fired: summary.fired,
          failed: summary.failed,
          uncertain: summary.uncertain,
          missed: summary.missed,
          checked: summary.checked ?? [],
        }
      : null,
    // The worker's own record, separated from the tick's catch-up rows.
    worker: worker ? { key: worker.key, outcome: worker.outcome, reason: worker.reason ?? null, scheduledFor: worker.scheduledFor ?? null, trigger: worker.trigger ?? null } : null,
    workerRecords: mine.filter((r) => r.outcome !== "missed").length,
    workerExit,
    // true only for an observed ESRCH; null when it could not be established.
    workerGone: workerGone === true ? true : null,
    workerGoneDetail: workerGone && workerGone !== true ? workerGone : null,
    missed: mine.filter((r) => r.outcome === "missed").length,
    records: mine.map((r) => ({ key: r.key, outcome: r.outcome, reason: r.reason ?? null, scheduledFor: r.scheduledFor ?? null })),
  })}\n`,
);
