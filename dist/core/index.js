// The portable entry: no pi, no fm, no side effects on import (see test/architecture.test.ts).
// ---------------------------------------------------------------------------- the lifecycle
export { fire, CANCEL_REASON } from "../run.js";
export { runTick, tick, decideTick, defaultSpawnFire } from "../tick.js";
// `on.watch`: the decisions are pure; running the script uses the same executor as a hook.
export { decideWatch, fingerprint, nextCheckAt, watchDue, } from "../watch.js";
export { runWatchScript, watchEnv } from "../hooks.js";
// A host with hooks must supply an executor; this portable one is offered here.
export { runLocalScript } from "../providers/scripts.js";
// ------------------------------------------------------------------------ what a run is made of
export { discover, located, byKey } from "../discover.js";
export { parseAutomation, splitFrontmatter } from "../parse.js";
export { loadConfig, DEFAULTS, ms } from "../config.js";
export { computeStatuses } from "../status.js";
export { State } from "../state.js";
export { Trust } from "../trust.js";
// What `Trust.arm` pins consent to: a host that arms needs it.
export { digestOf } from "../digest.js";
export { appendFireEvent, appendRecord, readRecords, newRunId } from "../records.js";
export { acquireRunLock, readRunLock, requestCancel, cancelRequested, clearCancel, sweepStaleRunLocks, acquireTickLock, } from "../locks.js";
export { LiveWriter, liveFile } from "../live.js";
export { closeProgress, openProgress, progressMessage, progressNext, progressNote, progressSay, progressStatus, progressStep, progressTracking, readProgress, snapshotFromRecord, ProgressError, } from "../progress.js";
export { parseChart } from "../chart.js";
// --------------------------------------------------------------------------- explicit roots
export { agentDir, ensureDir, fireLogPath, packageDir, setAgentDir, slug, stateDir, statePaths, tildify, userRootsFor, } from "../paths.js";
// ------------------------------------------------------------------ turning state into lines
export { collapseSessionLines, flattenText } from "../transcript-lines.js";
export { buildSessionLines, decodeTranscript, unsupportedFormatLines, } from "../ui/session-view.js";
// pi's transcript layout: a portable host may still read history pi wrote. Loads no SDK.
export { parseSessionLines, piTranscriptReaders } from "../providers/pi/transcript.js";
export { listingModel, renderListing, statusLine } from "../listing.js";
export { summarise, sparkline } from "../ui/sparkline.js";
export { runningFooter, widgetLines } from "../ui/running.js";
export { isRunning, parseFireLine, startingView } from "../ui/run-view.js";
export { readFireLogTail, FIRE_LOG_TAIL_BYTES } from "../ui/firelog.js";
export { newTail, readTail } from "../tail.js";
export { summaryLine, clipLine, clipOutput } from "../summary.js";
//# sourceMappingURL=index.js.map