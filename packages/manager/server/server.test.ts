// @vitest-environment node
// The server over real HTTP, against pi-automations' real host services, on throwaway automation folders.
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createHostServices } from "../../../dist/plugins/host.js";
import { setFlowBlock } from "../../../dist/flow-block.js";
import { appendRecord } from "../../../dist/records.js";
import { digestOf } from "../../../dist/digest.js";
import { discover, located } from "../../../dist/discover.js";
import { Trust } from "../../../dist/trust.js";
import type { HostServices, PluginAction, PluginApi } from "../../../dist/plugins/types.js";
import { MAX_FILE_BYTES, MAX_REQUEST_BYTES, TOKEN_HEADER } from "../src/host/contract";
import plugin from "./plugin";
import { startManagerServer, type ManagerServer } from "./server";

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** pi-automations' identity for an automation, as `paths.key` builds it. */
function automationKey(scope: "user" | "repository", root: string, name: string): string {
  return `${scope}:${path.resolve(root)}:${name}`;
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function automationText(name: string, extra = ""): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} automation`,
    "# keep this comment",
    "model: \"openai/gpt-5:high\"",
    "on:",
    "  # schedule comment",
    '  schedule: "0 7 * * *" # inline schedule',
    "  manual: true # inline manual",
    "hooks:",
    "  pre:",
    "    - script: check.js",
    ...extra.split("\n").filter(Boolean),
    "---",
    "",
    "Say hello.",
    "",
  ].join("\n");
}

function makeAutomation(root: string, name: string, text = automationText(name)): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "AUTOMATION.md"), text);
  writeFileSync(path.join(dir, "check.js"), "console.log('ok')\n");
  return dir;
}

function fixture(opts: { web?: boolean; project?: boolean } = {}) {
  const root = tempDir("manager-");
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent-state");
  const userAgents = path.join(home, ".agents", "automations");
  const userPi = path.join(agentDir, "automations");
  const userDir = makeAutomation(userAgents, "daily");
  makeAutomation(userPi, "pi-daily");
  const projectRoot = path.join(root, "repo");
  let projectDir: string | undefined;
  if (opts.project) {
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    projectDir = makeAutomation(path.join(projectRoot, ".agents", "automations"), "project-daily");
  }
  let webRoot: string | undefined;
  if (opts.web) {
    webRoot = path.join(root, "web");
    mkdirSync(path.join(webRoot, "assets"), { recursive: true });
    writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><html><body>manager</body></html>");
    writeFileSync(path.join(webRoot, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(path.join(webRoot, "style.css"), "body{}\n");
    writeFileSync(path.join(webRoot, "data.json"), "{}\n");
  }
  return { root, home, agentDir, userAgents, userPi, userDir, projectRoot, projectDir, webRoot };
}

type Choices = Awaited<ReturnType<NonNullable<Parameters<typeof createHostServices>[0]["models"]>["choices"]>>;

/** The host services pi-automations hands the plugin, rooted in the fixture. */
function hostFor(f: ReturnType<typeof fixture>, models?: () => Promise<Choices>): HostServices {
  return createHostServices({
    stateDir: path.join(f.agentDir, "pi-automations"),
    home: f.home,
    host: { home: f.home, agentDir: f.agentDir },
    cwd: () => (f.projectDir ? f.projectRoot : f.root),
    ...(models ? { models: { resolver: async () => undefined, choices: models } } : {}),
  });
}

async function start(f = fixture(), extra: { models?: () => Promise<Choices> } = {}) {
  const manager = await startManagerServer({ host: hostFor(f, extra.models), webRoot: f.webRoot ?? null, log: () => undefined });
  return { f, manager };
}

function rawRequest(args: {
  port: number;
  method?: string;
  host?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: args.port,
        method: args.method ?? "GET",
        path: args.path,
        headers: { ...(args.host !== undefined ? { Host: args.host } : {}), ...args.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (args.body !== undefined) req.write(args.body);
    req.end();
  });
}

const host = (s: ManagerServer) => `127.0.0.1:${s.port}`;
const writeHeaders = (s: ManagerServer, extra: Record<string, string> = {}) => ({
  Host: host(s),
  "content-type": "application/json",
  [TOKEN_HEADER]: s.token,
  Origin: s.url,
  "Sec-Fetch-Site": "same-origin",
  ...extra,
});

async function index(manager: ManagerServer) {
  return fetch(`${manager.url}/api/automations`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
}

async function firstId(manager: ManagerServer, name = "daily"): Promise<string> {
  const idx = await index(manager);
  return idx.groups.flatMap((g: any) => g.automations).find((a: any) => a.name === name).id;
}

describe("security", () => {
  it("enforces Host, write token/origin/fetch metadata, methods, size, and no CORS", async () => {
    const { manager } = await start();
    try {
      await expect(rawRequest({ port: manager.port, host: "evil.test", path: "/api/session" }).then((r) => r.status)).resolves.toBe(403);
      await expect(rawRequest({ port: manager.port, host: `127.0.0.1:${manager.port + 1}`, path: "/api/session" }).then((r) => r.status)).resolves.toBe(403);
      await expect(rawRequest({ port: manager.port, host: `localhost:${manager.port}`, path: "/api/session" }).then((r) => r.status)).resolves.toBe(200);
      await expect(rawRequest({ port: manager.port, host: `[::1]:${manager.port}`, path: "/api/session" }).then((r) => r.status)).resolves.toBe(200);

      const id = await firstId(manager);
      const refused: Record<string, string>[] = [
        { Host: host(manager), [TOKEN_HEADER]: manager.token },
        { Host: host(manager), "content-type": "text/plain", [TOKEN_HEADER]: manager.token },
        { Host: host(manager), "content-type": "application/json" },
        { Host: host(manager), "content-type": "application/json", [TOKEN_HEADER]: "bad" },
        writeHeaders(manager, { Origin: "http://evil.test" }),
        writeHeaders(manager, { "Sec-Fetch-Site": "cross-site" }),
      ];
      for (const headers of refused) {
        const r = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers, body: "{}" });
        expect(r.status).toBe(403);
        expect(Object.keys(r.headers).some((h) => h.toLowerCase().startsWith("access-control-"))).toBe(false);
      }

      await expect(rawRequest({ port: manager.port, method: "OPTIONS", host: host(manager), path: "/api/session" }).then((r) => r.status)).resolves.toBe(405);
      await expect(rawRequest({ port: manager.port, method: "DELETE", host: host(manager), path: "/api/session" }).then((r) => r.status)).resolves.toBe(405);
      const huge = await rawRequest({
        port: manager.port,
        method: "POST",
        path: `/api/automations/${id}/compose`,
        headers: writeHeaders(manager),
        body: `{"x":"${"x".repeat(MAX_REQUEST_BYTES + 1)}"}`,
      });
      expect(huge.status).toBe(413);
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("static serving", () => {
  it("serves the built app safely with MIME, cache, CSP and SPA fallback", async () => {
    const { manager } = await start(fixture({ web: true }));
    try {
      const html = await rawRequest({ port: manager.port, host: host(manager), path: "/" });
      expect(html.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(html.headers["cache-control"]).toBe("no-cache");
      expect(html.headers["content-type"]).toContain("text/html");
      const js = await rawRequest({ port: manager.port, host: host(manager), path: "/assets/app.js" });
      expect(js.headers["content-type"]).toContain("javascript");
      expect(js.headers["cache-control"]).toContain("immutable");
      const spa = await rawRequest({ port: manager.port, host: host(manager), path: "/automations/daily.x" });
      expect(spa.status).toBe(200);
      expect(spa.body).toContain("manager");
      const api404 = await rawRequest({ port: manager.port, host: host(manager), path: "/api/unknown" });
      expect(api404.status).toBe(404);
      expect(api404.headers["content-type"]).toContain("application/json");
      for (const p of ["/..%2f..%2fx", "/%00", "/a%5Cb", "/%E0%A4%A"]) {
        const r = await rawRequest({ port: manager.port, host: host(manager), path: p });
        expect(r.status).toBe(400);
      }
    } finally {
      await manager.close();
    }
  });

  it("serves a CSP-protected fallback page without a built app", async () => {
    const { manager } = await start();
    try {
      const r = await rawRequest({ port: manager.port, host: host(manager), path: "/" });
      expect(r.status).toBe(200);
      expect(r.body).toContain("not built");
      expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    } finally {
      await manager.close();
    }
  });
});

describe("APIs and persistence safety", () => {
  it("does not overwrite trust.json written by another process after startup", async () => {
    const f = fixture({ project: true });
    const { manager } = await start(f);
    try {
      const trustFile = path.join(f.agentDir, "pi-automations", "trust.json");
      mkdirSync(path.dirname(trustFile), { recursive: true });
      const key = automationKey("repository", path.join(f.projectRoot, ".agents", "automations"), "project-daily");
      const external = { version: 1, records: { [key]: { key, dir: f.projectDir, repoRoot: f.projectRoot, digest: "sha256:external", armedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", interpreters: {}, files: {} } } };
      writeFileSync(trustFile, JSON.stringify(external));
      await index(manager);
      const after = JSON.parse(readFileSync(trustFile, "utf8"));
      expect(after.records[key]).toBeTruthy();
      expect(after.records[key].digest).toBe("sha256:external");
    } finally {
      await manager.close();
    }
  });

  it("GET index, bundle and files leave the automation folder unchanged", async () => {
    const f = fixture();
    const beforeNames = readdirSync(f.userDir).sort();
    const beforeHashes = Object.fromEntries(beforeNames.map((n) => [n, sha256(readFileSync(path.join(f.userDir, n)))]));
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      await rawRequest({ port: manager.port, host: host(manager), path: "/api/automations" });
      await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}` });
      await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/files?path=` });
      expect(readdirSync(f.userDir).sort()).toEqual(beforeNames);
      expect(Object.fromEntries(beforeNames.map((n) => [n, sha256(readFileSync(path.join(f.userDir, n)))]))).toEqual(beforeHashes);
    } finally {
      await manager.close();
    }
  });

  it("covers compose/save conflicts, invalid drafts, allowInvalid and flow deletion", async () => {
    const f = fixture();
    writeFileSync(path.join(f.userDir, "flow.mmd"), "flowchart TD\n  body[Body]\n");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const both = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: bundle.fields, automationText: bundle.files.automation.text }) });
      expect(both.status).toBe(400);
      const emptyFlow = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ flowText: "   " }) });
      expect(emptyFlow.status).toBe(400);
      const invalidSave = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: "---\nname: wrong\n---\n\nx\n", base: { automation: bundle.files.automation.revision, flow: bundle.files.flow.revision } }) });
      expect(invalidSave.status).toBe(422);
      const conflict = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: bundle.files.automation.text, base: { automation: "sha256:bad", flow: bundle.files.flow.revision } }) });
      expect(conflict.status).toBe(409);
      const allow = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: "---\nname: wrong\n---\n\nx\n", flowText: null, allowInvalid: true, base: { automation: bundle.files.automation.revision, flow: bundle.files.flow.revision } }) });
      expect(allow.status).toBe(200);
      expect(existsSync(path.join(f.userDir, "flow.mmd"))).toBe(false);
    } finally {
      await manager.close();
    }
  });

  it("returns a saved automation to off until it is armed again, user and repository alike, and says so first", async () => {
    const f = fixture({ project: true });
    const stateDir = path.join(f.agentDir, "pi-automations");
    const roots = [
      { path: f.userAgents, scope: "user" as const, kind: "agents" as const },
      { path: path.join(f.projectRoot, ".agents", "automations"), scope: "repository" as const, kind: "agents" as const },
    ];
    const trust = new Trust(stateDir);
    for (const l of located(discover({ roots }))) trust.arm(l, digestOf(l), {}, new Date(), 0);
    const { manager } = await start(f);
    try {
      for (const [name, notice] of [
        ["daily", "Saving changes returns it to off until you arm it again: /automations arm daily."],
        ["project-daily", "Saving changes inside this repository returns it to off until you arm it again: /automations arm project-daily."],
      ] as const) {
        const id = await firstId(manager, name);
        const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
        expect(bundle.summary.state).toBe("armed");
        expect(bundle.notices.map((n: any) => n.message)).toContain(notice);

        const saved = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ fields: { ...bundle.fields, description: "changed description" }, base: { automation: bundle.files.automation.revision, flow: null } }) });
        expect(saved.status).toBe(200);

        const after = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
        expect(after.summary.state).toBe("off");
        expect(after.summary.reason).toBe(`changed since armed: AUTOMATION.md — /automations arm ${name}`);
      }
    } finally {
      await manager.close();
    }
  });

  it("does not write on a no-op save and preserves an AUTOMATION.md BOM when it does write", async () => {
    const f = fixture();
    const file = path.join(f.userDir, "AUTOMATION.md");
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(readFileSync(file))]));
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const before = statSync(file).mtimeMs;
      const noop = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ fields: bundle.fields, base: { automation: bundle.files.automation.revision, flow: null } }) });
      expect(noop.status).toBe(200);
      expect(statSync(file).mtimeMs).toBe(before);
      const changedFields = { ...bundle.fields, description: "changed description" };
      const saved = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ fields: changedFields, base: { automation: bundle.files.automation.revision, flow: null } }) });
      expect(saved.status).toBe(200);
      const raw = readFileSync(file);
      expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    } finally {
      await manager.close();
    }
  });

  it("does not touch an omitted flow.mmd, even with a BOM or non-UTF-8 bytes", async () => {
    const f = fixture();
    const flow = path.join(f.userDir, "flow.mmd");
    const flowBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("flowchart TD\n  body[Body]\n"), Buffer.from([0xff])]);
    writeFileSync(flow, flowBytes);
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      expect(bundle.problems.some((p: any) => p.message.includes("flow.mmd is not UTF-8"))).toBe(true);
      const saved = await rawRequest({
        port: manager.port,
        method: "PUT",
        path: `/api/automations/${id}`,
        headers: writeHeaders(manager),
        body: JSON.stringify({
          fields: { ...bundle.fields, description: "changed without touching flow" },
          base: { automation: bundle.files.automation.revision, flow: bundle.files.flow.revision },
        }),
      });
      expect(saved.status).toBe(200);
      expect(readFileSync(flow)).toEqual(flowBytes);
      // An undecodable flow.mmd cannot be checked, so a draft that leaves it alone reports nothing about it.
      const composed = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: bundle.fields }) });
      expect(composed.status).toBe(200);
      expect(JSON.parse(composed.body).problems.filter((p: any) => p.file === "flow.mmd")).toEqual([]);
    } finally {
      await manager.close();
    }
  });

  it("checks a flow.mmd the draft leaves alone against the file on disk, comments included", async () => {
    const f = fixture();
    const flow = path.join(f.userDir, "flow.mmd");
    writeFileSync(flow, "%% leading comment\nflowchart TD\n  %% pi moves pre0 and body\n  pre0[\"Pick\"] --> body[\"Run\"]\n  body --> check[\"Check\"]\n");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const composed = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: bundle.fields }) });
      expect(composed.status).toBe(200);
      const result = JSON.parse(composed.body);
      expect(result.problems).toEqual([]);
      expect(result.flowText).toBe(readFileSync(flow, "utf8"));
      expect(result.changed.flow).toBe(false);

      // A node that is only named in a comment is still missing.
      writeFileSync(flow, "flowchart TD\n  %% pre0 is driven by pi\n  body[\"Run\"]\n");
      const missing = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: bundle.fields }) });
      expect(JSON.parse(missing.body).problems.map((p: any) => p.message)).toEqual([
        expect.stringContaining('no node "pre0"'),
      ]);
    } finally {
      await manager.close();
    }
  });

  it("bundles flowcharts from AUTOMATION.md, flow.mmd, and warns when both exist", async () => {
    const f = fixture();
    const auto = path.join(f.userDir, "AUTOMATION.md");
    writeFileSync(auto, automationText("daily").replace("Say hello.", "# Daily\n\n```mermaid\nflowchart TD\n  body[Body]\n```\n\nSay hello."));
    writeFileSync(path.join(f.userDir, "flow.mmd"), "flowchart LR\n  old[Old]\n");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const both = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      expect(both.summary.hasFlowFile).toBe(true);
      expect(both.flow.source).toBe("automation");
      expect(both.flow.text).toBe("flowchart TD\n  body[Body]\n");
      expect(both.files.flow.text).toContain("old");
      expect(both.problems.some((p: any) => p.file === "flow.mmd" && p.message.includes("ignored"))).toBe(true);
      rmSync(path.join(f.userDir, "flow.mmd"));
      writeFileSync(auto, automationText("daily"));
      writeFileSync(path.join(f.userDir, "flow.mmd"), "flowchart TD\n  body[Body]\n");
      const legacy = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      expect(legacy.flow.source).toBe("file");
      expect(legacy.flow.text).toBe("flowchart TD\n  body[Body]\n");
    } finally {
      await manager.close();
    }
  });

  it("composes flowcharts into AUTOMATION.md and folds/deletes legacy flow.mmd", async () => {
    const f = fixture();
    const flow = path.join(f.userDir, "flow.mmd");
    writeFileSync(flow, "flowchart TD\n  old[Old]\n");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const chart = "flowchart TD\n  body[Body]\n";
      const composed = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ flowText: chart }) });
      expect(composed.status).toBe(200);
      const result = JSON.parse(composed.body);
      expect(result.automationText).toContain("```mermaid\nflowchart TD\n  body[Body]\n```\n");
      expect(result.flowText).toBe(chart);
      expect(result.flowFileText).toBeNull();
      expect(result.changed.flow).toBe(true);
      expect(result.problems.some((p: any) => p.file === "AUTOMATION.md" && p.message.startsWith("flowchart:"))).toBe(true);

      const withExistingBlock = setFlowBlock(bundle.files.automation.text, "flowchart TD\n  first[First]\n");
      const replaced = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: withExistingBlock, flowText: chart }) });
      expect(JSON.parse(replaced.body).automationText).toContain("flowchart TD\n  body[Body]\n");
      const removed = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: withExistingBlock, flowText: null }) });
      expect(JSON.parse(removed.body).automationText).not.toContain("```mermaid");

      const save = await rawRequest({
        port: manager.port,
        method: "PUT",
        path: `/api/automations/${id}`,
        headers: writeHeaders(manager),
        body: JSON.stringify({ flowText: chart, base: { automation: bundle.files.automation.revision, flow: bundle.files.flow.revision } }),
      });
      expect(save.status).toBe(200);
      expect(readFileSync(path.join(f.userDir, "AUTOMATION.md"), "utf8")).toContain("```mermaid\nflowchart TD\n  body[Body]\n```\n");
      expect(existsSync(flow)).toBe(false);
      const saved = JSON.parse(save.body);
      expect(saved.files.flow).toBeNull();
      expect(saved.flow.source).toBe("automation");
    } finally {
      await manager.close();
    }
  });

  it("still conflicts when flow.mmd changed before a fold-in save", async () => {
    const f = fixture();
    const flow = path.join(f.userDir, "flow.mmd");
    writeFileSync(flow, "flowchart TD\n  old[Old]\n");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      writeFileSync(flow, "flowchart TD\n  changed[Changed]\n");
      const save = await rawRequest({
        port: manager.port,
        method: "PUT",
        path: `/api/automations/${id}`,
        headers: writeHeaders(manager),
        body: JSON.stringify({ flowText: "flowchart TD\n  body[Body]\n", base: { automation: bundle.files.automation.revision, flow: bundle.files.flow.revision } }),
      });
      expect(save.status).toBe(409);
    } finally {
      await manager.close();
    }
  });

  it("reports non-UTF-8 AUTOMATION.md and refuses compose/save instead of writing replacement characters", async () => {
    const f = fixture();
    const file = path.join(f.userDir, "AUTOMATION.md");
    writeFileSync(file, Buffer.concat([Buffer.from(automationText("daily")), Buffer.from([0xff])]));
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      expect(bundle.problems.some((p: any) => p.message.includes("AUTOMATION.md is not UTF-8"))).toBe(true);
      const compose = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: automationText("daily") }) });
      expect(compose.status).toBe(415);
      const save = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: automationText("daily"), base: { automation: bundle.files.automation.revision, flow: null } }) });
      expect(save.status).toBe(415);
      expect(readFileSync(file).includes(0xff)).toBe(true);
    } finally {
      await manager.close();
    }
  });
});

