// The host services handed to plugins. Writes check the disk, parse first and queue per automation.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { AUTOMATION_FILE, composeAutomationText, drivenIds, fieldsFromAutomation, FLOW_FILE, flowProblems, HostServiceError, MAX_FILE_BYTES, problemsFromError, sha256, stripBomBuffer, } from "../authoring/compose.js";
import { listFiles, readTextFile, writableDir, writeTextFile } from "../authoring/files.js";
import { refresh } from "../commands.js";
import { loadConfig } from "../config.js";
import { nextTick } from "../cron.js";
import { AutomationError, oneLine } from "../errors.js";
import { findFlowBlock, setFlowBlock } from "../flow-block.js";
import { planFromAutomation } from "../flow-plan.js";
import { listingModel } from "../listing.js";
import { parseAutomation } from "../parse.js";
import { packageDir, tildify } from "../paths.js";
import { progressOf, readProgress } from "../progress.js";
import { readRecords } from "../records.js";
import { State } from "../state.js";
import { summaryLine } from "../summary.js";
import { Trust } from "../trust.js";
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
/** How many runs `history` answers by default, and at most. */
export const HISTORY_LIMIT = 200;
export const HISTORY_MAX = 1000;
export function createHostServices(opts) {
    const home = opts.home ?? homedir();
    const now = opts.now ?? (() => new Date());
    const queues = new Map();
    let resolver;
    let resolverRead;
    let modelError;
    function readResolver() {
        resolverRead ??= (async () => {
            try {
                resolver = await opts.models?.resolver();
                if (opts.models && !resolver)
                    modelError = "pi was not found";
            }
            catch (e) {
                resolver = undefined;
                modelError = oneLine(e);
            }
        })();
        return resolverRead;
    }
    function deps() {
        return {
            config: loadConfig(opts.stateDir).config,
            stateDir: opts.stateDir,
            trust: new Trust(opts.stateDir),
            state: new State(opts.stateDir),
            now,
            home,
            ...(opts.host ? { host: opts.host } : {}),
            cwd: opts.cwd(),
            spawnFire: () => 2,
            ...(resolver ? { resolveModel: resolver } : {}),
        };
    }
    async function refreshed() {
        await readResolver();
        const d = deps();
        return { r: await refresh(d), d };
    }
    async function byKey(key) {
        const { r, d } = await refreshed();
        const status = r.statuses.find((s) => s.key === key);
        if (!status)
            throw new HostServiceError("not-found", "automation not found");
        return { status, located: r.byKey.get(status.key) ?? null, d };
    }
    function summary(s, d) {
        const out = {
            key: s.key,
            name: s.name,
            scope: s.scope,
            rootLabel: tildify(s.root.path, d.home),
            dir: tildify(s.dir, d.home),
            state: s.state,
            triggers: s.automation
                ? {
                    manual: s.automation.on.manual,
                    ...(s.automation.on.schedule ? { schedule: { ...s.automation.on.schedule } } : {}),
                    ...(s.automation.on.watch ? { watch: { ...s.automation.on.watch } } : {}),
                }
                : null,
            recent: readRecords(d.stateDir, s.key, 7).map((r) => r.outcome),
            tracked: s.flow === true,
            hasFlowFile: hasOwnFlowChart(s.dir),
            editable: writableDir(s.dir),
        };
        if (s.reason)
            out.reason = s.reason;
        if (s.automation?.description)
            out.description = s.automation.description;
        if (s.nextFire)
            out.nextFire = s.nextFire;
        if (s.nextCheck)
            out.nextCheck = s.nextCheck;
        if (s.watch) {
            const w = s.watch;
            out.lastCheck = {
                checkedAt: w.checkedAt,
                durationMs: w.durationMs,
                ...(w.exit !== undefined ? { exit: w.exit } : {}),
                ...(w.problem !== undefined ? { problem: w.problem } : {}),
                ...(w.said !== undefined ? { said: w.said } : {}),
                ...(w.firedAt !== undefined ? { firedAt: w.firedAt } : {}),
            };
        }
        if (s.running)
            out.running = { runId: s.running.runId, pid: s.running.pid, startedAt: s.running.startedAt };
        if (s.last)
            out.last = s.last;
        return out;
    }
    function bundle(s, d) {
        const automationFile = path.join(s.dir, AUTOMATION_FILE);
        const { file: automation, problem: automationTextProblem } = revisionedForBundle(automationFile);
        const flowFile = path.join(s.dir, FLOW_FILE);
        const flowRead = existsSync(flowFile) ? revisionedForBundle(flowFile) : undefined;
        const flow = flowRead?.file ?? null;
        const automationBlock = automationTextProblem ? null : findFlowBlock(automation.text);
        const effectiveFlowText = automationBlock?.text ?? (flowRead?.problem ? null : flow?.text ?? null);
        const effectiveFlowFile = automationBlock ? AUTOMATION_FILE : FLOW_FILE;
        const effectiveFlowLabel = automationBlock ? "flowchart" : "flow.mmd";
        let parsed = null;
        const problems = [];
        let parseError;
        if (automationTextProblem) {
            problems.push(automationTextProblem);
        }
        else {
            try {
                parsed = parseAutomation(automation.text, s.name);
            }
            catch (e) {
                parseError = oneLine(e);
                problems.push(...problemsFromError(e));
            }
        }
        if (flowRead?.problem)
            problems.push(flowRead.problem);
        if (s.reason && s.reason !== parseError && !problems.some((p) => p.message === s.reason)) {
            problems.push({ file: AUTOMATION_FILE, severity: s.state === "invalid" ? "error" : "warning", message: s.reason });
        }
        if (!d.resolveModel && parsed) {
            problems.push({ file: AUTOMATION_FILE, field: "model", severity: "info", message: `model not checked — ${modelError ?? "pi was not found"}` });
        }
        if (parsed)
            problems.push(...hookProblems(s.dir, parsed));
        const driven = parsed ? drivenIds(parsed) : [];
        if (automationBlock && flow) {
            problems.push({ file: FLOW_FILE, severity: "warning", message: "flow.mmd is ignored: AUTOMATION.md has the flowchart. Delete flow.mmd." });
        }
        problems.push(...flowProblems(effectiveFlowText, driven, effectiveFlowFile, effectiveFlowLabel));
        const records = readRecords(d.stateDir, s.key, 20).slice().reverse();
        return {
            summary: summary(s, d),
            fields: parsed ? fieldsFromAutomation(parsed) : null,
            files: { automation, flow },
            flow: {
                source: automationBlock ? "automation" : flow ? "file" : d.config.flowTracking[s.key] === true ? "config" : "none",
                text: effectiveFlowText,
                generated: parsed ? planFromAutomation(parsed) : null,
                driven,
            },
            problems,
            nextFires: parsed?.on.schedule ? nextFires(parsed.on.schedule, d.now(), 3) : [],
            runs: records.map(runSummary),
            notices: [...noticesFor(s), ...documentLinkNotices(s.dir)],
        };
    }
    function compose(s, draft, d) {
        const automationPath = path.join(s.dir, AUTOMATION_FILE);
        const flowPath = path.join(s.dir, FLOW_FILE);
        refuseDocumentLinks(s.dir);
        const currentAutomation = revisioned(automationPath);
        const currentFlow = existsSync(flowPath) ? rawRevisioned(flowPath) : null;
        if (draft.fields && draft.automationText !== undefined)
            throw new HostServiceError("bad-request", "fields and automationText are mutually exclusive");
        if (typeof draft.flowText === "string" && draft.flowText.trim() === "")
            throw new HostServiceError("bad-request", "use null to remove the flowchart");
        let automationText = currentAutomation.text;
        if (draft.automationText !== undefined)
            automationText = draft.automationText;
        else if (draft.fields) {
            if (draft.fields.name !== s.name)
                throw new HostServiceError("bad-request", "fields.name must equal the folder name");
            try {
                automationText = composeAutomationText(currentAutomation.text, s.name, draft.fields);
            }
            catch (e) {
                if (e instanceof AutomationError)
                    throw new HostServiceError("bad-request", e.message);
                throw e;
            }
        }
        if (draft.flowText !== undefined)
            automationText = setFlowBlock(automationText, draft.flowText);
        const block = findFlowBlock(automationText);
        // A draft that leaves flow.mmd alone is checked against the file on disk.
        const flowFileText = draft.flowText === undefined ? flowTextOnDisk(flowPath) : null;
        const flowText = block?.text ?? flowFileText;
        const flowFile = block ? AUTOMATION_FILE : FLOW_FILE;
        const flowLabel = block ? "flowchart" : "flow.mmd";
        const problems = [];
        let parsed = null;
        try {
            parsed = parseAutomation(automationText, s.name);
        }
        catch (e) {
            problems.push(...problemsFromError(e));
        }
        const driven = parsed ? drivenIds(parsed) : [];
        if (block && currentFlow !== null && draft.flowText === undefined) {
            problems.push({ file: FLOW_FILE, severity: "warning", message: "flow.mmd is ignored: AUTOMATION.md has the flowchart. Delete flow.mmd." });
        }
        if (draft.flowText !== undefined || flowText !== null) {
            problems.push(...flowProblems(flowText, driven, flowFile, flowLabel));
        }
        return {
            automationText,
            flowText,
            flowFileText,
            fields: parsed ? fieldsFromAutomation(parsed) : null,
            valid: parsed !== null && !problems.some((p) => p.severity === "error"),
            problems,
            nextFires: parsed?.on.schedule ? nextFires(parsed.on.schedule, d.now(), 3) : [],
            generatedFlow: parsed ? planFromAutomation(parsed) : null,
            driven,
            changed: {
                automation: automationText !== currentAutomation.text,
                flow: draft.flowText === undefined ? false : currentFlow !== null,
            },
        };
    }
    function queued(key, op) {
        const prior = queues.get(key) ?? Promise.resolve();
        const next = prior.then(op, op);
        queues.set(key, next.catch(() => undefined));
        return next;
    }
    return {
        version: packageVersion(),
        get stateDirLabel() {
            return tildify(opts.stateDir, home);
        },
        maxFileBytes: MAX_FILE_BYTES,
        async index() {
            const { r, d } = await refreshed();
            const model = listingModel(r.statuses, { home: d.home, projectRoots: r.projectRoots, now: d.now() });
            const groups = model.groups.map((group) => ({
                id: sha256(group.path).slice("sha256:".length, "sha256:".length + 12),
                scope: group.kind === "user" ? "user" : "repository",
                title: group.title,
                rootLabel: tildify(group.path, d.home),
                automations: group.rows.map((row) => summary(row.status, d)),
            }));
            return { groups, generatedAt: d.now().toISOString() };
        },
        async bundle(key) {
            const { status, d } = await byKey(key);
            return bundle(status, d);
        },
        validate(text, name) {
            try {
                return { fields: fieldsFromAutomation(parseAutomation(text, name)), problems: [] };
            }
            catch (e) {
                return { fields: null, problems: problemsFromError(e) };
            }
        },
        async compose(key, draft) {
            const { status, d } = await byKey(key);
            return compose(status, draft, d);
        },
        save(key, req) {
            return queued(key, async () => {
                const { status: s, d } = await byKey(key);
                if (!req.base)
                    throw new HostServiceError("bad-request", "base is required");
                const automationPath = path.join(s.dir, AUTOMATION_FILE);
                const flowPath = path.join(s.dir, FLOW_FILE);
                refuseDocumentLinks(s.dir);
                const currentAutomation = revisioned(automationPath);
                const currentFlow = existsSync(flowPath) ? rawRevisioned(flowPath) : null;
                if (req.base.automation !== currentAutomation.revision || req.base.flow !== (currentFlow?.revision ?? null)) {
                    throw new HostServiceError("conflict", "automation changed on disk", {
                        current: { automation: currentAutomation.revision, flow: currentFlow?.revision ?? null },
                    });
                }
                const composed = compose(s, req, d);
                if (!composed.valid && !req.allowInvalid) {
                    throw new HostServiceError("invalid", "draft is invalid", { problems: composed.problems });
                }
                writeDocumentsAtomically({
                    automationPath,
                    automationOldBytes: readFileSync(automationPath),
                    automationText: composed.automationText,
                    automationCurrent: currentAutomation,
                    flowPath,
                    flowCurrent: currentFlow,
                    flowText: req.flowText === undefined ? undefined : null,
                });
                const fresh = await byKey(key);
                return bundle(fresh.status, fresh.d);
            });
        },
        async listFiles(key, rel) {
            const { status, located } = await byKey(key);
            return listFiles(located ?? syntheticLocated(status), rel);
        },
        async readFile(key, rel) {
            const { status, located } = await byKey(key);
            return readTextFile(located ?? syntheticLocated(status), rel);
        },
        writeFile(key, rel, body) {
            return queued(key, async () => {
                const { status, located } = await byKey(key);
                const file = writeTextFile(located ?? syntheticLocated(status), rel, body);
                const fresh = await byKey(key);
                return { file, summary: summary(fresh.status, fresh.d) };
            });
        },
        async runs(key, limit = 20) {
            return readRecords(opts.stateDir, key, limit).slice().reverse();
        },
        async history(query = {}) {
            const { r, d } = await refreshed();
            const limit = Math.max(1, Math.min(HISTORY_MAX, Math.floor(query.limit ?? HISTORY_LIMIT) || HISTORY_LIMIT));
            const out = [];
            for (const s of r.statuses) {
                if (query.key !== undefined && s.key !== query.key)
                    continue;
                for (const rec of readRecords(d.stateDir, s.key, HISTORY_MAX)) {
                    if (query.outcome && rec.outcome !== query.outcome)
                        continue;
                    if (query.withMessage && !rec.message && !(rec.notes?.length))
                        continue;
                    out.push({ key: s.key, name: s.name, ...runSummary(rec) });
                }
            }
            return out.sort((a, b) => Date.parse(runAt(b)) - Date.parse(runAt(a))).slice(0, limit);
        },
        progress(runId) {
            const snap = readProgress(opts.stateDir, runId);
            if (!snap)
                return undefined;
            const p = progressOf(snap);
            return { runId: snap.run, key: snap.key, name: snap.name, chart: p.chart, steps: p.steps, taken: p.taken, notes: p.notes, ...(p.message ? { message: p.message } : {}), closed: snap.closed };
        },
        async models() {
            const { r } = await refreshed();
            const used = Array.from(new Set(r.statuses.map((s) => s.automation?.model).filter((m) => !!m))).sort();
            if (!opts.models)
                return { enabled: [], available: [], used, error: "pi was not found" };
            let catalog;
            try {
                const found = await opts.models.choices(opts.cwd());
                catalog = { enabled: found.enabled, available: found.available, used };
            }
            catch (e) {
                catalog = { enabled: [], available: [], used, error: oneLine(e) };
            }
            // A fresh read rebuilds the model check, so a newly usable model stops reading as unresolved.
            resolverRead = undefined;
            await readResolver();
            return catalog;
        },
    };
}
// ------------------------------------------------------------------------------- documents
function decodeStrict(bytes, file) {
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    try {
        return STRICT_UTF8.decode(bytes.slice(bom ? 3 : 0));
    }
    catch {
        const problem = { file, severity: "error", message: `${file} is not UTF-8 — re-save it as UTF-8 to edit it here` };
        throw new HostServiceError("unsupported", problem.message, { problems: [problem] });
    }
}
function revisioned(file) {
    const bytes = readFileSync(file);
    const text = decodeStrict(bytes, path.basename(file));
    return { text, revision: sha256(bytes), bytes: bytes.length, updatedAt: statSync(file).mtime.toISOString() };
}
function rawRevisioned(file) {
    const bytes = readFileSync(file);
    return { text: "", revision: sha256(bytes), bytes: bytes.length, updatedAt: statSync(file).mtime.toISOString() };
}
function isUnsupported(e) {
    return e instanceof HostServiceError && e.code === "unsupported";
}
function revisionedForBundle(file) {
    try {
        return { file: revisioned(file) };
    }
    catch (e) {
        if (isUnsupported(e))
            return { file: rawRevisioned(file), ...(e.problems?.[0] ? { problem: e.problems[0] } : {}) };
        throw e;
    }
}
/** flow.mmd's text, or null when there is none or it is not UTF-8. */
function flowTextOnDisk(file) {
    if (!existsSync(file))
        return null;
    try {
        return revisioned(file).text;
    }
    catch (e) {
        if (isUnsupported(e))
            return null;
        throw e;
    }
}
function hasOwnFlowChart(dir) {
    try {
        const block = findFlowBlock(readFileSync(path.join(dir, AUTOMATION_FILE), "utf8"));
        if (block && block.text.trim() !== "")
            return true;
    }
    catch {
        // Fall through to the legacy file.
    }
    try {
        return readFileSync(path.join(dir, FLOW_FILE), "utf8").trim() !== "";
    }
    catch {
        return false;
    }
}
function isDocumentLink(file) {
    try {
        return lstatSync(file).isSymbolicLink();
    }
    catch {
        return false;
    }
}
function documentLinkNotices(dir) {
    const out = [];
    for (const name of [AUTOMATION_FILE, FLOW_FILE]) {
        if (isDocumentLink(path.join(dir, name))) {
            out.push({ tone: "warning", message: `${name} is a symbolic link — edit the file it points to directly.` });
        }
    }
    return out;
}
function refuseDocumentLinks(dir) {
    for (const name of [AUTOMATION_FILE, FLOW_FILE]) {
        if (isDocumentLink(path.join(dir, name))) {
            throw new HostServiceError("bad-request", `${name} is a symbolic link — edit the file it points to directly`);
        }
    }
}
function withBom(text, bom) {
    const clean = text.replace(/^\uFEFF/, "");
    return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(clean)]) : Buffer.from(clean);
}
function tempFor(file, bytes) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomBytes(2).toString("hex")}.tmp`);
    writeFileSync(tmp, bytes);
    try {
        chmodSync(tmp, statSync(file).mode);
    }
    catch {
        // New file, or Windows mode bits.
    }
    return tmp;
}
/** Write AUTOMATION.md and delete a flow.mmd its chart was folded out of, as one change. */
function writeDocumentsAtomically(args) {
    const automationBom = stripBomBuffer(args.automationOldBytes).bom;
    const nextAutomation = withBom(args.automationText, automationBom);
    const writeAutomation = sha256(nextAutomation) !== args.automationCurrent.revision;
    const deleteFlow = args.flowText === null && args.flowCurrent !== null;
    if (!writeAutomation && !deleteFlow)
        return;
    let automationTmp;
    let automationRenamed = false;
    try {
        if (writeAutomation) {
            automationTmp = tempFor(args.automationPath, nextAutomation);
            renameSync(automationTmp, args.automationPath);
            automationTmp = undefined;
            automationRenamed = true;
        }
        if (deleteFlow)
            rmSync(args.flowPath);
    }
    catch (e) {
        if (automationRenamed) {
            try {
                writeFileSync(args.automationPath, args.automationOldBytes);
            }
            catch {
                // The error below is still the clearest thing a caller can act on.
            }
        }
        throw new Error(`could not save both documents — nothing was saved: ${oneLine(e)}`);
    }
    finally {
        if (automationTmp) {
            try {
                rmSync(automationTmp, { force: true });
            }
            catch {
                // The temp path carries nothing that was not already in the request.
            }
        }
    }
}
// ------------------------------------------------------------------------------- shapes
function nextFires(schedule, from, n) {
    const out = [];
    let cursor = from;
    for (let i = 0; i < n; i++) {
        const next = nextTick(schedule, cursor);
        if (!next)
            break;
        out.push(next.toISOString());
        cursor = new Date(next.getTime() + 1000);
    }
    return out;
}
function hookProblems(dir, a) {
    const out = [];
    if (a.on.watch && !existsSync(path.resolve(dir, a.on.watch.script))) {
        out.push({ file: AUTOMATION_FILE, field: "on.watch.script", severity: "warning", message: `on.watch.script: ${JSON.stringify(a.on.watch.script)} does not exist in the automation folder` });
    }
    for (const phase of ["pre", "post"]) {
        a.hooks[phase].forEach((hook, i) => {
            if ("script" in hook && !existsSync(path.resolve(dir, hook.script))) {
                out.push({ file: AUTOMATION_FILE, field: `hooks.${phase}[${i}].script`, severity: "warning", message: `hooks.${phase}[${i}].script: ${JSON.stringify(hook.script)} does not exist in the automation folder` });
            }
        });
    }
    return out;
}
/** When a run ended, or was recorded: what history sorts by. */
function runAt(run) {
    return run.endedAt ?? run.recordedAt;
}
export function runSummary(rec) {
    const out = {
        id: rec.id,
        trigger: rec.trigger,
        outcome: rec.outcome,
        recordedAt: rec.recordedAt,
        summary: summaryLine(rec),
        hooks: rec.hooks ?? [],
    };
    if (rec.reason !== undefined)
        out.reason = rec.reason;
    if (rec.error !== undefined)
        out.error = rec.error;
    if (rec.scheduledFor !== undefined)
        out.scheduledFor = rec.scheduledFor;
    if (rec.startedAt !== undefined)
        out.startedAt = rec.startedAt;
    if (rec.endedAt !== undefined)
        out.endedAt = rec.endedAt;
    if (rec.model !== undefined)
        out.model = rec.model;
    if (rec.output !== undefined)
        out.output = { text: rec.output.text, truncated: rec.output.truncated === true };
    if (rec.startedAt && rec.endedAt)
        out.durationMs = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
    if (rec.chart)
        out.chart = rec.chart;
    if (rec.steps)
        out.steps = rec.steps;
    if (rec.taken)
        out.taken = rec.taken;
    if (rec.notes)
        out.notes = rec.notes;
    if (rec.message)
        out.message = rec.message;
    if (rec.flow?.problem)
        out.flow = { problem: rec.flow.problem };
    if (rec.pluginProblems?.length)
        out.pluginProblems = rec.pluginProblems;
    return out;
}
function noticesFor(s) {
    const out = [];
    if (s.scope === "repository")
        out.push({ tone: "warning", message: `Saving changes inside this repository returns it to off until you arm it again: /automations arm ${s.name}.` });
    else
        out.push({ tone: "warning", message: `Saving changes returns it to off until you arm it again: /automations arm ${s.name}.` });
    if (s.running)
        out.push({ tone: "info", message: "A run is in progress; changes apply to the next run." });
    if (!writableDir(s.dir))
        out.push({ tone: "warning", message: "This automation folder is not writable." });
    return out;
}
/** An invalid automation has no parsed file, but its folder can still be browsed. */
function syntheticLocated(s) {
    const automation = s.automation ?? {
        name: s.name,
        description: "",
        enabled: true,
        on: { manual: false },
        hooks: { pre: [], post: [] },
        body: "",
    };
    return { automation, dir: s.dir, file: path.join(s.dir, AUTOMATION_FILE), root: s.root, key: s.key };
}
function packageVersion() {
    try {
        const pkg = JSON.parse(readFileSync(path.join(packageDir(), "package.json"), "utf8"));
        return pkg.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
//# sourceMappingURL=host.js.map