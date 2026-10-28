#!/usr/bin/env node
/** What the OS job runs every minute: remove the job if its package is gone, then run one tick. */
import process from "node:process";

async function main() {
  const { installedPaths, selfUnregister, selfUnregisterReason } = await import(
    "../dist/detached/index.js"
  ).catch(() => ({
    installedPaths: () => undefined,
    selfUnregister: async () => false,
    selfUnregisterReason: () => undefined,
  }));

  const reason = selfUnregisterReason(installedPaths());
  if (reason) {
    await selfUnregister(reason);
    return 0;
  }

  const { createPiServices, runTick, stateDir } = await import("../dist/index.js");
  const services = createPiServices();
  const summary = await runTick({
    stateDir: stateDir(),
    host: services.host,
    spawnFire: services.spawnFire(stateDir()),
    runScript: services.runScript,
    modelResolver: () => services.modelResolver(),
    tickedBy: "job",
  });

  if (summary) {
    const parts = [
      `fired ${summary.fired.length}`,
      // Only when non-zero, so a quiet tick prints the same line as before.
      ...(summary.failed.length ? [`failed ${summary.failed.length}`] : []),
      ...(summary.uncertain.length ? [`uncertain ${summary.uncertain.length}`] : []),
      `missed ${summary.missed.length}`,
      `skipped ${summary.skipped.length}`,
      `swept ${summary.swept.length}`,
      `considered ${summary.considered}`,
      ...(summary.checked?.length ? [`checked ${summary.checked.length}`] : []),
    ];
    process.stdout.write(`${new Date().toISOString()} tick ${parts.join(" · ")}\n`);

    // An uncertain launch has no record, so its reason is printed here.
    for (const u of summary.uncertain) {
      process.stdout.write(`${new Date().toISOString()} tick uncertain ${u.key}: ${u.reason}\n`);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`${new Date().toISOString()} tick failed: ${e?.stack ?? String(e)}\n`);
    process.exit(1);
  });
