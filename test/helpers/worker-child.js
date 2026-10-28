#!/usr/bin/env node
/** A tiny worker, for testing the transport. */
import { appendFileSync } from "node:fs";
import process from "node:process";

// The same guard `bin/fire.js` installs, for the same reason: when whoever was reading goes away
// the pipe is torn down and the next write raises EPIPE, which unhandled kills the process mid-run.
// A worker must survive losing its audience.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => {});
}

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);
const num = (name, fallback) => {
  const v = value(name);
  return v === undefined ? fallback : Number(v);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const envName = value("echo-env");
  if (envName) {
    process.stdout.write(`${JSON.stringify({ event: "env", name: envName, value: process.env[envName] ?? null })}\n`);
  }

  const lines = num("lines", 0);
  const gap = num("gap", 0);
  for (let i = 0; i < lines; i++) {
    process.stdout.write(`${JSON.stringify({ event: "line", i })}\n`);
    if (gap > 0) await sleep(gap);
  }

  const err = value("stderr");
  if (err) process.stderr.write(`${err}\n`);

  const sleepMs = num("sleep", 0);
  if (sleepMs > 0) await sleep(sleepMs);

  const touch = value("touch");
  if (touch) appendFileSync(touch, `done ${process.pid}\n`, "utf8");

  if (flag("hang")) {
    // Hold the event loop open for ever. A test that needs this gone kills it explicitly.
    setInterval(() => {}, 1000);
    return;
  }

  process.exit(num("exit", 0));
}

main();
