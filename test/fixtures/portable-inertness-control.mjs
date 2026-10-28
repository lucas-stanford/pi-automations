/** A module that deliberately does everything the portable core must not. */
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.env.PORTABLE_CONTROL_DIR;
if (!root) throw new Error("PORTABLE_CONTROL_DIR is required");

const named = path.join(root, "named-write.txt");
writeFileSync(named, "named fs import ran\n");
await writeFile(path.join(root, "async-write.txt"), "async fs import ran\n");

// A data read: not a module, so the probe must not excuse it as loader traffic.
readFileSync(path.join(root, "discovered.txt"), "utf8");

// And the same thing wearing a module-ish extension. A classifier that excuses every `.json` by
// name reports this as loader traffic and then claims the import read no data at all.
JSON.parse(readFileSync(path.join(root, "discovered.json"), "utf8"));

// And the same data read from inside a dependency directory. A classifier that excuses whatever
// sits under `node_modules` files this as loader traffic too, which is the broader version of the
// same blind spot: a dependency's `package.json` is loader traffic, its data is not.
JSON.parse(readFileSync(path.join(root, "node_modules", "owned-fake-dep", "settings.json"), "utf8"));

const child = spawnSync(process.execPath, ["-e", "process.stdout.write('child ran')"], {
  encoding: "utf8",
  windowsHide: true,
});
if (child.status !== 0 || child.stdout !== "child ran") throw new Error("control child failed");

// Set and restored, so a before/after snapshot sees nothing.
const key = "PORTABLE_CONTROL_TRANSIENT";
const previous = process.env[key];
process.env[key] = "borrowed during import";
if (previous === undefined) delete process.env[key];
else process.env[key] = previous;

export const controlCompleted = true;