describe("model list", () => {
  const session = (manager: ManagerServer) => fetch(`${manager.url}/api/session`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
  const refresh = (manager: ManagerServer, headers: Record<string, string> = writeHeaders(manager)) =>
    rawRequest({ port: manager.port, method: "POST", path: "/api/models/refresh", headers, body: "{}" });

  it("keeps the newest read when an older one finishes after it", async () => {
    let finishStartup: (value: { enabled: []; available: { value: string; name: string }[] }) => void = () => undefined;
    let reads = 0;
    const models = (): Promise<{ enabled: []; available: { value: string; name: string }[] }> => {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { finishStartup = resolve; });
      return Promise.resolve({ enabled: [], available: [{ value: "xai/grok-4", name: "Grok 4" }] });
    };
    const { manager } = await start(fixture(), { models });
    try {
      // The startup read is still running when someone asks for a fresh list.
      expect((await refresh(manager)).status).toBe(200);
      finishStartup({ enabled: [], available: [{ value: "example/old-model", name: "Old" }] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const values = (await session(manager)).modelList.models.map((m: any) => m.value);
      expect(values).toContain("xai/grok-4");
      expect(values).not.toContain("example/old-model");
    } finally {
      await manager.close();
    }
  });

  it("lists pi's enabled models, then models automations name, then the rest pi can run", async () => {
    let reads = 0;
    const models = async () => {
      reads += 1;
      return reads === 1
        ? {
            enabled: [{ value: "anthropic/claude-opus-4-1", name: "Claude Opus 4.1" }],
            available: [
              { value: "anthropic/claude-opus-4-1", name: "Claude Opus 4.1" },
              { value: "openai/gpt-5", name: "GPT-5" },
              { value: "openai/gpt-4.1", name: "GPT-4.1" },
            ],
          }
        : { enabled: [], available: [{ value: "xai/grok-4", name: "Grok 4" }] };
    };
    const { manager } = await start(fixture(), { models });
    try {
      const info = await session(manager);
      expect(info.modelList.models).toEqual([
        { value: "anthropic/claude-opus-4-1", name: "Claude Opus 4.1", source: "enabled" },
        // The fixture automations name this one; its name comes from the model without the level.
        { value: "openai/gpt-5:high", name: "GPT-5", source: "automation" },
        { value: "openai/gpt-5", name: "GPT-5", source: "available" },
        { value: "openai/gpt-4.1", name: "GPT-4.1", source: "available" },
      ]);
      expect(info.modelList.readAt).toEqual(expect.any(String));
      expect(info.modelList.error).toBeUndefined();

      // Reading pi again needs the write token, like every other POST.
      expect((await refresh(manager, { Host: host(manager), "content-type": "application/json" })).status).toBe(403);
      const refreshed = await refresh(manager);
      expect(refreshed.status).toBe(200);
      expect(JSON.parse(refreshed.body).models.map((m: any) => m.value)).toEqual(["openai/gpt-5:high", "xai/grok-4"]);
      const listed = await fetch(`${manager.url}/api/models`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      expect(listed.models.map((m: any) => m.value)).toEqual(["openai/gpt-5:high", "xai/grok-4"]);
      expect(reads).toBe(2);
    } finally {
      await manager.close();
    }
  });

  it("keeps the last list and says why when a later read fails", async () => {
    let fail = false;
    const models = async () => {
      if (fail) throw new Error("pi needs Node 22.19.0 or newer, and this is Node 20.12.1");
      return { enabled: [], available: [{ value: "openai/gpt-4.1", name: "GPT-4.1" }] };
    };
    const { manager } = await start(fixture(), { models });
    try {
      const before = (await session(manager)).modelList;
      fail = true;
      const after = JSON.parse((await refresh(manager)).body);
      expect(after.error).toBe("pi needs Node 22.19.0 or newer, and this is Node 20.12.1");
      expect(after.readAt).toBe(before.readAt);
      expect(after.models.map((m: any) => m.value)).toEqual(["openai/gpt-5:high", "openai/gpt-4.1"]);
      // A read that works again clears the reason.
      fail = false;
      expect(JSON.parse((await refresh(manager)).body).error).toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  it("offers the automations' own models when pi cannot be read at all", async () => {
    const { manager } = await start(fixture(), { models: async () => { throw new Error("cannot find pi"); } });
    try {
      expect((await session(manager)).modelList).toEqual({
        models: [{ value: "openai/gpt-5:high", source: "automation" }],
        readAt: null,
        error: "cannot find pi",
      });
    } finally {
      await manager.close();
    }
  });
});

describe("compose preservation", () => {
  it("preserves comments, ordering, CRLF, final newline, unchanged body bytes and scalar style", () => {
    const text = [
      "---",
      "name: daily",
      "description: \"Daily test\" # desc",
      "model: 'openai/gpt-5:high'",
      "on:",
      "  # cron comment",
      "  schedule: \"0 7 * * *\" # cron inline",
      "  manual: true # manual inline",
      "hooks:",
      "  pre:",
      "    - prompt: |",
      "        line one",
      "        line two",
      "---",
      "",
      "Body line 1",
      "Body line 2  ",
      "",
    ].join("\r\n");
    const f = fixture();
    writeFileSync(path.join(f.userDir, "AUTOMATION.md"), text);
    return start(f).then(async ({ manager }) => {
      try {
        const id = await firstId(manager);
        const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
        const shuffled = { body: bundle.fields.body, hooks: bundle.fields.hooks, on: bundle.fields.on, enabled: true, timeout: "", model: "", description: "Daily test changed", name: "daily" };
        const composed = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: shuffled }) });
        expect(composed.status).toBe(200);
        const out = JSON.parse(composed.body).automationText as string;
        expect(out).toContain("# cron comment");
        expect(out).toContain("# manual inline");
        expect(out).toContain('description: "Daily test changed" # desc');
        expect(out).toContain("\r\n");
        expect(out.endsWith("\r\n")).toBe(true);
        expect(out).toContain("Body line 2  \r\n");
        expect(out).not.toContain("model:");
      } finally {
        await manager.close();
      }
    });
  });

  it("keeps string schedule shorthand when possible and expands when needed", async () => {
    const f = fixture();
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const keep = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: bundle.fields }) });
      expect(JSON.parse(keep.body).automationText).toContain('schedule: "0 7 * * *"');
      const expandedFields = { ...bundle.fields, on: { ...bundle.fields.on, schedule: { ...bundle.fields.on.schedule, timezone: "UTC" } } };
      const expanded = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: expandedFields }) });
      expect(JSON.parse(expanded.body).automationText).toContain("timezone: UTC");
    } finally {
      await manager.close();
    }
  });

  it("keeps raw frontmatter on no-op/body-only edits and preserves explicit default nodes", async () => {
    const text = [
      "---",
      "name:  daily",
      "description: >",
      "    Folded description",
      "on:",
      "    schedule:",
      "        cron: \"0 7 * * *\"",
      "        timezone: ~ # explicit local",
      "        catch-up: skip # explicit skip",
      "    manual: true",
      "hooks:",
      "    pre:",
      "        - script: \"check.js\" # script comment",
      "---",
      "",
      "Old body",
      "",
    ].join("\n");
    const f = fixture();
    writeFileSync(path.join(f.userDir, "AUTOMATION.md"), text);
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const noop = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: bundle.fields }) });
      expect(JSON.parse(noop.body).automationText).toBe(text);
      const bodyOnly = await rawRequest({
        port: manager.port,
        method: "POST",
        path: `/api/automations/${id}/compose`,
        headers: writeHeaders(manager),
        body: JSON.stringify({ fields: { ...bundle.fields, body: "New body" } }),
      });
      const out = JSON.parse(bodyOnly.body).automationText as string;
      expect(out).toContain("name:  daily");
      expect(out).toContain("catch-up: skip # explicit skip");
      expect(out).toContain("timezone: ~ # explicit local");
      expect(out).toContain("---\n\nNew body\n");
      expect(out).not.toContain("---\n\n\nNew body");
    } finally {
      await manager.close();
    }
  });

  it("returns valid:false for bad field drafts, 422 on save, and writes with allowInvalid", async () => {
    const f = fixture();
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const fields = { ...bundle.fields, on: { ...bundle.fields.on, schedule: { ...bundle.fields.on.schedule, cron: "every morning" } } };
      const composed = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields }) });
      expect(composed.status).toBe(200);
      expect(JSON.parse(composed.body).valid).toBe(false);
      expect(JSON.parse(composed.body).problems[0].field).toBe("on.schedule.cron");
      const save = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ fields, base: { automation: bundle.files.automation.revision, flow: null } }) });
      expect(save.status).toBe(422);
      const forced = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ fields, allowInvalid: true, base: { automation: bundle.files.automation.revision, flow: null } }) });
      expect(forced.status).toBe(200);
      expect(readFileSync(path.join(f.userDir, "AUTOMATION.md"), "utf8")).toContain("every morning");
    } finally {
      await manager.close();
    }
  });

  it("composes four typical automation shapes back unchanged", async () => {
    const names = ["daily-digest", "flow-example", "issue-triage", "pr-review"];
    const shapes = path.join(import.meta.dirname, "fixtures", "shapes");
    for (const name of names) {
      const realFile = path.join(shapes, `${name}.md`);
      const f = fixture();
      rmSync(f.userDir, { recursive: true, force: true });
      const realCopy = path.join(f.userAgents, name);
      mkdirSync(realCopy, { recursive: true });
      writeFileSync(path.join(realCopy, "AUTOMATION.md"), readFileSync(realFile));
      const { manager } = await start(f);
      try {
        const id = await firstId(manager, name);
        const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
        const composed = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ fields: bundle.fields }) });
        expect(composed.status, name).toBe(200);
        const result = JSON.parse(composed.body);
        expect(result.valid, name).toBe(true);
        // Unchanged fields compose to the file exactly as it is on disk.
        expect(result.changed.automation, name).toBe(false);
        expect(result.automationText, name).toBe(readFileSync(realFile, "utf8"));
      } finally {
        await manager.close();
      }
    }
  }, 30_000);
});

