import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
function fnv1a(text) {
  let h = 2166136261;
  for (const b of Buffer.from(text, "utf8")) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function managerId(key) {
  const name = key.slice(key.lastIndexOf(":") + 1);
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "automation";
  return `${safe}.${fnv1a(key).toString(16).padStart(8, "0")}`;
}
function editorPath(key) {
  return `/automations/${managerId(key)}`;
}
function openBrowser(url) {
  const [file, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => void 0);
    child.unref();
  } catch {
  }
}
const plugin = {
  name: "manager",
  setup(api) {
    if (api.where === "worker") return;
    let starting;
    const server = () => {
      starting ??= import("./server.js").then(
        ({ startManagerServer, webRootAt }) => startManagerServer({ host: api.host, webRoot: webRootAt(fileURLToPath(new URL("../dist/", import.meta.url))) })
      ).catch((e) => {
        starting = void 0;
        throw e;
      });
      return starting;
    };
    api.addAction({
      id: "edit",
      label: "Edit in the Automation Manager",
      description: "Open it in the Automation Manager, in your browser.",
      async run(ctx) {
        const s = await server();
        const url = ctx.automation ? `${s.url}${editorPath(ctx.automation.key)}` : s.url;
        if (ctx.open) openBrowser(url);
        return { message: `Automation Manager: ${url}`, url, keepAlive: true };
      }
    });
    api.on("shutdown", async () => {
      const s = await starting?.catch(() => void 0);
      starting = void 0;
      await s?.close();
    });
  }
};
export {
  plugin as default,
  managerId as m
};
