import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync, createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { m as managerId } from "./index.js";
import "node:child_process";
import "node:url";
const MANAGER_KIND = "automation-manager";
const API_VERSION = 2;
const TOKEN_HEADER = "x-manager-token";
const MAX_REQUEST_BYTES = 4194304;
const HISTORY_LIMIT = 200;
const HISTORY_MAX = 500;
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin"
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};
const STATUS_OF = {
  "bad-request": 400,
  "not-found": 404,
  conflict: 409,
  invalid: 422,
  "too-large": 413,
  unsupported: 415,
  "use-monitor": 400
};
const OUTCOMES = /* @__PURE__ */ new Set(["ok", "skipped", "failed", "missed", "aborted"]);
const MODEL_READ_WAIT_MS = 5e3;
class HttpError extends Error {
  status;
  code;
  extra;
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
function isHostError(e) {
  return e instanceof Error && typeof e.code === "string" && e.code in STATUS_OF;
}
function withId(s) {
  return { id: managerId(s.key), ...s };
}
function withIds(b) {
  return { ...b, summary: withId(b.summary) };
}
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function safeStaticPath(file) {
  return !(file.includes("\0") || file.includes("\\") || file.split("/").some((p) => p === ".." || p === "") || path.isAbsolute(file));
}
function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
class ManagerApp {
  token = randomBytes(32).toString("hex");
  port = 0;
  catalog = { enabled: [], available: [], used: [], readAt: null };
  catalogRead = null;
  /** Counts reads, so one that finishes after a newer read started cannot overwrite its answer. */
  catalogGen = 0;
  host;
  webRoot;
  log;
  constructor(host, webRoot, log) {
    this.host = host;
    this.webRoot = webRoot;
    this.log = log;
  }
  setPort(port) {
    this.port = port;
  }
  /** Read pi's models again. Never rejects: a failed read keeps the list it had and says why. */
  refreshModels() {
    const gen = ++this.catalogGen;
    const read = (async () => {
      let found;
      try {
        found = await this.host.models();
      } catch (e) {
        found = { ...this.catalog, error: e instanceof Error ? e.message : String(e) };
      }
      if (gen !== this.catalogGen) return;
      if (found.error) {
        this.catalog = { ...this.catalog, used: found.used, error: found.error };
      } else {
        this.catalog = { ...found, readAt: (/* @__PURE__ */ new Date()).toISOString() };
      }
    })();
    this.catalogRead = read;
    return read;
  }
  async handle(req, res) {
    try {
      this.checkHost(req);
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      if (req.method === "OPTIONS") throw new HttpError(405, "bad-request", "method not allowed");
      if (req.method === "POST" || req.method === "PUT") this.checkWriteRequest(req);
      else if (req.method !== "GET") throw new HttpError(405, "bad-request", "method not allowed");
      if (url.pathname === "/api/session" && req.method === "GET") return this.json(res, await this.session());
      if (url.pathname === "/api/models" && req.method === "GET") return this.json(res, await this.modelList());
      if (url.pathname === "/api/models/refresh" && req.method === "POST") {
        await this.refreshModels();
        return this.json(res, await this.modelList());
      }
      if (url.pathname === "/api/automations" && req.method === "GET") return this.json(res, await this.index());
      if (url.pathname === "/api/history" && req.method === "GET") return this.json(res, await this.history(url));
      if (url.pathname.startsWith("/api/automations/")) return await this.automationRoute(req, res, url);
      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "not-found", "not found");
      if (req.method === "GET") return this.staticRoute(res, url);
      throw new HttpError(405, "bad-request", "method not allowed");
    } catch (e) {
      this.error(res, e);
    }
  }
  checkHost(req) {
    const host = req.headers.host;
    const allowed = /* @__PURE__ */ new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]);
    if (!host || !allowed.has(host)) throw new HttpError(403, "forbidden", "forbidden");
  }
  checkWriteRequest(req) {
    const ct = req.headers["content-type"];
    if (typeof ct !== "string" || !ct.toLowerCase().startsWith("application/json")) throw new HttpError(403, "forbidden", "forbidden");
    const got = req.headers[TOKEN_HEADER];
    const token = Array.isArray(got) ? got[0] : got;
    if (!safeEqual(token ?? "", this.token)) throw new HttpError(403, "forbidden", "forbidden");
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      const allowed = /* @__PURE__ */ new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`, `http://[::1]:${this.port}`]);
      if (!allowed.has(origin)) throw new HttpError(403, "forbidden", "forbidden");
    }
    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite !== "same-origin") throw new HttpError(403, "forbidden", "forbidden");
  }
  async readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > MAX_REQUEST_BYTES) throw new HttpError(413, "too-large", "request body is too large");
      chunks.push(b);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "bad-request", "invalid JSON");
    }
  }
  async session() {
    const modelList = await this.modelList();
    return {
      kind: MANAGER_KIND,
      apiVersion: API_VERSION,
      version: this.host.version,
      token: this.token,
      stateDir: this.host.stateDirLabel,
      modelList,
      limits: { maxFileBytes: this.host.maxFileBytes, maxRequestBytes: MAX_REQUEST_BYTES }
    };
  }
  /** pi's enabled models, then models automations name, then everything else pi can run. */
  async modelList() {
    if (this.catalogRead) await Promise.race([this.catalogRead, sleep(MODEL_READ_WAIT_MS)]);
    const c = this.catalog;
    const names = new Map(c.available.map((m) => [m.value, m.name]));
    const nameOf = (value) => names.get(value) ?? names.get(value.replace(/:(off|minimal|low|medium|high|xhigh)$/, ""));
    const models = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (value, source, name) => {
      if (seen.has(value)) return;
      seen.add(value);
      models.push({ value, ...name ? { name } : {}, source });
    };
    for (const m of c.enabled) add(m.value, "enabled", m.name ?? nameOf(m.value));
    for (const m of c.used) add(m, "automation", nameOf(m));
    for (const m of c.available) add(m.value, "available", m.name);
    return { models, readAt: c.readAt, ...c.error ? { error: c.error } : {} };
  }
  async index() {
    const index = await this.host.index();
    return { ...index, groups: index.groups.map((g) => ({ ...g, automations: g.automations.map(withId) })) };
  }
  /** Every automation's runs, newest first. Read only: the filters only narrow what is read. */
  async history(url) {
    const q = url.searchParams;
    const limitText = q.get("limit");
    const limit = limitText === null ? HISTORY_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX) throw new HttpError(400, "bad-request", `limit must be 1 to ${HISTORY_MAX}`);
    const outcome = q.get("outcome") || void 0;
    if (outcome !== void 0 && !OUTCOMES.has(outcome)) throw new HttpError(400, "bad-request", "unknown outcome");
    const automation = q.get("automation") || void 0;
    const key = automation !== void 0 ? await this.keyFor(automation) : void 0;
    const found = await this.host.history({
      ...key !== void 0 ? { key } : {},
      ...outcome !== void 0 ? { outcome } : {},
      withMessage: q.get("message") === "1",
      limit: limit + 1
    });
    const runs = found.slice(0, limit).map(({ key: runKey, name, ...run }) => ({ ...run, automation: { id: managerId(runKey), name } }));
    return { runs, limit, more: found.length > limit };
  }
  /** The automation an id names, by its key. */
  async keyFor(id) {
    const index = await this.host.index();
    const found = index.groups.flatMap((g) => g.automations).find((a) => managerId(a.key) === id);
    if (!found) throw new HttpError(404, "not-found", "automation not found");
    return found.key;
  }
  async automationRoute(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    if (!id) throw new HttpError(404, "not-found", "automation not found");
    const key = await this.keyFor(decodeURIComponent(id));
    const rel = url.searchParams.get("path") ?? "";
    if (parts.length === 3 && req.method === "GET") return this.json(res, withIds(await this.host.bundle(key)));
    if (parts.length === 4 && parts[3] === "compose" && req.method === "POST") {
      return this.json(res, await this.host.compose(key, await this.readBody(req)));
    }
    if (parts.length === 3 && req.method === "PUT") {
      return this.json(res, withIds(await this.host.save(key, await this.readBody(req))));
    }
    if (parts.length === 4 && parts[3] === "files" && req.method === "GET") return this.json(res, await this.host.listFiles(key, rel));
    if (parts.length === 4 && parts[3] === "file" && req.method === "GET") return this.json(res, await this.host.readFile(key, rel));
    if (parts.length === 4 && parts[3] === "file" && req.method === "PUT") {
      const written = await this.host.writeFile(key, rel, await this.readBody(req));
      return this.json(res, { file: written.file, summary: withId(written.summary) });
    }
    if (parts.length === 6 && parts[3] === "runs" && parts[5] === "progress" && req.method === "GET") {
      const progress = this.host.progress(decodeURIComponent(parts[4]));
      if (!progress || progress.key !== key) throw new HttpError(404, "not-found", "that run is not going");
      return this.json(res, progress);
    }
    throw new HttpError(404, "not-found", "not found");
  }
  staticRoute(res, url) {
    if (!this.webRoot) return this.fallbackPage(res);
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "bad-request", "malformed URL escape");
    }
    let file = rel === "/" ? "index.html" : rel.slice(1);
    if (!safeStaticPath(file)) throw new HttpError(400, "bad-request", "invalid static path");
    let full = path.resolve(this.webRoot, ...file.split("/"));
    if (!inside(full, this.webRoot) || !existsSync(full) || !statSync(full).isFile()) {
      full = path.join(this.webRoot, "index.html");
      file = "index.html";
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Security-Policy": CSP,
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache"
    });
    createReadStream(full).pipe(res);
  }
  fallbackPage(res) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Automation Manager</title><style>body{margin:0;background:#0b0b0d;color:#f2f2f3;font:16px Inter,system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:680px;border:1px solid #29292f;border-radius:16px;padding:32px}code{color:#6572dc}.muted{color:#a1a1aa}</style></head><body><main><h1>The Automation Manager's API is running</h1><p class="muted">Its web app is not built. Run <code>npm run build</code> in <code>packages/manager</code>.</p></main></body></html>`;
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Security-Policy": CSP, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
  }
  json(res, data, status = 200) {
    res.writeHead(status, { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }
  error(res, e) {
    if (e instanceof HttpError) return this.json(res, { error: e.message, code: e.code, ...e.extra }, e.status);
    if (isHostError(e)) {
      return this.json(
        res,
        { error: e.message, code: e.code, ...e.problems ? { problems: e.problems } : {}, ...e.current ? { current: e.current } : {} },
        STATUS_OF[e.code]
      );
    }
    this.log(`Automation Manager: internal error: ${e instanceof Error ? e.message : String(e)}`);
    this.json(res, { error: "internal error", code: "internal" }, 500);
  }
}
function webRootAt(dir) {
  return existsSync(path.join(dir, "index.html")) ? path.resolve(dir) : null;
}
async function startManagerServer(opts) {
  const app = new ManagerApp(opts.host, opts.webRoot, opts.log ?? ((line) => process.stderr.write(`${line}
`)));
  void app.refreshModels();
  const server = createServer((req, res) => {
    void app.handle(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not report a port");
  app.setPort(addr.port);
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    token: app.token,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}
export {
  startManagerServer,
  webRootAt
};