describe("file browser", () => {
  it("refuses unsafe paths, skipped dirs, links, binary/NUL/large files and handles BOM/create/conflict", async () => {
    const f = fixture();
    mkdirSync(path.join(f.userDir, "node_modules"), { recursive: true });
    writeFileSync(path.join(f.userDir, "bin.dat"), Buffer.from([0xff, 0xfe, 0xfd]));
    writeFileSync(path.join(f.userDir, "nul.txt"), "a\0b");
    writeFileSync(path.join(f.userDir, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]));
    writeFileSync(path.join(f.userDir, "large.txt"), "x".repeat(MAX_FILE_BYTES + 1));
    const target = path.join(f.root, "outside");
    mkdirSync(target, { recursive: true });
    try { symlinkSync(target, path.join(f.userDir, "junction"), "junction"); } catch { /* Windows policy may refuse */ }
    for (let i = 0; i < 505; i++) writeFileSync(path.join(f.userDir, `many-${String(i).padStart(3, "0")}.txt`), "x");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      for (const p of ["../x", "/abs", "C:/x", "//server/share", "a\\b", "a:b", "CON"]) {
        const r = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}/file?path=${encodeURIComponent(p)}`, headers: writeHeaders(manager), body: JSON.stringify({ text: "x", base: null }) });
        expect(r.status).toBe(400);
      }
      expect((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/files?path=node_modules` })).status).toBe(400);
      if (existsSync(path.join(f.userDir, "junction"))) {
        expect((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/files?path=junction` })).status).toBe(400);
      }
      expect((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/file?path=bin.dat` })).status).toBe(415);
      expect((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/file?path=nul.txt` })).status).toBe(415);
      expect((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/file?path=large.txt` })).status).toBe(413);
      const listing = JSON.parse((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/files?path=` })).body);
      expect(listing.skipped.some((s: any) => s.reason === "entry limit")).toBe(true);
      const bom = JSON.parse((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/file?path=bom.txt` })).body);
      expect(bom.bom).toBe(true);
      const created = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}/file?path=new.txt`, headers: writeHeaders(manager), body: JSON.stringify({ text: "new", base: null, bom: true }) });
      expect(created.status).toBe(200);
      const conflict = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}/file?path=new.txt`, headers: writeHeaders(manager), body: JSON.stringify({ text: "new", base: null }) });
      expect(conflict.status).toBe(409);
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("file browser — spellings of the validated documents", () => {
  it("routes every spelling of AUTOMATION.md and flow.mmd to the validated save, not the file API", async () => {
    const f = fixture();
    writeFileSync(path.join(f.userDir, "flow.mmd"), "flowchart TD\n  body[\"Body\"]\n");
    // A second name for the same bytes: only an identity check can see through it.
    linkSync(path.join(f.userDir, "AUTOMATION.md"), path.join(f.userDir, "alias.md"));
    const before = readFileSync(path.join(f.userDir, "AUTOMATION.md"), "utf8");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const put = (p: string) =>
        rawRequest({
          port: manager.port,
          method: "PUT",
          path: `/api/automations/${id}/file?path=${encodeURIComponent(p)}`,
          headers: writeHeaders(manager),
          body: JSON.stringify({ text: "---\nnot: valid\n---\n", base: null }),
        });

      const monitor = ["AUTOMATION.md", "flow.mmd", "alias.md"];
      if (process.platform === "win32" || process.platform === "darwin") {
        monitor.push("automation.md", "Flow.MMD");
      }
      for (const p of monitor) {
        const r = await put(p);
        expect(r.status, p).toBe(400);
        expect(JSON.parse(r.body).code, p).toBe("use-monitor");
      }

      // Windows drops a trailing dot or space, so these would name AUTOMATION.md there.
      for (const p of ["AUTOMATION.md.", "AUTOMATION.md ", "scripts./x.js"]) {
        const r = await put(p);
        expect(r.status, p).toBe(400);
        expect(JSON.parse(r.body).code, p).toBe("bad-request");
      }

      if (process.platform === "win32" || process.platform === "darwin") {
        for (const p of [".GIT/config", "Node_Modules/x.js"]) {
          const r = await put(p);
          expect(r.status, p).toBe(400);
        }
      }

      expect(readFileSync(path.join(f.userDir, "AUTOMATION.md"), "utf8")).toBe(before);
    } finally {
      await manager.close();
    }
  });

  it("refuses symlinked monitor documents in bundle notices and compose/save", async () => {
    const f = fixture();
    const outside = path.join(f.root, "outside.md");
    writeFileSync(outside, readFileSync(path.join(f.userDir, "AUTOMATION.md")));
    rmSync(path.join(f.userDir, "AUTOMATION.md"));
    try {
      symlinkSync(outside, path.join(f.userDir, "AUTOMATION.md"), "file");
    } catch {
      return;
    }
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      expect(bundle.notices.some((n: any) => n.message.includes("AUTOMATION.md is a symbolic link"))).toBe(true);
      const compose = await rawRequest({ port: manager.port, method: "POST", path: `/api/automations/${id}/compose`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: automationText("daily") }) });
      expect(compose.status).toBe(400);
      expect(JSON.parse(compose.body).error).toContain("symbolic link");
      const save = await rawRequest({ port: manager.port, method: "PUT", path: `/api/automations/${id}`, headers: writeHeaders(manager), body: JSON.stringify({ automationText: automationText("daily"), base: { automation: bundle.files.automation.revision, flow: null } }) });
      expect(save.status).toBe(400);
    } finally {
      await manager.close();
    }
  });
});

