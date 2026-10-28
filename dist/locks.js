// File locks. The tick lock stops two ticks evaluating schedules at once; a run lock per
// automation means never two instances. `O_EXCL` makes acquisition one atomic create. A held run
// lock is never queued behind: the tick records `skipped`.
import { closeSync, constants, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, } from "node:fs";
import path from "node:path";
import { ensureDir, slug, statePaths } from "./paths.js";
import { ms } from "./config.js";
import { newRunId } from "./records.js";
/** `EPERM` means the process exists but belongs to someone else, so it is alive. */
export function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        const code = e?.code;
        if (code === "EPERM")
            return true;
        return false;
    }
}
function writeExclusive(file, body) {
    try {
        const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try {
            writeSync(fd, body);
        }
        finally {
            closeSync(fd);
        }
        return true;
    }
    catch {
        return false;
    }
}
function readJsonFile(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
/** Take the tick lock, or undefined when held. A dead or stale lock is replaced. */
export function acquireTickLock(dir, staleMs, now = new Date()) {
    const file = statePaths(dir).tickLock;
    ensureDir(path.dirname(file));
    const body = JSON.stringify({ pid: process.pid, at: now.toISOString() });
    const release = () => {
        try {
            rmSync(file, { force: true });
        }
        catch {
            // Losing the release is survivable — the staleness check reclaims it.
        }
    };
    if (writeExclusive(file, body))
        return release;
    const held = readJsonFile(file);
    const age = held?.at ? now.getTime() - Date.parse(held.at) : Number.POSITIVE_INFINITY;
    const dead = !held || !isAlive(held.pid);
    const old = !Number.isFinite(age) || age > staleMs;
    if (!dead && !old)
        return undefined;
    try {
        rmSync(file, { force: true });
    }
    catch {
        return undefined;
    }
    return writeExclusive(file, body) ? release : undefined;
}
export function runLockFile(dir, key) {
    return path.join(statePaths(dir).locks, `${slug(key)}.lock`);
}
/** Why a short-lived file lock could not be taken. */
export class LockTimeoutError extends Error {
    code = "LOCK_TIMEOUT";
}
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
// Block this thread for `ms`. The critical sections behind these locks are a read and an append.
function sleepSync(ms) {
    Atomics.wait(SLEEPER, 0, 0, ms);
}
/** An unreadable lock this old was left by a writer killed between creating it and filling it. */
const UNREADABLE_STALE_MS = 2_000;
/** A breaker held this long belongs to a process that died inside a few-line critical section. */
const BREAKER_STALE_MS = 5_000;
function sight(file) {
    try {
        const st = statSync(file);
        return { raw: readFileSync(file, "utf8"), mtimeMs: st.mtimeMs, ino: st.ino };
    }
    catch {
        return undefined;
    }
}
function sameLock(a, b) {
    return a.raw === b.raw && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}
function tokenOf(s) {
    try {
        const held = JSON.parse(s?.raw ?? "");
        return typeof held?.token === "string" ? held.token : undefined;
    }
    catch {
        return undefined;
    }
}
// Abandoned: the owner is dead or it is older than `staleMs`. An unreadable lock can only be judged
// by a short age, because a live writer fills it in the same call that creates it.
function isAbandoned(s, staleMs, now) {
    let held;
    try {
        held = JSON.parse(s.raw);
    }
    catch {
        held = undefined;
    }
    if (!held || typeof held !== "object" || typeof held.token !== "string") {
        return now - s.mtimeMs > UNREADABLE_STALE_MS;
    }
    const age = held.at ? now - Date.parse(held.at) : Number.NaN;
    return !isAlive(held.pid ?? 0) || !Number.isFinite(age) || age > staleMs;
}
// Run `fn` holding the breaker, a second `O_EXCL` file that serialises every removal of the lock,
// so a lock judged abandoned cannot be replaced before it is unlinked. False when not acquired.
function withBreaker(file, fn) {
    const breaker = `${file}.break`;
    const until = Date.now() + 2_000;
    for (;;) {
        if (writeExclusive(breaker, String(process.pid)))
            break;
        try {
            if (Date.now() - statSync(breaker).mtimeMs > BREAKER_STALE_MS)
                rmSync(breaker, { force: true });
        }
        catch {
            // Released between the two calls; try again.
        }
        if (Date.now() >= until)
            return false;
        sleepSync(1);
    }
    try {
        fn();
    }
    finally {
        try {
            rmSync(breaker, { force: true });
        }
        catch {
            // Its age breaks it.
        }
    }
    return true;
}
/**
 * Run `fn` while holding a short-lived exclusive lock file, for check-then-write sequences. Unlike
 * the run lock it is waited for briefly. Abandoned locks (dead owner, older than `staleMs`, or
 * unreadable) are broken under the breaker, and only if still the same file.
 */
export function withFileLock(file, fn, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const staleMs = opts.staleMs ?? 30_000;
    ensureDir(path.dirname(file));
    const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token });
    const deadline = Date.now() + timeoutMs;
    let wait = 2;
    for (;;) {
        if (writeExclusive(file, body))
            break;
        const seen = sight(file);
        if (seen && isAbandoned(seen, staleMs, Date.now())) {
            let broke = false;
            withBreaker(file, () => {
                const again = sight(file);
                if (!again || !sameLock(again, seen))
                    return;
                rmSync(file, { force: true });
                broke = true;
            });
            if (broke)
                continue;
        }
        if (Date.now() >= deadline) {
            throw new LockTimeoutError(`could not lock ${path.basename(file)} within ${timeoutMs}ms`);
        }
        sleepSync(wait);
        wait = Math.min(10, wait * 2);
    }
    try {
        return fn();
    }
    finally {
        // Only our own lock: if it was broken as abandoned and someone else holds it now, it is theirs.
        const release = () => {
            if (tokenOf(sight(file)) !== token)
                return;
            try {
                rmSync(file, { force: true });
            }
            catch {
                // Its age reclaims it.
            }
        };
        if (!withBreaker(file, release))
            release();
    }
}
/** Take the run lock for one automation, or report who holds it. */
export function acquireRunLock(dir, info) {
    const file = runLockFile(dir, info.key);
    ensureDir(path.dirname(file));
    const release = () => {
        try {
            rmSync(file, { force: true });
        }
        catch {
            // Same as above: staleness reclaims it.
        }
    };
    if (writeExclusive(file, JSON.stringify(info)))
        return { ok: true, release };
    const held = readRunLock(dir, info.key);
    if (!held) {
        // Unreadable but present — treat it as a lock held by an unknown owner rather than stealing it.
        return {
            ok: false,
            held: {
                pid: 0,
                runId: "unknown",
                key: info.key,
                startedAt: new Date(0).toISOString(),
                timeoutMs: 0,
                postHooks: 0,
                trigger: "schedule",
            },
        };
    }
    return { ok: false, held };
}
export function readRunLock(dir, key) {
    return readJsonFile(runLockFile(dir, key));
}
/** Update the run lock this process holds (temp file plus rename). Owner only; best effort. */
export function updateRunLock(dir, key, patch) {
    const file = runLockFile(dir, key);
    const current = readRunLock(dir, key);
    // Released or swept: do not recreate it, or a finished run would leave a live-looking lock.
    if (!current)
        return false;
    const next = { ...current, ...patch, pid: current.pid, key: current.key };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(next));
        renameSync(tmp, file);
        return true;
    }
    catch {
        try {
            rmSync(tmp, { force: true });
        }
        catch {
            /* nothing useful to do */
        }
        return false;
    }
}
/** Where a stop request for an automation lives. */
export function cancelFile(dir, key) {
    return path.join(statePaths(dir).locks, `${slug(key)}.cancel`);
}
/**
 * Ask the process running this automation to stop, via a file it polls: on Windows SIGTERM kills
 * the child outright. The file names its run, so a late request cannot stop the next run.
 */
