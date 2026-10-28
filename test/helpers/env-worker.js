#!/usr/bin/env node
/** A bounded worker, for proving what a child of a run actually inherits. */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPORTED = ["AUTOMATION_RUN", "AUTOMATION_NODE", "AUTOMATION_STATE_DIR", "AUTOMATION_NAME", "AUTOMATION_RUN_ID"];

function view(extra) {
  const out = {};
  for (const key of [...REPORTED, ...extra]) {
    out[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
  }
  return out;
}

const extra = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const self = view(extra);

let child = null;
if (process.argv.includes("--spawn-child")) {
  // `fileURLToPath`, not `new URL(...).pathname`.
  const selfPath = fileURLToPath(import.meta.url);

  // No `env` option: the child gets exactly this process's environment, which is what an SDK
  // subagent gets.
  const r = spawnSync(process.execPath, [selfPath, ...extra], {
    encoding: "utf8",
    windowsHide: true,
  });

  // A child that could not start, or whose output cannot be read, is a BROKEN FIXTURE — not a
  // worker that ran and saw nothing. Reporting it as data would let a test assert happily against a
  // process that never existed, so it fails loudly instead.
  if (r.error) {
    process.stderr.write(`child could not start: ${r.error.message}\n`);
    process.exit(21);
  }
  if (r.status !== 0) {
    process.stderr.write(`child exited ${r.status}: ${(r.stderr || "").trim().slice(0, 300)}\n`);
    process.exit(22);
  }
  try {
    const parsed = JSON.parse(r.stdout);
    if (!parsed || typeof parsed.self !== "object" || parsed.self === null) {
      throw new Error("child report has no `self`");
    }
    child = parsed.self;
  } catch (e) {
    process.stderr.write(
      `child output was not a usable report: ${e.message} — ${(r.stdout || "").trim().slice(0, 300)}\n`,
    );
    process.exit(23);
  }
}

process.stdout.write(`${JSON.stringify({ pid: process.pid, self, child })}\n`);
