// fm as a renderer: `fm render --plan <file> --state - --format text|svg`. Never throws.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChartRenderState, RenderChart } from "../../core/contracts.js";
import { whichSync } from "../../interpreters.js";

// A script, rather than a binary, is run with this node — how a wrapper or a test stands in for fm.
function command(bin: string): { file: string; args: string[] } {
  return /\.(c|m)?js$/i.test(bin) ? { file: process.execPath, args: [bin] } : { file: bin, args: [] };
}

/** Does this binary draw charts? An older fm has no `render`, and `fm` on PATH may be unrelated. */
export function canRender(bin: string): boolean {
  const c = command(bin);
  try {
    execFileSync(c.file, [...c.args, "render", "--help"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const probed = new Map<string, boolean>();

/**
 * The fm to use: `fmPath`, `FM_BIN`, then PATH; probed once per process. `fmPath` never falls back.
 */
export function findFmRenderer(explicit?: string, opts: { cache?: boolean } = {}): string | undefined {
  const check = (bin: string): boolean => {
    if (opts.cache === false) return canRender(bin);
    const known = probed.get(bin);
    if (known !== undefined) return known;
    const ok = canRender(bin);
    probed.set(bin, ok);
    return ok;
  };
  const resolve = (c: string): string => (path.isAbsolute(c) ? c : (whichSync(c) ?? c));

  if (explicit && explicit.trim() !== "") {
    const bin = resolve(explicit.trim());
    return existsSync(bin) && check(bin) ? bin : undefined;
  }
  for (const c of [process.env.FM_BIN, "fm"]) {
    if (!c || c.trim() === "") continue;
    const bin = resolve(c.trim());
    if (existsSync(bin) && check(bin)) return bin;
  }
  return undefined;
}

/** Forget what was probed. Tests use this. */
export function resetFmRendererCache(): void {
  probed.clear();
}

/** Draw one chart with one fm. */
export function fmRender(
  bin: string,
  args: { plan: string; state: ChartRenderState; format: "text" | "svg"; timeoutMs?: number },
): { text: string } | { problem: string } {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(tmpdir(), "pa-render-"));
    const plan = path.join(dir, "plan.mmd");
    writeFileSync(plan, args.plan, "utf8");
    const c = command(bin);
    const text = execFileSync(
      c.file,
      [...c.args, "render", "--plan", plan, "--state", "-", "--format", args.format],
      {
        input: JSON.stringify(args.state),
        encoding: "utf8",
        windowsHide: true,
        timeout: args.timeoutMs ?? 10_000,
        stdio: ["pipe", "pipe", "pipe"],
        // A chart is a few KB; a runaway one must not fill memory.
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (args.format === "svg" && !text.includes("<svg")) return { problem: "fm render: no <svg> in its output" };
    return { text };
  } catch (e) {
    const stderr = String((e as { stderr?: string | Buffer })?.stderr ?? "").trim();
    return { problem: `fm render: ${stderr.split("\n")[0] || (e as Error)?.message || "failed"}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** A `RenderChart` bound to whichever fm `find` answers with, asked on every call. */
export function fmRenderer(find: () => string | undefined): RenderChart {
  return (args) => {
    const bin = find();
    return bin ? fmRender(bin, args) : { problem: "fm is not installed" };
  };
}
