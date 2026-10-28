// Proves the real pi composition refuses a missing worker script.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [distDir, stateDir, home] = process.argv.slice(2);
if (!distDir || !stateDir || !home) {
  process.stderr.write("usage: missing-script-host.mjs <distDir> <stateDir> <ownedHome>\n");
  process.exit(64);
}

const composeUrl = pathToFileURL(path.join(distDir, "hosts", "pi", "compose.js")).href;
const { createPiServices } = await import(composeUrl);

// Owned explicitly, not merely inherited. Default construction resolves this host's real agent
// directory and user roots, so a run of this file outside an isolating wrapper would otherwise
// build them under the operator's home.
const services = createPiServices({
  home,
  agentDir: path.join(home, "agent"),
});
const entry = services.workerEntry;
const script = entry.args[0];

const ack = await services.spawnFire(stateDir)(["user:probe:missing-script"]);

process.stdout.write(
  `${JSON.stringify({
    // The interpreter exists; the script is the part that is genuinely absent.
    executableExists: existsSync(entry.file),
    scriptExists: existsSync(script),
    script,
    // What it actually resolved, so the caller can prove nothing reached a real home.
    resolved: { host: services.host, stateDir: services.stateDir },
    ack,
  })}\n`,
);
