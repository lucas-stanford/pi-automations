/** Watches one import and reports what it did. */
import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const target = process.argv[2];
const mode = process.argv[3] === "observe" ? "observe" : "enforce";
if (!target) {
  process.stderr.write("usage: portable-import-probe.mjs <module> [observe|enforce]\n");
  process.exit(64);
}

const writes = [];
const spawns = [];
const dataReads = [];
const moduleReads = [];
const envMutations = [];
const chdirs = [];
const modules = [];
const cwdBefore = process.cwd();

/** Paths the loader is allowed to read. */
const loaderPaths = new Set();

/** The calls a module resolver makes while locating a file, as opposed to reading its contents. */
const RESOLUTION_PROBES = new Set([
  "realpathSync", "realpath", "statSync", "stat", "lstatSync", "lstat",
  "accessSync", "access", "readdirSync", "readdir", "opendirSync", "opendir",
]);

function isLoaderRead(name, p) {
  // The loader opens a module by URL and `fs` is asked by path, so both spellings have to be
  // reduced to one before anything is compared — otherwise every module read looks like data.
  let s = String(p);
  if (s.startsWith("file:")) {
    try {
      s = fileURLToPath(s);
    } catch {
      /* not a file URL after all */
    }
  }
  s = s.replace(/\\/g, "/");
  if (loaderPaths.has(s)) return true;
  if (!s.includes("/node_modules/")) return false;

  // Inside a dependency: its manifest, and the probes a resolver makes to find a file, are loader
  // traffic. Reading a dependency's DATA file is not, and is still reported.
  return s.endsWith("/package.json") || RESOLUTION_PROBES.has(name);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const r = nextResolve(specifier, context);
    if (r?.url?.startsWith("file:")) loaderPaths.add(fileURLToPath(r.url).replace(/\\/g, "/"));
    return r;
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("node:")) {
      modules.push(url.replace(/\\/g, "/"));
      if (url.startsWith("file:")) loaderPaths.add(fileURLToPath(url).replace(/\\/g, "/"));
    }
    return nextLoad(url, context);
  },
});

function record(list, what) {
  list.push(what);
  if (mode === "enforce") {
    const e = new Error(`portable core must not ${what}`);
    e.code = "ERR_PORTABLE_SIDE_EFFECT";
    throw e;
  }
}

const WRITERS = [
  "appendFile", "chmod", "chown", "copyFile", "cp", "link", "mkdir", "mkdtemp", "rename", "rm",
  "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile",
];
const READERS = ["access", "lstat", "opendir", "readdir", "readFile", "readlink", "realpath", "stat"];

function wrap(obj, name, kind) {
  const original = obj[name];
  if (typeof original !== "function") return;
  obj[name] = function (...args) {
    const first = String(args[0]);
    if (kind === "write") record(writes, `${name} ${first}`);
    else if (isLoaderRead(name, first)) moduleReads.push(`${name} ${first}`);
    else record(dataReads, `${name} ${first}`);
    return original.apply(this, args);
  };
}

for (const name of WRITERS) {
  wrap(fs, `${name}Sync`, "write");
  wrap(fs, name, "write");
  wrap(fsPromises, name, "write");
}
for (const name of READERS) {
  wrap(fs, `${name}Sync`, "read");
  wrap(fs, name, "read");
  wrap(fsPromises, name, "read");
}

// `open` is write-capable depending on its flags, so it is classified by them.
for (const [obj, name] of [[fs, "openSync"], [fs, "open"], [fsPromises, "open"]]) {
  const original = obj[name];
  if (typeof original !== "function") continue;
  obj[name] = function (...args) {
    const flags = typeof args[1] === "string" ? args[1] : "r";
    const first = String(args[0]);
    if (flags !== "r") record(writes, `${name} ${first}`);
    else if (!isLoaderRead(name, first)) record(dataReads, `${name} ${first}`);
    return original.apply(this, args);
  };
}

const createWriteStream = fs.createWriteStream;
fs.createWriteStream = function (...args) {
  record(writes, `createWriteStream ${String(args[0])}`);
  return createWriteStream.apply(this, args);
};

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  if (typeof original !== "function") continue;
  childProcess[name] = function (...args) {
    record(spawns, `${name} ${String(args[0])}`);
    return original.apply(this, args);
  };
}

const chdir = process.chdir.bind(process);
process.chdir = (dir) => {
  record(chdirs, `chdir ${dir}`);
  return chdir(dir);
};

// The environment, as a recording proxy.
//
// A before/after snapshot cannot see a key that is set and put back during the import, which is
// exactly the shape an "I'll just borrow this for a moment" bug takes.
const realEnv = { ...process.env };
Object.defineProperty(process, "env", {
  configurable: true,
  value: new Proxy(realEnv, {
    set(t, k, v) {
      record(envMutations, `set ${String(k)}`);
      t[k] = v;
      return true;
    },
    deleteProperty(t, k) {
      record(envMutations, `delete ${String(k)}`);
      delete t[k];
      return true;
    },
  }),
});

// The line that made the difference: without it every named import above stays bound to the
// original function and the whole report reads empty.
syncBuiltinESMExports();

let importError = null;
let core;
try {
  core = await import(pathToFileURL(target).href);
} catch (e) {
  importError = { code: e?.code ?? null, message: String(e?.message ?? e) };
}

/** A host, a vendor SDK, or anything whose only job is reaching one of them. */
const FORBIDDEN = [
  "@earendil-works/",
  "/dist/hosts/",
  "/dist/providers/pi/runtime.js",
  // fm draws charts, and only a viewer asks it to: the run path must not even link it.
  "/dist/providers/fm/",
  "/dist/detached/",
  "/dist/notify.js",
  // The pi LOCATOR. A host with no pi must not load pi-location code to run a tick.
  "/dist/pi-module.js",
];

process.stdout.write(
  `${JSON.stringify({
    mode,
    writes,
    spawns,
    dataReads,
    moduleReadCount: moduleReads.length,
    envMutations,
    chdirs,
    moduleCount: modules.length,
    sawCore: modules.some((m) => m.endsWith("/dist/core/index.js")),
    sawLifecycle: modules.some((m) => m.endsWith("/dist/run.js")),
    sawLegacyCodec: modules.some((m) => m.endsWith("/dist/providers/pi/transcript.js")),
    forbiddenModules: modules.filter((m) => FORBIDDEN.some((f) => m.includes(f))),
    cwdChanged: process.cwd() !== cwdBefore,
    importError,
    exports: core ? Object.keys(core).sort() : [],
  })}\n`,
);
