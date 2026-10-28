// The environment a scheduled job gets: an allow-list, never credential-like names.

import { SECRET_NAME } from "../hooks.js";

/** Never written into a job file, nor passed to a hook. */
export { SECRET_NAME };

/** Names that are always safe and always useful to a scheduled process. */
const CARRIED = ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TZ", "SystemRoot", "ComSpec"];

export interface EnvSnapshot {
  vars: Record<string, string>;
  /** Names that were present but deliberately left out. */
  refused: string[];
}

/** The subset of the current environment a job should carry (an allow-list). */
export function snapshotEnv(source: NodeJS.ProcessEnv = process.env): EnvSnapshot {
  const vars: Record<string, string> = {};
  const refused: string[] = [];

  for (const name of CARRIED) {
    const value = source[name];
    if (typeof value !== "string" || value === "") continue;
    if (SECRET_NAME.test(name)) {
      refused.push(name);
      continue;
    }
    vars[name] = value;
  }

  // Report what was excluded so `pa watcher status` can say why a hook cannot see something.
  for (const name of Object.keys(source)) {
    if (SECRET_NAME.test(name)) refused.push(name);
  }

  return { vars, refused: [...new Set(refused)].sort() };
}

/** Assert that no value in a rendered job file looks like a credential. */
export function assertNoSecrets(text: string, source: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(source)) {
    if (!SECRET_NAME.test(name)) continue;
    if (typeof value !== "string" || value.length < 8) continue;
    if (text.includes(value)) {
      throw new Error(`refusing to write a job file containing the value of ${name}`);
    }
  }
}
