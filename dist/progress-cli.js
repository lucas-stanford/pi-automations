// `pa step|next|say|note|message|status`, found via `AUTOMATION_RUN`. Exit 0 ok, 1 usage, 2 refused.
import { FLOW_GLYPH } from "./flow-plan.js";
import { stateDir as defaultStateDir } from "./paths.js";
import { ProgressError, progressMessage, progressNext, progressNote, progressSay, progressStatus, progressStep, SETTABLE, } from "./progress.js";
import { stripControls } from "./ui/width.js";
export const IN_RUN_VERBS = new Set(["step", "next", "say", "note", "message", "status"]);
export const PA_EXIT = { ok: 0, usage: 1, refused: 2 };
const VALUE_FLAGS = {
    "--run": "run",
    "--status": "status",
    "-m": "message",
    "--message": "message",
    "--from": "from",
    "--node": "node",
    "--request-id": "requestId",
};
function parse(argv) {
    const out = { words: [], json: false, links: [] };
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i];
        if (raw === "--") {
            out.words.push(...argv.slice(i + 1));
            break;
        }
        const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
        const name = eq > 0 ? raw.slice(0, eq) : raw;
        const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
        const take = () => {
            if (inline !== undefined)
                return inline;
            const v = argv[i + 1];
            if (v === undefined)
                throw new ProgressError("USAGE", `${name} needs a value`);
            i++;
            return v;
        };
        const field = VALUE_FLAGS[name];
        if (name === "--json")
            out.json = true;
        else if (name === "--link")
            out.links.push(take());
        else if (field)
            out[field] = take();
        else if (name.startsWith("-") && name !== "-")
            throw new ProgressError("USAGE", `unknown option ${name}`);
        else
            out.words.push(raw);
    }
    return out;
}
function nodeJson(n) {
    return {
        id: n.id,
        label: n.label,
        status: n.status,
        text: n.text,
        ...(n.startedAt ? { startedAt: n.startedAt } : {}),
        ...(n.endedAt ? { endedAt: n.endedAt } : {}),
    };
}
function statusJson(s) {
    return {
        run: s.run,
        name: s.name,
        closed: s.closed,
        nodes: s.nodes.map(nodeJson),
        taken: s.taken,
        notes: s.notes,
        ...(s.message ? { message: s.message } : {}),
    };
}
function linkText(l) {
    return stripControls(l.label ? `${l.label}: ${l.url}` : l.url);
}
/**
 * `pa status` for a person. Nothing a chart or an agent wrote reaches the terminal as a control.
 */