export function requestCancel(dir, key, runId) {
    const file = cancelFile(dir, key);
    try {
        ensureDir(path.dirname(file));
        writeFileSync(file, JSON.stringify({ runId, at: new Date().toISOString() }));
        return true;
    }
    catch {
        return false;
    }
}
/** False for a request aimed at a different run, which is cleared. */
export function cancelRequested(dir, key, runId) {
    const file = cancelFile(dir, key);
    const req = readJsonFile(file);
    if (!req)
        return false;
    if (req.runId === runId)
        return true;
    clearCancel(dir, key);
    return false;
}
/** Remove a stop request. The child does this on the way out, whatever the outcome. */
export function clearCancel(dir, key) {
    try {
        rmSync(cancelFile(dir, key), { force: true });
    }
    catch {
        // A leftover flag naming a finished run is ignored by `cancelRequested` anyway.
    }
}
/** Abandoned: the process is gone, or it outlived its timeout plus hook budgets and slack. */
export function isRunLockStale(info, hookTimeoutMs, now) {
    if (!isAlive(info.pid))
        return true;
    const started = Date.parse(info.startedAt);
    if (Number.isNaN(started))
        return true;
    const budget = info.timeoutMs + hookTimeoutMs * (info.postHooks + 1) + 300_000;
    return now.getTime() - started > budget;
}
/** Clear abandoned run locks, writing `aborted: host stopped` for each. */
export function sweepStaleRunLocks(dir, config, now, onRecord) {
    const locksDir = statePaths(dir).locks;
    ensureDir(locksDir);
    const hookTimeoutMs = ms(config, "hookTimeout");
    const written = [];
    let entries;
    try {
        entries = readdirSync(locksDir);
    }
    catch {
        return written;
    }
    for (const name of entries) {
        if (!name.endsWith(".lock") || name === "tick.lock")
            continue;
        const file = path.join(locksDir, name);
        const info = readJsonFile(file);
        if (!info || typeof info.pid !== "number") {
            // Unreadable lock with no owner information — remove it rather than blocking for ever.
            try {
                rmSync(file, { force: true });
            }
            catch {
                /* keep going */
            }
            continue;
        }
        if (!isRunLockStale(info, hookTimeoutMs, now))
            continue;
        try {
            rmSync(file, { force: true });
        }
        catch {
            continue;
        }
        const rec = {
            id: info.runId && info.runId !== "unknown" ? info.runId : newRunId(now),
            key: info.key,
            name: nameFromKey(info.key),
            scope: info.key.startsWith("user:") ? "user" : "repository",
            root: rootFromKey(info.key),
            trigger: info.trigger ?? "schedule",
            late: false,
            recordedAt: now.toISOString(),
            startedAt: info.startedAt,
            endedAt: now.toISOString(),
            outcome: "aborted",
            reason: "host stopped",
            pid: info.pid,
        };
        if (info.scheduledFor)
            rec.scheduledFor = info.scheduledFor;
        onRecord(rec);
        written.push(rec);
    }
    return written;
}
/** `scope:root:name` — the name is everything after the last colon. */
function nameFromKey(key) {
    const i = key.lastIndexOf(":");
    return i === -1 ? key : key.slice(i + 1);
}
/** `scope:root:name` — the root is between the first and last colon. */
function rootFromKey(key) {
    const first = key.indexOf(":");
    const last = key.lastIndexOf(":");
    if (first === -1 || last <= first)
        return "";
    return key.slice(first + 1, last);
}
/** Build the lock payload for a run that is about to start. */
export function runLockInfo(args) {
    const info = {
        pid: args.pid ?? process.pid,
        runId: args.runId,
        key: args.key,
        startedAt: args.now.toISOString(),
        timeoutMs: args.timeoutMs,
        postHooks: args.postHooks,
        trigger: args.trigger,
    };
    if (args.scheduledFor)
        info.scheduledFor = args.scheduledFor;
    return info;
}
//# sourceMappingURL=locks.js.map