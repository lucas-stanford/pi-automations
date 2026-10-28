import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sdkRoot, fixture] = process.argv.slice(2);
assert(sdkRoot && fixture, "usage: sdk-lifecycle-probe.mjs <sdk-root> <extension-fixture>");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-automations-sdk-lifecycle-"));
process.env.PI_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
process.env.HOME = root;
process.env.USERPROFILE = root;
globalThis.fetch = async () => {
  throw new Error("network is forbidden inside the lifecycle probe");
};

const watchdog = setTimeout(() => {
  console.error("offline SDK lifecycle probe exceeded 25 seconds");
  process.exit(124);
}, 25_000);
watchdog.unref();

try {
  const load = (relative) =>
    import(pathToFileURL(path.join(sdkRoot, "dist", "core", relative)).href);
  const { createAgentSessionRuntime } = await load("agent-session-runtime.js");
  const { loadExtensionsCached } = await load(path.join("extensions", "loader.js"));
  const { SessionManager } = await load("session-manager.js");
  const { createEventBus } = await load("event-bus.js");

  const events = [];
  const bus = createEventBus();
  const unsubscribe = bus.on("pi-automations-lifecycle-probe", (event) => events.push(event));
  const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
    const loaded = await loadExtensionsCached([fixture], root, bus);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    const extensionRunner = {
      hasHandlers: (type) => extension.handlers.has(type),
      emit: async (event) => {
        for (const handler of extension.handlers.get(event.type) ?? []) await handler(event, {});
      },
    };
    const session = {
      sessionManager,
      sessionFile: sessionManager.getSessionFile(),
      extensionRunner,
      abort: async () => {},
      dispose: () => loaded.runtime.invalidate(),
    };
    await extensionRunner.emit(sessionStartEvent ?? { type: "session_start", reason: "startup" });
    return { session, services: { cwd: root, agentDir: root }, diagnostics: [] };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: root,
    agentDir: root,
    sessionManager: SessionManager.inMemory(root),
  });
  await runtime.newSession();
  await runtime.newSession();
  await runtime.dispose();
  unsubscribe();

  assert.deepEqual(
    events.filter((event) => event.event === "factory").map((event) => event.instance),
    [1, 2, 3],
  );
  assert.deepEqual(
    events.filter((event) => event.event === "start"),
    [
      { event: "start", instance: 1, disposed: false },
      { event: "start", instance: 2, disposed: false },
      { event: "start", instance: 3, disposed: false },
    ],
  );
  assert.equal(events.filter((event) => event.event === "shutdown").length, 3);

  const report = {
    sdkVersion: JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")).version,
    factoryInvocations: 3,
    newSessionCalls: 2,
    startsOnDisposedInstance: 0,
    shutdowns: 3,
    events,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  clearTimeout(watchdog);
  fs.rmSync(root, { recursive: true });
}