describe("document save atomicity", () => {
  it("does not write flow.mmd when saving a new chart", async () => {
    const f = fixture();
    const auto = path.join(f.userDir, "AUTOMATION.md");
    const flow = path.join(f.userDir, "flow.mmd");
    writeFileSync(flow, "flowchart TD\n  body[Body]\n");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const saved = await rawRequest({
        port: manager.port,
        method: "PUT",
        path: `/api/automations/${id}`,
        headers: writeHeaders(manager),
        body: JSON.stringify({
          fields: { ...bundle.fields, description: "changed before flow failure" },
          flowText: "flowchart TD\n  body[Body]\n  post0[Post]\n",
          base: { automation: bundle.files.automation.revision, flow: bundle.files.flow.revision },
        }),
      });
      expect(saved.status).toBe(200);
      expect(readFileSync(auto, "utf8")).toContain("```mermaid\nflowchart TD\n  body[Body]\n  post0[Post]\n```\n");
      expect(existsSync(flow)).toBe(false);
      expect(readdirSync(f.userDir).filter((n) => /\.tmp$/.test(n))).toEqual([]);
    } finally {
      await manager.close();
    }
  });
});

describe("live progress", () => {
  it("answers a running run's progress for its own automation only, and 404 once it has ended", async () => {
    const f = fixture();
    const stateDir = path.join(f.agentDir, "pi-automations");
    const key = automationKey("user", f.userAgents, "daily");
    mkdirSync(path.join(stateDir, "progress"), { recursive: true });
    const at = "2026-10-21T10:00:00.000Z";
    writeFileSync(
      path.join(stateDir, "progress", "run-live.jsonl"),
      [
        { t: "open", run: "run-live", key, name: "daily", at, chart: "flowchart TD\n  body[Body] --> publish[Publish]\n" },
        { t: "next", from: "body", to: "publish", text: "publishing", at },
        { t: "note", text: "Opened [the PR](https://example.com/pr/1)", links: [{ label: "PR", url: "https://example.com/pr/1" }], at },
        { t: "message", text: "PR is up, review it", links: [{ label: "PR", url: "https://example.com/pr/1" }], at },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const r = await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/runs/run-live/progress` });
      expect(r.status).toBe(200);
      const live = JSON.parse(r.body);
      expect(live.steps.map((s: any) => `${s.id}:${s.status}`)).toEqual(["body:done", "publish:active"]);
      expect(live.taken).toEqual([["body", "publish"]]);
      expect(live.notes[0].links).toEqual([{ label: "PR", url: "https://example.com/pr/1" }]);
      expect(live.message).toEqual({ ts: at, text: "PR is up, review it", links: [{ label: "PR", url: "https://example.com/pr/1" }] });
      const other = await firstId(manager, "pi-daily");
      expect((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${other}/runs/run-live/progress` })).status).toBe(404);
      expect((await rawRequest({ port: manager.port, host: host(manager), path: `/api/automations/${id}/runs/run-gone/progress` })).status).toBe(404);
    } finally {
      await manager.close();
    }
  });

  it("carries a finished run's chart, steps, edges, notes and message in the bundle", async () => {
    const f = fixture();
    const stateDir = path.join(f.agentDir, "pi-automations");
    const key = automationKey("user", f.userAgents, "daily");
    const { manager } = await start(f);
    try {
      const id = await firstId(manager);
      const record = {
        id: "run-done", key, name: "daily", scope: "user", root: f.userAgents, trigger: "manual", late: false,
        recordedAt: "2026-10-21T10:01:00.000Z", startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:01:00.000Z", outcome: "ok",
        chart: "flowchart TD\n  body[Body] --> publish[Publish]\n",
        steps: [{ id: "body", label: "Body", status: "done" }, { id: "publish", label: "Publish", status: "done" }],
        taken: [["body", "publish"]],
        notes: [{ ts: "2026-10-21T10:00:30.000Z", text: "Published", links: [{ label: "digest", url: "https://example.com/d" }] }],
        message: { ts: "2026-10-21T10:00:50.000Z", text: "Digest is up", links: [{ label: "digest", url: "https://example.com/d" }] },
        pluginProblems: ["plugin probe: observer broke"],
      };
      appendRecord(stateDir, record as never, { maxLinesPerAutomation: 2000, keepLines: 500 });
      const bundle = await fetch(`${manager.url}/api/automations/${id}`, { headers: { Host: host(manager) } }).then((r) => r.json() as Promise<any>);
      const run = bundle.runs.find((r: any) => r.id === "run-done");
      expect(run).toMatchObject({ chart: record.chart, steps: record.steps, taken: record.taken, notes: record.notes, message: record.message, pluginProblems: record.pluginProblems });
    } finally {
      await manager.close();
    }
  });
});