export function statusLines(s) {
    const out = [`${s.name} · run ${s.run}${s.closed ? " · ended" : ""}`];
    const width = Math.max(...s.nodes.map((n) => n.id.length), 2);
    for (const n of s.nodes) {
        const label = n.label !== n.id ? `  ${stripControls(n.label)}` : "";
        const text = n.text ? ` — ${stripControls(n.text.replace(/\s+/g, " ")).trim().slice(0, 100)}` : "";
        out.push(`  ${FLOW_GLYPH[n.status]} ${n.id.padEnd(width)}  ${n.status.padEnd(8)}${label}${text}`.trimEnd());
    }
    if (s.taken.length > 0)
        out.push(`taken  ${s.taken.map(([a, b]) => `${a}→${b}`).join(", ")}`);
    for (const note of s.notes) {
        out.push(`note   ${stripControls(note.text.replace(/\s+/g, " ")).trim()}`);
        for (const l of note.links)
            out.push(`       ${linkText(l)}`);
    }
    if (s.message) {
        out.push(`message ${stripControls(s.message.text.replace(/\s+/g, " ")).trim()}`);
        for (const l of s.message.links)
            out.push(`        ${linkText(l)}`);
    }
    return out;
}
function words(p, from) {
    return p.words.slice(from).join(" ");
}
function run(verb, p, env, dir, now) {
    const runId = p.run ?? env.AUTOMATION_RUN;
    const envNode = env.AUTOMATION_NODE;
    const at = now ? { now } : {};
    switch (verb) {
        case "step": {
            const node = p.words[1];
            if (!node || p.words.length > 2)
                throw new ProgressError("USAGE", 'usage: pa step <node> [--status active|waiting|done|failed|skipped] [-m "text"]');
            if (p.status !== undefined && !SETTABLE.includes(p.status)) {
                throw new ProgressError("USAGE", `--status must be one of ${SETTABLE.join("|")}`);
            }
            const r = progressStep(dir, runId, {
                node,
                ...(p.status ? { status: p.status } : {}),
                ...(p.message !== undefined ? { text: p.message } : {}),
                ...at,
            });
            return { result: r, human: `${r.node?.id} ${r.node?.status}${r.changed ? "" : " (unchanged)"}` };
        }
        case "next": {
            const to = p.words[1];
            if (!to || p.words.length > 2)
                throw new ProgressError("USAGE", 'usage: pa next <to> [--from <node>] [-m "text"]');
            const r = progressNext(dir, runId, {
                to,
                ...(p.from !== undefined ? { from: p.from } : {}),
                ...(envNode ? { envNode } : {}),
                ...(p.message !== undefined ? { text: p.message } : {}),
                ...at,
            });
            return { result: r, human: `${r.node?.id} active, ${r.from?.id} ${r.from?.status}${r.changed ? "" : " (unchanged)"}` };
        }
        case "say": {
            const text = words(p, 1);
            if (text.trim() === "")
                throw new ProgressError("USAGE", 'usage: pa say "text" [--node <node>] [--request-id <key>]');
            const r = progressSay(dir, runId, {
                text,
                ...(p.node !== undefined ? { node: p.node } : {}),
                ...(envNode ? { envNode } : {}),
                ...(p.requestId ? { requestId: p.requestId } : {}),
                ...at,
            });
            return { result: r, human: `said on ${r.node?.id}${r.changed ? "" : " (already said)"}` };
        }
        case "note": {
            const text = words(p, 1);
            if (text.trim() === "")
                throw new ProgressError("USAGE", 'usage: pa note "text" [--link "label=https://…"]… [--request-id <key>]');
            const r = progressNote(dir, runId, {
                text,
                links: p.links,
                ...(p.requestId ? { requestId: p.requestId } : {}),
                ...at,
            });
            const n = p.links.length;
            return { result: r, human: `noted${n ? ` with ${n} link${n === 1 ? "" : "s"}` : ""}${r.changed ? "" : " (already noted)"}` };
        }
        case "message": {
            const text = words(p, 1);
            if (text.trim() === "")
                throw new ProgressError("USAGE", 'usage: pa message "text" [--link "label=https://…"]… [--request-id <key>]');
            const r = progressMessage(dir, runId, {
                text,
                links: p.links,
                ...(p.requestId ? { requestId: p.requestId } : {}),
                ...at,
            });
            const n = p.links.length;
            return { result: r, human: `message left${n ? ` with ${n} link${n === 1 ? "" : "s"}` : ""}${r.changed ? "" : " (already left)"}` };
        }
        default: {
            if (p.words.length > 1)
                throw new ProgressError("USAGE", "usage: pa status [--json]");
            const s = progressStatus(dir, runId);
            return { snapshot: s, human: statusLines(s).join("\n") };
        }
    }
}
/** Run one in-run command. Never throws; never exits the process. */
export function progressCli(argv, env = process.env, opts = {}) {
    const verb = argv[0] ?? "";
    let json = argv.includes("--json");
    try {
        const p = parse(argv);
        json = p.json;
        const dir = opts.stateDir ?? (env.AUTOMATION_STATE_DIR?.trim() || defaultStateDir());
        const done = run(verb, p, env, dir, opts.now);
        const warnings = done.result?.warnings ?? [];
        if (json) {
            const data = done.snapshot
                ? statusJson(done.snapshot)
                : {
                    run: done.result?.snapshot.run,
                    ...(done.result?.node ? { node: nodeJson(done.result.node) } : {}),
                    ...(verb === "note" ? { notes: done.result?.snapshot.notes.length ?? 0 } : {}),
                    ...(verb === "message" && done.result?.snapshot.message ? { message: done.result.snapshot.message } : {}),
                };
            const body = { ok: true, ...(done.result ? { changed: done.result.changed } : {}), warnings, data };
            return { code: PA_EXIT.ok, stdout: `${JSON.stringify(body)}\n`, stderr: "" };
        }
        return {
            code: PA_EXIT.ok,
            stdout: `${done.human}\n`,
            stderr: warnings.map((w) => `pa: ${w}\n`).join(""),
        };
    }
    catch (e) {
        const err = e instanceof ProgressError ? e : new ProgressError("IO", e?.message ?? String(e));
        const code = err.code === "USAGE" || err.code === "BAD_LINK" ? PA_EXIT.usage : PA_EXIT.refused;
        if (json) {
            const body = { ok: false, error: { code: err.code, message: err.message, suggestions: err.suggestions } };
            return { code, stdout: `${JSON.stringify(body)}\n`, stderr: "" };
        }
        const hint = err.suggestions.length > 0 ? `\n  did you mean: ${err.suggestions.join(", ")}` : "";
        return { code, stdout: "", stderr: `pa: ${err.message}${hint}\n` };
    }
}
/** The in-run half of `pa help`. */
export function inRunHelpLines() {
    const pad = " ".repeat(22);
    return [
        "Inside a run (AUTOMATION_RUN is set for the body, every hook and what they start):",
        "pa step <node> [--status active|waiting|done|failed|skipped] [-m text]",
        `${pad}set one node; active by default`,
        "pa next <to> [--from <node>] [-m text]",
        `${pad}finish <node> and start <to>; <node> defaults to AUTOMATION_NODE, else the one running node`,
        "pa say <text> [--node <node>] [--request-id <key>]",
        `${pad}add an update to a node; a request id makes a retry a no-op`,
        'pa note <text> [--link "label=https://…"]… [--request-id <key>]',
        `${pad}a note on the run's record, with the links it published`,
        'pa message <text> [--link "label=https://…"]… [--request-id <key>]',
        `${pad}the run's one message for its reader: what happened, what needs them; the last one wins`,
        "pa status             where the run is: every node, the arrows taken, the notes, the message",
        `${pad}every in-run command takes --json: one object on stdout, ok or not`,
    ];
}
//# sourceMappingURL=progress-cli.js.map