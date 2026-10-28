// The pi transcript codec (session files and the live sidecar). Never throws: torn lines and
// unknown entry types are skipped.

import {
  collapseSessionLines,
  flattenText,
  type SessionLine,
  type SessionParseResult,
} from "../../transcript-lines.js";

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** The text of a content array, ignoring everything that is not text. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const b = asRecord(raw);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return flattenText(parts.join(" "));
}

/** The argument that identifies what a tool call acted on; the rest is noise in a small pane. */
export function toolSubject(args: unknown): string {
  const a = asRecord(args);
  if (!a) return "";
  for (const key of ["path", "file", "filePath", "command", "cmd", "url", "query", "pattern", "name"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim() !== "") return flattenText(v);
  }
  for (const v of Object.values(a)) {
    if (typeof v === "string" && v.trim() !== "" && v.length <= 120) return flattenText(v);
  }
  return "";
}

/** Parse complete transcript lines; the caller owns the partial tail. */
export function parseSessionLines(text: string): SessionParseResult {
  const out: SessionLine[] = [];
  let id: string | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;

    let obj: Record<string, unknown> | undefined;
    try {
      obj = asRecord(JSON.parse(line));
    } catch {
      // A half-written line, or something we do not understand. Both are ordinary here.
      continue;
    }
    if (!obj) continue;

    const at = typeof obj.timestamp === "number" ? obj.timestamp : undefined;

    if (obj.type === "session") {
      if (typeof obj.id === "string") id = obj.id;
      continue;
    }

    if (obj.type === "partial") {
      // Successive partials are drafts of the same line; `collapseSessionLines` folds them.
      const t = flattenText(typeof obj.text === "string" ? obj.text : "");
      if (t === "") continue;
      const kind: SessionLine["kind"] = obj.thinking === true ? "thinking" : "partial";
      out.push({ kind, text: t, ...(at ? { at } : {}) });
      continue;
    }

    if (obj.type === "model_change") {
      const provider = typeof obj.provider === "string" ? obj.provider : "";
      const model = typeof obj.modelId === "string" ? obj.modelId : "";
      const both = [provider, model].filter((s) => s !== "").join("/");
      if (both !== "") out.push({ kind: "note", text: `model ${both}`, ...(at ? { at } : {}) });
      continue;
    }

    if (obj.type !== "message") continue;

    const msg = asRecord(obj.message);
    if (!msg) continue;
    const when = typeof msg.timestamp === "number" ? msg.timestamp : at;
    const stamp = when ? { at: when } : {};

    if (msg.role === "user") {
      const t = textOf(msg.content);
      if (t !== "") out.push({ kind: "user", text: t, ...stamp });
      continue;
    }

    if (msg.role === "toolResult") {
      const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
      const body = textOf(msg.content);
      // A result is usually long and rarely the interesting part — keep the shape, drop the bulk.
      const size = body === "" ? "" : ` · ${body.length} chars`;
      out.push({ kind: "result", text: `${name}${size}`, ...stamp });
      continue;
    }

    if (msg.role !== "assistant") continue;

    // Assistant content is ordered, and the order is the story: think, say, call, say.
    if (!Array.isArray(msg.content)) continue;
    for (const rawBlock of msg.content) {
      const b = asRecord(rawBlock);
      if (!b) continue;

      if (b.type === "text" && typeof b.text === "string") {
        const t = flattenText(b.text);
        if (t !== "") out.push({ kind: "text", text: t, ...stamp });
        continue;
      }
      if (b.type === "thinking") {
        const raw =
          typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
        const t = flattenText(raw);
        if (t !== "") out.push({ kind: "thinking", text: t, ...stamp });
        continue;
      }
      if (b.type === "toolCall") {
        const name = typeof b.name === "string" ? b.name : "tool";
        const subject = toolSubject(b.arguments);
        out.push({
          kind: "tool",
          text: subject === "" ? name : `${name} ${subject}`,
          ...stamp,
        });
      }
    }
  }

  return { lines: collapseSessionLines(out), ...(id ? { id } : {}) };
}

/**
 * The pi host's reader table: the legacy format only. Anything tagged is reported as unsupported.
 */
export const piTranscriptReaders = { legacy: parseSessionLines } as const;
