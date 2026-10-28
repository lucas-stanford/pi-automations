#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const GLYPH = { done: "✓", active: "▶", waiting: "⏸", failed: "✗", skipped: "↷", interrupted: "‼", pending: "·" };
const args = process.argv.slice(2);

if (args[0] !== "render") {
  process.stderr.write("fake fm: only render\n");
  process.exit(2);
}
if (args.includes("--help")) {
  process.stdout.write("fm render --plan <file|-> --state <file|-> --format svg|text\n");
  process.exit(0);
}

const value = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

if (process.env.FAKE_FM_FAIL) {
  process.stderr.write("fake fm: cannot draw this chart\n");
  process.exit(4);
}

const plan = readFileSync(value("--plan"), "utf8");
const state = JSON.parse(readFileSync(0, "utf8"));
const format = value("--format");
if (process.env.FAKE_FM_LOG) appendFileSync(process.env.FAKE_FM_LOG, `${JSON.stringify({ format, state })}\n`);

const nodes = [];
for (const m of plan.matchAll(/([A-Za-z0-9_]+)\["([^"]*)"\]/g)) {
  if (!nodes.some((n) => n.id === m[1])) nodes.push({ id: m[1], label: m[2] });
}
const width = Number(process.env.FAKE_FM_WIDTH ?? 0);
const lines = nodes.map((n) => `[${n.label} ${GLYPH[state.nodes[n.id]] ?? "?"}]`.padEnd(width, " "));
for (const [a, b] of state.taken ?? []) lines.push(`${a} ==> ${b}`.padEnd(width, " "));

if (format === "svg") process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg"><text>${lines.join(" ")}</text></svg>\n`);
else process.stdout.write(`${lines.join("\n")}\n`);