describe("history", () => {
  function rec(key: string, name: string, root: string, id: string, minute: number, over: Record<string, unknown> = {}) {
    const at = `2026-10-21T10:${String(minute).padStart(2, "0")}:00.000Z`;
    return { id, key, name, scope: "user", root, trigger: "schedule", late: false, recordedAt: at, startedAt: at, endedAt: at, outcome: "ok", ...over };
  }

  async function seeded() {
    const f = fixture();
    const stateDir = path.join(f.agentDir, "pi-automations");
    const daily = automationKey("user", f.userAgents, "daily");
    const piDaily = automationKey("user", f.userPi, "pi-daily");
    const retention = { maxLinesPerAutomation: 2000, keepLines: 500 };
    const message = { ts: "2026-10-21T10:03:00.000Z", text: "Digest is up", links: [{ label: "digest", url: "https://example.com/d" }] };
    appendRecord(stateDir, rec(daily, "daily", f.userAgents, "d1", 1, { output: { text: "first" } }) as never, retention);
    appendRecord(stateDir, rec(piDaily, "pi-daily", f.userPi, "p1", 2, { outcome: "failed", error: { kind: "agent", message: "boom" } }) as never, retention);
    appendRecord(stateDir, rec(daily, "daily", f.userAgents, "d2", 3, { message }) as never, retention);
    appendRecord(stateDir, rec(piDaily, "pi-daily", f.userPi, "p2", 4, { notes: [{ ts: "t", text: "noted", links: [] }] }) as never, retention);
    // A run of an automation that is no longer there is not listed: nothing could open it.
    appendRecord(stateDir, rec(automationKey("user", f.userAgents, "gone"), "gone", f.userAgents, "g1", 5) as never, retention);
    const { manager } = await start(f);
    return { manager, message };
  }

  const get = (manager: ManagerServer, query = "") => rawRequest({ port: manager.port, host: host(manager), path: `/api/history${query}` });

  it("lists every automation's runs newest first, each with its message and the automation it opens", async () => {
    const { manager, message } = await seeded();
    try {
      const r = await get(manager);
      expect(r.status).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      const page = JSON.parse(r.body);
      expect(page.runs.map((x: any) => x.id)).toEqual(["p2", "d2", "p1", "d1"]);
      expect(page).toMatchObject({ limit: 200, more: false });
      const daily = await firstId(manager, "daily");
      expect(page.runs[1]).toMatchObject({ id: "d2", outcome: "ok", message, automation: { id: daily, name: "daily" } });
      expect(page.runs[1].key).toBeUndefined();
      expect(page.runs[2]).toMatchObject({ outcome: "failed", automation: { name: "pi-daily" } });
    } finally {
      await manager.close();
    }
  });

  it("narrows to one automation, one outcome, or runs that left a message or notes, and caps the page", async () => {
    const { manager } = await seeded();
    try {
      const daily = await firstId(manager, "daily");
      const ids = async (query: string) => JSON.parse((await get(manager, query)).body).runs.map((x: any) => x.id);
      expect(await ids(`?automation=${encodeURIComponent(daily)}`)).toEqual(["d2", "d1"]);
      expect(await ids("?outcome=failed")).toEqual(["p1"]);
      expect(await ids("?message=1")).toEqual(["p2", "d2"]);
      const capped = JSON.parse((await get(manager, "?limit=3")).body);
      expect(capped.runs.map((x: any) => x.id)).toEqual(["p2", "d2", "p1"]);
      expect(capped).toMatchObject({ limit: 3, more: true });
    } finally {
      await manager.close();
    }
  });

  it("refuses a bad filter, an unknown automation, and anything but a read", async () => {
    const { manager } = await seeded();
    try {
      for (const query of ["?limit=0", "?limit=501", "?limit=abc", "?outcome=great"]) expect((await get(manager, query)).status, query).toBe(400);
      expect((await get(manager, "?automation=nope.12345678")).status).toBe(404);
      const post = await rawRequest({ port: manager.port, method: "POST", path: "/api/history", headers: writeHeaders(manager), body: "{}" });
      expect(post.status).toBe(404);
      expect((await rawRequest({ port: manager.port, method: "DELETE", host: host(manager), path: "/api/history" })).status).toBe(405);
      expect((await rawRequest({ port: manager.port, host: "evil.test", path: "/api/history" })).status).toBe(403);
    } finally {
      await manager.close();
    }
  });
});

