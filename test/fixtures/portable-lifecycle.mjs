#!/usr/bin/env node
/** The portable lifecycle, run in a child so the SDK denial is a real module denial. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const [mode, base] = process.argv.slice(2);
if (!mode || !base) {
  process.stderr.write("usage: portable-lifecycle.mjs <mode> <dir>\n");
  process.exit(64);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

/** The controls. */
if (mode === "control-bare" || mode === "control-url" || mode === "control-missing") {
  let target;
  if (mode === "control-bare") target = "@earendil-works/pi-coding-agent";
  else if (mode === "control-missing") target = "a-package-that-does-not-exist-9f2b";
  else {
    const entry = process.env.PORTABLE_SDK_ENTRY;
    if (!entry) {
      process.stderr.write("control-url requires PORTABLE_SDK_ENTRY (the real installed entry)\n");
      process.exit(64);
    }
    target = pathToFileURL(entry).href;
  }

  try {
    await import(target);
    out({ mode, denied: false, note: "the import SUCCEEDED — the denial is not in force" });
    process.exit(1);
  } catch (e) {
    const message = String(e?.message ?? e);
    out({
      mode,
      target,
      denied: message.includes("PORTABLE-SDK-DENIED-8f3a1c"),
      hook: message.includes("refused to resolve") ? "resolve" : message.includes("refused to load") ? "load" : null,
      code: e?.code ?? null,
      message: message.slice(0, 200),
    });
    process.exit(0);
  }
}

const core = await import("../../dist/core/index.js");
const { portableRuntime, decodePortableTranscript, PORTABLE_FORMAT } = await import("./portable-runtime.mjs");

const stateDir = path.join(base, "state");
const root = path.join(base, "roots");
mkdirSync(stateDir, { recursive: true });

/** ONE reader pair, used for this host's own transcripts AND for pi's. */
const readers = {
  legacy: core.parseSessionLines,
  alternative: { format: PORTABLE_FORMAT, decode: decodePortableTranscript },
};

if (mode === "decode") {
  const piFixture = path.join(base, "legacy.jsonl");
  writeFileSync(
    piFixture,
    [
      JSON.stringify({ type: "session", id: "legacy-1", timestamp: 1 }),
      JSON.stringify({
        type: "message",
        id: "m",
        timestamp: 2,
        message: { role: "assistant", content: [{ type: "text", text: "from a pi history" }], timestamp: 2 },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const legacy = core.decodeTranscript(readFileSync(piFixture, "utf8"), { file: piFixture, id: "legacy-1" }, readers);
  const unknownEmpty = core.decodeTranscript("", { file: "/nowhere", id: "x", format: "mystery/v9" }, readers);
  const unknownAbsent = core.decodeTranscript("", { file: "/not-there", id: "x", format: "other/v3" }, readers);

  out({
    mode,
    legacyOk: legacy.ok,
    legacyLines: legacy.ok ? legacy.parsed.lines.map((l) => l.text) : null,
    legacyId: legacy.ok ? legacy.parsed.id : null,
    unknownEmpty: unknownEmpty.ok ? null : unknownEmpty.unsupported,
    unknownAbsent: unknownAbsent.ok ? null : unknownAbsent.unsupported,
    diagnostic: core.unsupportedFormatLines("mystery/v9", 80),
  });
  process.exit(0);
}

// ---------------------------------------------------------------- the full manual lifecycle

const dir = path.join(root, "portable");
mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(dir, "AUTOMATION.md"),
  "---\nname: portable\ndescription: A portable automation.\non:\n  manual: true\n---\n\nSay something.\n",
  "utf8",
);

const found = core.discover({ roots: [{ path: root, scope: "user", kind: "agents" }] });
const first = found[0];
if (!first?.ok) {
  process.stderr.write(`fixture did not parse: ${first ? first.error : "not found"}\n`);
  process.exit(65);
}
const located = first.located;
// A person armed it; this host is about running it.
new core.Trust(stateDir).arm(located, core.digestOf(located), {}, new Date(), 0);

const runtime = portableRuntime({
  sessionDir: path.join(base, "sessions"),
  answers: ["the portable answer"],
  ...(mode === "fail" ? { fail: "the portable model refused" } : {}),
  ...(mode === "cancel" ? { stall: true } : {}),
});

const runId = "portable-run-1";

if (mode === "cancel") {
  // Cooperative, by run id: the request is written and the run's own process notices it. Nothing is
  // signalled and no record is written from outside.
  setTimeout(() => {
    try {
      core.requestCancel(stateDir, located.key, runId);
    } catch {
      /* the run may already be gone */
    }
  }, 400);
}

const record = await core.fire(
  located,
  { trigger: "manual", runId, now: () => new Date("2026-09-17T14:00:00.000Z") },
  {
    config: { ...core.DEFAULTS, notifyOnFailed: false },
    stateDir,
    trust: new core.Trust(stateDir),
    state: new core.State(stateDir),
    runtime,
    runScript: core.runLocalScript,
    hookTimeoutMs: 8000,
    // No tracker, no notifier: a host that has neither is an ordinary host.
  },
);

const history = core.readRecords(stateDir, located.key, 10);

// The listing a portable host actually shows: real statuses, rendered by the shared builder.
const now = new Date("2026-09-17T14:00:05.000Z");
const statuses = await core.computeStatuses(found, {
  trust: new core.Trust(stateDir),
  config: { ...core.DEFAULTS, notifyOnFailed: false },
  stateDir,
  now,
});
const listing = core.renderListing(statuses, { home: base, projectRoots: [], width: 100, now });

// The session pane, from the transcript this run really wrote, through the reader pair above.
const read = record.session
  ? core.decodeTranscript(readFileSync(record.session.file, "utf8"), record.session, readers)
  : { ok: false, unsupported: "no session" };
const sessionLines = read.ok
  ? core.buildSessionLines(read.parsed.lines, { width: 80 })
  : core.unsupportedFormatLines(read.unsupported, 80);

out({
  mode,
  outcome: record.outcome,
  reason: record.reason ?? null,
  sessionFormat: record.session?.format ?? null,
  sessionFile: record.session?.file ?? null,
  historyCount: history.length,
  historyOutcome: history[0]?.outcome ?? null,
  summary: core.summaryLine(record, 180),
  statusLine: core.statusLine(statuses, now),
  listing,
  sessionRead: read.ok,
  sessionLines,
  sessionExists: record.session?.file ? existsSync(record.session.file) : false,
});
process.exit(0);
