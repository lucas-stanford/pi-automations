import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const created: string[] = [];

/** A throwaway directory under the OS temp dir. */
export function tempDir(prefix = "pi-automations-test-"): string {
  return trackTempDir(mkdtempSync(path.join(tmpdir(), prefix)));
}

/**
 * Remove a directory this helper did not make, along with the ones it did.
 *
 * For the throwaway homes made inside a `node:os` mock factory, which cannot import this module,
 * and for directories a test makes beside one of its own.
 */
export function trackTempDir(dir: string): string {
  if (!created.includes(dir)) created.push(dir);
  return dir;
}

/** Stop tracking a directory, so cleanup leaves it alone. */
export function keepTempDir(dir: string): string {
  const at = created.indexOf(dir);
  if (at !== -1) created.splice(at, 1);
  return dir;
}

export function cleanupTempDirs(): void {
  while (created.length) {
    const dir = created.pop();
    if (!dir) continue;
    try {
      // Retried: on Windows a child that has only just exited can still hold a handle.
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // A live handle on Windows is not a test failure.
    }
  }
}

/** A clock that only moves when the test moves it. */
export function fakeClock(startIso: string) {
  let now = new Date(startIso).getTime();
  return {
    now: () => new Date(now),
    iso: () => new Date(now).toISOString(),
    advance(ms: number) {
      now += ms;
    },
    set(iso: string) {
      now = new Date(iso).getTime();
    },
  };
}
