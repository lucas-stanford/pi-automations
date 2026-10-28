// Host policy from `<stateDir>/config.json`. A bad value is a warning plus the default.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDuration } from "./duration.js";
import { statePaths, stateDir } from "./paths.js";
export const DEFAULTS = {
    grace: "10m",
    catchUpWindow: "7d",
    defaultTimeout: "20m",
    maxTimeout: "4h",
    hookTimeout: "60s",
    hookMaxOutputBytes: 1_048_576,
    staggerMaxSeconds: 120,
    consentExpiry: "30d",
    retention: { maxLinesPerAutomation: 2000, keepLines: 500 },
    notifyOnFailed: true,
    worktree: {},
    flowTracking: {},
};
const DURATION_FIELDS = [
    "grace",
    "catchUpWindow",
    "defaultTimeout",
    "maxTimeout",
    "hookTimeout",
    "consentExpiry",
];
const NUMBER_FIELDS = ["hookMaxOutputBytes", "staggerMaxSeconds"];
const KNOWN_KEYS = new Set([
    ...DURATION_FIELDS,
    ...NUMBER_FIELDS,
    "retention",
    "notifyOnFailed",
    "worktree",
    "flowTracking",
    "fmPath",
    "plugins",
    "piModule",
]);
/** The one plugin known by name: the Automation Manager, shipped in `packages/manager`. */
export const BUNDLED_PLUGINS = ["manager"];
// Why a `plugins` entry cannot be used: only bundled names and absolute or `~/` paths are allowed.
function pluginEntryProblem(entry) {
    if (typeof entry !== "string" || entry.trim() === "")
        return "must be a plugin name or a path";
    if (BUNDLED_PLUGINS.includes(entry))
        return undefined;
    if (entry.startsWith("~/") || entry.startsWith("~\\") || path.isAbsolute(entry))
        return undefined;
    return `${JSON.stringify(entry)} is neither ${BUNDLED_PLUGINS.map((n) => JSON.stringify(n)).join(" nor ")} nor an absolute path`;
}
function clone(c) {
    return {
        ...c,
        retention: { ...c.retention },
        worktree: { ...c.worktree },
        flowTracking: { ...c.flowTracking },
    };
}
/** Read config.json: the effective config plus one warning per rejected value. */
export function loadConfig(dir = stateDir()) {
    const config = clone(DEFAULTS);
    const warnings = [];
    let raw;
    try {
        raw = JSON.parse(readFileSync(statePaths(dir).config, "utf8"));
    }
    catch (e) {
        const code = e?.code;
        if (code !== "ENOENT") {
            warnings.push(`config.json: could not be read — using defaults (${code ?? "parse error"})`);
        }
        return { config, warnings };
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        warnings.push("config.json: must be a JSON object — using defaults");
        return { config, warnings };
    }
    const obj = raw;
    for (const k of Object.keys(obj)) {
        if (!KNOWN_KEYS.has(k)) {
            warnings.push(`config.json: ${k}: unknown key — ignored`);
        }
    }
    for (const f of DURATION_FIELDS) {
        if (!(f in obj))
            continue;
        const v = obj[f];
        if (typeof v !== "string" || parseDuration(v, { allowDays: true }) === undefined) {
            warnings.push(`config.json: ${f}: ${JSON.stringify(v)} is not a duration — using ${DEFAULTS[f]}`);
            continue;
        }
        config[f] = v;
    }
    for (const f of NUMBER_FIELDS) {
        if (!(f in obj))
            continue;
        const v = obj[f];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            warnings.push(`config.json: ${f}: ${JSON.stringify(v)} is not a non-negative number — using ${DEFAULTS[f]}`);
            continue;
        }
        config[f] = Math.floor(v);
    }
    if ("notifyOnFailed" in obj) {
        const v = obj.notifyOnFailed;
        if (typeof v !== "boolean") {
            warnings.push(`config.json: notifyOnFailed: ${JSON.stringify(v)} is not true or false — using ${DEFAULTS.notifyOnFailed}`);
        }
        else {
            config.notifyOnFailed = v;
        }
    }
    if ("retention" in obj) {
        const v = obj.retention;
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
            warnings.push("config.json: retention: must be an object — using defaults");
        }
        else {
            const r = v;
            for (const k of Object.keys(r)) {
                if (k !== "maxLinesPerAutomation" && k !== "keepLines") {
                    warnings.push(`config.json: retention.${k}: unknown key — ignored`);
                }
            }
            for (const k of ["maxLinesPerAutomation", "keepLines"]) {
                if (!(k in r))
                    continue;
                const n = r[k];
                if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
                    warnings.push(`config.json: retention.${k}: ${JSON.stringify(n)} is not a positive number — using ${DEFAULTS.retention[k]}`);
                    continue;
                }
                config.retention[k] = Math.floor(n);
            }
            if (config.retention.keepLines > config.retention.maxLinesPerAutomation) {
                warnings.push("config.json: retention.keepLines: cannot exceed maxLinesPerAutomation — clamped");
                config.retention.keepLines = config.retention.maxLinesPerAutomation;
            }
        }
    }
    if ("worktree" in obj) {
        const v = obj.worktree;
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
            warnings.push("config.json: worktree: must be an object of key -> true — ignored");
        }
        else {
            for (const [k, on] of Object.entries(v)) {
                if (typeof on !== "boolean") {
                    warnings.push(`config.json: worktree[${JSON.stringify(k)}]: must be true or false — ignored`);
                    continue;
                }
                config.worktree[k] = on;
            }
        }
    }
    if ("flowTracking" in obj) {
        const v = obj.flowTracking;
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
            warnings.push("config.json: flowTracking: must be an object of key -> true — ignored");
        }
        else {
            for (const [k, on] of Object.entries(v)) {
                if (typeof on !== "boolean") {
                    warnings.push(`config.json: flowTracking[${JSON.stringify(k)}]: must be true or false — ignored`);
                    continue;
                }
                config.flowTracking[k] = on;
            }
        }
    }
    if ("fmPath" in obj && obj.fmPath !== null && obj.fmPath !== undefined) {
        if (typeof obj.fmPath !== "string" || obj.fmPath.trim() === "") {
            warnings.push("config.json: fmPath: must be a path to the fm binary — ignored");
        }
        else {
            config.fmPath = obj.fmPath;
        }
    }
    if ("plugins" in obj && obj.plugins !== null && obj.plugins !== undefined) {
        const v = obj.plugins;
        if (!Array.isArray(v)) {
            warnings.push('config.json: plugins: must be a list, e.g. ["manager"] — ignored');
        }
        else {
            const plugins = [];
            for (const [i, entry] of v.entries()) {
                const problem = pluginEntryProblem(entry);
                if (problem) {
                    warnings.push(`config.json: plugins[${i}]: ${problem} — ignored`);
                    continue;
                }
                if (!plugins.includes(entry))
                    plugins.push(entry);
            }
            config.plugins = plugins;
        }
    }
    if ("piModule" in obj && obj.piModule !== null && obj.piModule !== undefined) {
        if (typeof obj.piModule !== "string" || obj.piModule.trim() === "") {
            warnings.push("config.json: piModule: must be the directory of the pi package — ignored");
        }
        else {
            config.piModule = obj.piModule;
        }
    }
    return { config, warnings };
}
/** A duration field in milliseconds. The fallback only fires for a hand-built Config. */
export function ms(config, field) {
    const parsed = parseDuration(config[field], { allowDays: true });
    if (parsed !== undefined)
        return parsed;
    return parseDuration(DEFAULTS[field], { allowDays: true });
}
//# sourceMappingURL=config.js.map