describe("the plugin", () => {
  function apiFor(where: PluginApi["where"], host: HostServices) {
    const actions: PluginAction[] = [];
    const handlers = new Map<string, (e: unknown) => unknown>();
    const api: PluginApi = {
      apiVersion: 1,
      where,
      entry: "manager",
      host,
      on: (event, handler) => void handlers.set(event, handler as (e: unknown) => unknown),
      addAction: (a) => void actions.push(a),
      setRenderer: () => undefined,
      warn: () => undefined,
    };
    return { api, actions, handlers };
  }

  it("does nothing in a worker", async () => {
    const { api, actions, handlers } = apiFor("worker", hostFor(fixture()));
    await plugin.setup(api);
    expect(actions).toEqual([]);
    expect(handlers.size).toBe(0);
  });

  it("adds Edit, which starts one server on first use and points at the automation", async () => {
    const f = fixture();
    const host = hostFor(f);
    const { api, actions, handlers } = apiFor("cli", host);
    await plugin.setup(api);
    expect(actions.map((a) => a.id)).toEqual(["edit"]);
    const edit = actions[0] as PluginAction;
    const index = await host.index();
    const daily = index.groups.flatMap((g) => g.automations).find((a) => a.name === "daily");
    if (!daily) throw new Error("fixture has no daily");
    const target = { key: daily.key, name: "daily", scope: "user" as const, dir: f.userDir, file: path.join(f.userDir, "AUTOMATION.md") };

    const first = await edit.run({ automation: target, where: "cli", open: false });
    const second = await edit.run({ automation: target, where: "cli", open: false });
    try {
      expect(first).toMatchObject({ keepAlive: true });
      const url = new URL((first as { url: string }).url);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toMatch(/^\/automations\/daily\.[0-9a-f]{8}$/);
      // One server for the process: the second Edit reuses it.
      expect(new URL((second as { url: string }).url).port).toBe(url.port);
      const session = await fetch(`${url.origin}/api/session`).then((r) => r.json() as Promise<any>);
      expect(session.apiVersion).toBe(2);
      const page = await fetch(`${url.origin}${url.pathname}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-src 'none'");
    } finally {
      await handlers.get("shutdown")?.(undefined);
    }
    await expect(fetch(`${new URL((first as { url: string }).url).origin}/api/session`)).rejects.toThrow();
  });
});