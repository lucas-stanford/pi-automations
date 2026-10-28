/**
 * A runtime with no SDK behind it: the worked example from docs/PROVIDERS.md. Type-checked against
 * the real contracts by `npm run typecheck`.
 *
 * @import { AutomationRuntime, RuntimeSessionStart, SessionParseResult,
 *           TranscriptDecoder } from "../../src/core/contracts.js"
 * @import { SessionHandle } from "../../src/run.js"
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export const PORTABLE_FORMAT = "portable/v1";

/**
 * One line per entry: `<kind> <text>`. Deliberately not JSON, so a pi decoder cannot read it.
 *
 * @type {TranscriptDecoder}
 */
export const decodePortableTranscript = (text) => {
  /** @type {SessionParseResult["lines"]} */
  const lines = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf(" ");
    const kind = at === -1 ? "text" : line.slice(0, at);
    const body = at === -1 ? line : line.slice(at + 1);
    lines.push({ kind: kind === "user" ? "user" : "text", text: body });
  }
  return { lines };
};

/**
 * @param {{ sessionDir: string, answers?: string[], fail?: string, stall?: boolean,
 *           gateFile?: string }} opts
 * @returns {AutomationRuntime}
 */
export function portableRuntime(opts) {
  const answers = opts.answers ?? [];
  let asked = 0;

  return {
    resolveModel: async () =>
      Object.freeze({ provider: "fixture", id: "portable", display: "fixture/portable" }),

    /** @param {RuntimeSessionStart} start @returns {Promise<SessionHandle>} */
    startSession: async (start) => {
      mkdirSync(opts.sessionDir, { recursive: true });
      const file = path.join(opts.sessionDir, "portable.log");
      appendFileSync(file, `# portable session\nuser ${path.basename(start.cwd)}\n`, "utf8");

      return {
        file,
        id: "portable-session",
        format: PORTABLE_FORMAT,
        prompt: async (text) => {
          appendFileSync(file, `user ${text.split("\n")[0]?.slice(0, 80) ?? ""}\n`, "utf8");
          if (opts.fail) throw new Error(opts.fail);
          // The gate is held INSIDE the run, so it is reached only after the lifecycle has taken
          // the run lock. Bounded: a test that never releases it fails rather than hanging.
          if (opts.gateFile) {
            const deadline = Date.now() + 60_000;
            while (!existsSync(opts.gateFile)) {
              if (Date.now() > deadline) throw new Error("portable gate was never released");
              await new Promise((r) => setTimeout(r, 25));
            }
          }
          if (opts.stall) await new Promise((r) => setTimeout(r, 2_500));
          const answer = answers[asked++] ?? "done";
          appendFileSync(file, `text ${answer}\n`, "utf8");
          return answer;
        },
        dispose: () => {},
      };
    },
  };
}
