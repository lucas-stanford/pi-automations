/** `pa serve`: ticks in the foreground, for containers and shells with no scheduler. */
import { runPiTick } from "../hosts/pi/tick.js";
export async function serve(opts) {
    const intervalSec = opts.intervalSec ?? 60;
    const log = opts.log ?? ((line) => process.stdout.write(`${line}\n`));
    log(`pa serve — ticking every ${intervalSec}s. Ctrl-C to stop.`);
    while (!opts.signal?.aborted) {
        const started = Date.now();
        try {
            const summary = await runPiTick({
                stateDir: opts.stateDir,
                ...(opts.roots ? { roots: opts.roots } : {}),
                ...(opts.modelResolver ? { modelResolver: opts.modelResolver } : {}),
                ...(opts.spawnFire ? { spawnFire: opts.spawnFire } : {}),
                ...(opts.runScript ? { runScript: opts.runScript } : {}),
                ...(opts.host ? { host: opts.host } : {}),
                tickedBy: "serve",
            });
            // Log failure-only and uncertain-only ticks too.
            if (summary &&
                (summary.fired.length ||
                    summary.failed.length ||
                    summary.uncertain.length ||
                    summary.missed.length ||
                    summary.swept.length)) {
                log([
                    `${new Date().toISOString()} fired ${summary.fired.length}`,
                    ...(summary.failed.length ? [`failed ${summary.failed.length}`] : []),
                    ...(summary.uncertain.length ? [`uncertain ${summary.uncertain.length}`] : []),
                    `missed ${summary.missed.length}`,
                    `swept ${summary.swept.length}`,
                ].join(" · "));
                // An uncertain launch has no record, so its reason is logged here.
                for (const u of summary.uncertain) {
                    log(`${new Date().toISOString()} uncertain ${u.key}: ${u.reason}`);
                }
            }
        }
        catch (e) {
            // A failing tick must not stop the loop; the next minute may well succeed.
            log(`${new Date().toISOString()} tick failed: ${e?.message ?? String(e)}`);
        }
        // Measure from the START of the tick so a slow tick does not make the interval drift.
        const elapsed = Date.now() - started;
        const wait = Math.max(0, intervalSec * 1000 - elapsed);
        if (opts.signal?.aborted)
            break;
        await sleep(wait, opts.signal);
    }
}
function sleep(msValue, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, msValue);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
//# sourceMappingURL=serve.js.map