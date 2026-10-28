import { createHash } from "node:crypto";
import { isMap, isScalar, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";
import { AutomationError, oneLine } from "../errors.js";
import { nodeIdFor } from "../nodes.js";
import { parseAutomation, splitFrontmatter } from "../parse.js";
export const AUTOMATION_FILE = "AUTOMATION.md";
/** The chart's older home, beside AUTOMATION.md. Read as a fallback; never written. */
export const FLOW_FILE = "flow.mmd";
/** The largest file read or written as text. */
export const MAX_FILE_BYTES = 1_048_576;
/** Folders the file browser never enters. They hold run state, dependencies or history. */
export const SKIPPED_DIRS = [".git", "node_modules", ".flows", ".flow-runs"];
/** A host service refusing, in the shape a plugin can recognise without importing this class. */
export class HostServiceError extends Error {
    code;
    problems;
    current;
    constructor(code, message, extra = {}) {
        super(message);
        this.code = code;
        if (extra.problems)
            this.problems = extra.problems;
        if (extra.current)
            this.current = extra.current;
    }
}
export function sha256(bytes) {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function stripBomBuffer(bytes) {
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return { text: bytes.slice(bom ? 3 : 0).toString("utf8"), bom };
}
export function fieldsFromAutomation(a) {
    const out = {
        name: a.name,
        description: a.description,
        enabled: a.enabled,
        on: { manual: a.on.manual },
        hooks: { pre: [...a.hooks.pre], post: [...a.hooks.post] },
        body: a.body,
    };
    if (a.model)
        out.model = a.model;
    if (a.timeout)
        out.timeout = a.timeout;
    if (a.on.schedule)
        out.on.schedule = { ...a.on.schedule };
    if (a.on.watch)
        out.on.watch = { ...a.on.watch };
    return out;
}
export function problemFromError(e, file = "AUTOMATION.md") {
    const p = { file, severity: "error", message: oneLine(e) };
    if (e instanceof AutomationError)
        p.field = e.field;
    return p;
}
/** The same, one problem per line when the error has several (a strict flow). */
export function problemsFromError(e, file = "AUTOMATION.md") {
    if (!(e instanceof AutomationError) || !e.problems)
        return [problemFromError(e, file)];
    return e.problems.map((line) => ({ file, field: e.field, severity: "error", message: `${e.field}: ${line}` }));
}
function eolOf(text) {
    return /\r\n/.test(text) ? "\r\n" : "\n";
}
function hadFinalNewline(text) {
    return /\r?\n$/.test(text);
}
function scalar(value, type) {
    const s = new Scalar(value);
    if (type)
        s.type = type;
    return s;
}
function hookSeq(hooks) {
    const seq = new YAMLSeq();
    for (const hook of hooks) {
        const map = new YAMLMap();
        if ("script" in hook) {
            map.set("script", hook.script);
        }
        else {
            const s = scalar(hook.prompt);
            if (hook.prompt.includes("\n"))
                s.type = Scalar.BLOCK_LITERAL;
            map.set("prompt", s);
        }
        seq.items.push(map);
    }
    return seq;
}
function blankDoc(fields) {
    const doc = parseDocument("", { version: "1.2", schema: "core" });
    doc.contents = new YAMLMap();
    doc.set("name", fields.name);
    doc.set("description", fields.description);
    return doc;
}
function existingScheduleWasString(current) {
    const split = splitFrontmatter(current);
    if (!split)
        return false;
    const doc = parseDocument(split.yaml, { version: "1.2", schema: "core" });
    return isScalar(doc.getIn(["on", "schedule"], true));
}
function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function normalFields(fields) {
    const out = {
        name: fields.name,
        description: fields.description,
        enabled: fields.enabled,
        on: { manual: fields.on.manual },
        hooks: {
            pre: fields.hooks.pre.map((h) => ({ ...h })),
            post: fields.hooks.post.map((h) => ({ ...h })),
        },
        body: fields.body.trim(),
    };
    if (fields.model?.trim())
        out.model = fields.model;
    if (fields.timeout?.trim())
        out.timeout = fields.timeout;
    const s = fields.on.schedule;
    if (s) {
        const schedule = { cron: s.cron, catchUp: s.catchUp ?? "skip" };
        if (s.timezone?.trim())
            schedule.timezone = s.timezone;
        out.on.schedule = schedule;
    }
    const w = fields.on.watch;
    if (w)
        out.on.watch = { script: w.script, every: w.every };
    return out;
}
function setScalarIn(doc, keyPath, value, opts = {}) {
    if (value === undefined || value === "") {
        doc.deleteIn(keyPath);
        return;
    }
    const node = doc.getIn(keyPath, true);
    if (isScalar(node)) {
        if (node.value !== value)
            node.value = value;
        if (opts.quoteDouble && node.type === undefined)
            node.type = Scalar.QUOTE_DOUBLE;
        return;
    }
    doc.setIn(keyPath, opts.quoteDouble ? scalar(value, Scalar.QUOTE_DOUBLE) : value);
}
function ensureMapIn(doc, keyPath) {
    if (!isMap(doc.getIn(keyPath, true)))
        doc.setIn(keyPath, new YAMLMap());
}
function exactBodySuffix(text) {
    const src = text.replace(/^\uFEFF/, "");
    const eol = eolOf(src);
    const lines = src.split(eol);
    let offset = 0;
    if ((lines[0] ?? "").trim() !== "---")
        return undefined;
    offset += (lines[0]?.length ?? 0) + eol.length;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const lineStart = offset;
        offset += line.length + (i < lines.length - 1 ? eol.length : 0);
        if (line.trim() === "---") {
            return src.slice(lineStart + line.length + (i < lines.length - 1 ? eol.length : 0));
        }
    }
    return undefined;
}
function frontmatterPrefix(text) {
    const src = text.replace(/^\uFEFF/, "");
    const eol = eolOf(src);
    const lines = src.split(eol);
    let offset = 0;
    if ((lines[0] ?? "").trim() !== "---")
        return undefined;
    offset += (lines[0]?.length ?? 0) + eol.length;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        offset += line.length + (i < lines.length - 1 ? eol.length : 0);
        if (line.trim() === "---")
            return src.slice(0, offset);
    }
    return undefined;
}
function nonBody(fields) {
    return {
        name: fields.name,
        description: fields.description,
        enabled: fields.enabled,
        ...(fields.model ? { model: fields.model } : {}),
        ...(fields.timeout ? { timeout: fields.timeout } : {}),
        on: fields.on,
        hooks: fields.hooks,
    };
}
function setHooksPhase(doc, phase, hooks, current) {
    if (hooks.length === 0) {
        doc.deleteIn(["hooks", phase]);
        const hooksNode = doc.get("hooks", true);
        if (isMap(hooksNode) && hooksNode.items.length === 0)
            doc.delete("hooks");
        return;
    }
    ensureMapIn(doc, ["hooks"]);
    const existing = doc.getIn(["hooks", phase], true);
    if (current && current.length === hooks.length && existing instanceof YAMLSeq) {
        for (let i = 0; i < hooks.length; i++) {
            if (sameJson(current[i], hooks[i]))
                continue;
            const hook = hooks[i];
            const item = existing.items[i];
            if (isMap(item)) {
                if ("script" in hook) {
                    item.delete("prompt");
                    const node = item.get("script", true);
                    if (isScalar(node))
                        node.value = hook.script;
                    else
                        item.set("script", hook.script);
                }
                else {
                    item.delete("script");
                    const node = item.get("prompt", true);
                    if (isScalar(node)) {
                        node.value = hook.prompt;
                        if (hook.prompt.includes("\n"))
                            node.type = Scalar.BLOCK_LITERAL;
                    }
                    else {
                        const s = scalar(hook.prompt);
                        if (hook.prompt.includes("\n"))
                            s.type = Scalar.BLOCK_LITERAL;
                        item.set("prompt", s);
                    }
                }
            }
            else {
                const seq = hookSeq([hook]);
                existing.items[i] = seq.items[0];
            }
        }
        return;
    }
    doc.setIn(["hooks", phase], hookSeq(hooks));
}
export function composeAutomationText(currentText, dirName, fields) {
    if (fields.name !== dirName) {
        throw new AutomationError("name", `must equal the folder name ${JSON.stringify(dirName)}`);
    }
    const hasBom = currentText.startsWith("\uFEFF");
    const sourceText = currentText.replace(/^\uFEFF/, "");
    const existingSplit = splitFrontmatter(sourceText);
    let currentParsed;
    try {
        currentParsed = parseAutomation(sourceText, dirName);
    }
    catch {
        currentParsed = undefined;
    }
    const eol = eolOf(sourceText);
    const keepFinal = hadFinalNewline(sourceText);
    const normalized = normalFields(fields);
    const currentNormalized = currentParsed ? normalFields(fieldsFromAutomation(currentParsed)) : undefined;
    const bodyChanged = currentParsed === undefined || normalized.body !== currentParsed.body;
    const frontmatterChanged = currentNormalized === undefined || !sameJson(nonBody(currentNormalized), nonBody(normalized));
    if (!frontmatterChanged) {
        if (!bodyChanged)
            return currentText;
        const prefix = frontmatterPrefix(sourceText);
        if (prefix) {
            let result = `${prefix}${eol}${normalized.body}`;
            if (keepFinal)
                result += eol;
            return hasBom ? `\uFEFF${result}` : result;
        }
    }
    let doc;
    if (existingSplit) {
        doc = parseDocument(existingSplit.yaml, { version: "1.2", schema: "core" });
        if (doc.errors.length > 0 || !doc.contents || !(doc.contents instanceof YAMLMap)) {
            doc = blankDoc(fields);
        }
    }
    else {
        doc = blankDoc(fields);
    }
    if (!currentNormalized || currentNormalized.name !== normalized.name)
        setScalarIn(doc, ["name"], normalized.name);
    if (!currentNormalized || currentNormalized.description !== normalized.description)
        setScalarIn(doc, ["description"], normalized.description);
    if (!currentNormalized || currentNormalized.enabled !== normalized.enabled) {
        if (normalized.enabled === false)
            setScalarIn(doc, ["enabled"], false);
        else if (doc.has("enabled"))
            setScalarIn(doc, ["enabled"], true);
        else
            doc.delete("enabled");
    }
    if (!currentNormalized || currentNormalized.model !== normalized.model)
        setScalarIn(doc, ["model"], normalized.model);
    if (!currentNormalized || currentNormalized.timeout !== normalized.timeout)
        setScalarIn(doc, ["timeout"], normalized.timeout);
    if (!currentNormalized || !sameJson(currentNormalized.on, normalized.on))
        ensureMapIn(doc, ["on"]);
    if ((!currentNormalized || !sameJson(currentNormalized.on.schedule, normalized.on.schedule)) && normalized.on.schedule) {
        const keepString = existingScheduleWasString(sourceText) &&
            !normalized.on.schedule.timezone &&
            normalized.on.schedule.catchUp === "skip";
        if (keepString) {
            setScalarIn(doc, ["on", "schedule"], normalized.on.schedule.cron, { quoteDouble: true });
        }
        else {
            if (!isMap(doc.getIn(["on", "schedule"], true)))
                doc.setIn(["on", "schedule"], new YAMLMap());
            setScalarIn(doc, ["on", "schedule", "cron"], normalized.on.schedule.cron, { quoteDouble: true });
            if (normalized.on.schedule.timezone !== undefined)
                setScalarIn(doc, ["on", "schedule", "timezone"], normalized.on.schedule.timezone);
            else if (currentNormalized?.on.schedule?.timezone !== undefined)
                doc.deleteIn(["on", "schedule", "timezone"]);
            if (normalized.on.schedule.catchUp !== "skip" || doc.hasIn(["on", "schedule", "catch-up"])) {
                setScalarIn(doc, ["on", "schedule", "catch-up"], normalized.on.schedule.catchUp);
            }
        }
    }
    else if (currentNormalized?.on.schedule && !normalized.on.schedule) {
        doc.deleteIn(["on", "schedule"]);
    }
    if ((!currentNormalized || !sameJson(currentNormalized.on.watch, normalized.on.watch)) && normalized.on.watch) {
        // Field by field, like the schedule, so a comment on either key survives an edit of the other.
        if (!isMap(doc.getIn(["on", "watch"], true)))
            doc.setIn(["on", "watch"], new YAMLMap());
        setScalarIn(doc, ["on", "watch", "script"], normalized.on.watch.script);
        setScalarIn(doc, ["on", "watch", "every"], normalized.on.watch.every);
    }
    else if (currentNormalized?.on.watch && !normalized.on.watch) {
        doc.deleteIn(["on", "watch"]);
    }
    if (!currentNormalized || currentNormalized.on.manual !== normalized.on.manual) {
        if (normalized.on.manual)
            setScalarIn(doc, ["on", "manual"], true);
        else
            doc.deleteIn(["on", "manual"]);
    }
    if (!currentNormalized || !sameJson(currentNormalized.hooks.pre, normalized.hooks.pre)) {
        setHooksPhase(doc, "pre", normalized.hooks.pre, currentNormalized?.hooks.pre);
    }
    if (!currentNormalized || !sameJson(currentNormalized.hooks.post, normalized.hooks.post)) {
        setHooksPhase(doc, "post", normalized.hooks.post, currentNormalized?.hooks.post);
    }
    let yaml = doc.toString({ lineWidth: 0 }).trimEnd();
    const rawBodySuffix = bodyChanged
        ? `\n${normalized.body}${keepFinal ? "\n" : ""}`
        : (exactBodySuffix(sourceText) ?? `\n${normalized.body}${keepFinal ? "\n" : ""}`);
    const bodySuffix = rawBodySuffix.replace(/\r\n/g, "\n");
    let result = `---\n${yaml}\n---\n${bodySuffix}`;
    if (eol === "\r\n")
        result = result.replace(/\n/g, "\r\n");
    if (hasBom)
        result = `\uFEFF${result}`;
    try {
        const reparsed = parseAutomation(result, dirName);
        const again = normalFields(fieldsFromAutomation(reparsed));
        if (!sameJson(again, normalized)) {
            throw new AutomationError("frontmatter", "composed file did not round-trip through the parser");
        }
    }
    catch (e) {
        if (e instanceof AutomationError && e.field === "frontmatter" && e.fix === "composed file did not round-trip through the parser")
            throw e;
    }
    return result;
}
export function drivenIds(a) {
    const ids = [];
    a.hooks.pre.forEach((_, i) => ids.push(nodeIdFor("pre", i)));
    ids.push("body");
    a.hooks.post.forEach((_, i) => ids.push(nodeIdFor("post", i)));
    return ids;
}
export function flowProblems(text, driven, file = FLOW_FILE, label = "flow.mmd") {
    if (text === null)
        return [];
    const problems = [];
    // `%%` lines are comments: they neither start the chart nor declare a node.
    const statements = text
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("%%"))
        .join("\n");
    const first = statements
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l);
    if (!first || !/^(flowchart|graph)(\s+(TD|TB|BT|LR|RL))?\b/.test(first)) {
        problems.push({
            file,
            severity: "warning",
            message: `${label}: first non-comment line should be flowchart or graph with optional direction`,
        });
    }
    for (const id of driven) {
        const re = new RegExp(`(^|\\s)${id}(\\b|\\[|\\(|\\{|@)`, "m");
        if (!re.test(statements)) {
            problems.push({
                file,
                severity: "warning",
                message: `${label}: no node "${id}" — pi-automations moves ${driven.join(", ")}; a run that reaches it records NODE_NOT_FOUND and stops tracking`,
            });
        }
    }
    return problems;
}
//# sourceMappingURL=compose.js.map