// Cron: the Draft 0.2 grammar is validated here (croner is more permissive); croner does the dates.
import { Cron } from "croner";
import { formatStagger } from "./stagger.js";
const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"];
const FIELD_RANGES = [
    { min: 0, max: 59 },
    { min: 0, max: 23 },
    { min: 1, max: 31 },
    { min: 1, max: 12 },
    { min: 0, max: 7 },
];
const MONTH_NAMES = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAY_NAMES = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
/** Names are legal only in the month field (3) and the day-of-week field (4). */
function namesFor(fieldIndex) {
    if (fieldIndex === 3)
        return MONTH_NAMES;
    if (fieldIndex === 4)
        return DAY_NAMES;
    return undefined;
}
/** Parse one value: a plain number, or a three-letter name where the field allows it. */
function parseValue(raw, fieldIndex) {
    const names = namesFor(fieldIndex);
    if (names) {
        const byName = names[raw.toLowerCase()];
        if (byName !== undefined)
            return byName;
    }
    if (!/^[0-9]{1,2}$/.test(raw))
        return undefined;
    return Number(raw);
}
function inRange(v, fieldIndex) {
    const r = FIELD_RANGES[fieldIndex];
    if (!r)
        return false;
    return v >= r.min && v <= r.max;
}
function rangeText(fieldIndex) {
    const r = FIELD_RANGES[fieldIndex];
    return r ? `${r.min}-${r.max}` : "";
}
/** Validate a 5-field cron expression. Undefined when valid, otherwise the reason fragment. */
export function validateCron(expr) {
    if (typeof expr !== "string") {
        return `${JSON.stringify(expr)} is not a 5-field cron expression`;
    }
    const trimmed = expr.trim();
    if (trimmed === "") {
        return `"" is not a 5-field cron expression`;
    }
    // Nicknames are a different notation altogether, so say so rather than reporting a field count.
    if (trimmed.startsWith("@")) {
        return `${JSON.stringify(expr)} is a nickname — Draft 0.2 takes 5 cron fields, so write "0 0 * * *"`;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5) {
        return `${JSON.stringify(expr)} is not a 5-field cron expression`;
    }
    for (let i = 0; i < 5; i++) {
        const field = fields[i];
        const problem = validateField(field, i);
        if (problem) {
            return `${JSON.stringify(expr)} is not a valid cron expression — ${FIELD_NAMES[i]} ${problem}`;
        }
    }
    return undefined;
}
// Explain an unrecognised token; checked per token since names like `WED` contain W.
function describeBadValue(token, fieldIndex) {
    const extended = /[LWH#?]/i.exec(token);
    if (extended && parseValue(token, fieldIndex) === undefined) {
        return `${JSON.stringify(token)} uses "${extended[0]}", which Draft 0.2 does not define — use *, a value, a range, a list or a step`;
    }
    return `${JSON.stringify(token)} is not a value`;
}
/** Returns a problem fragment, or undefined when the field is valid. */
function validateField(field, fieldIndex) {
    if (field === "")
        return `is empty`;
    for (const item of field.split(",")) {
        if (item === "") {
            return `${JSON.stringify(field)} has an empty list entry`;
        }
        const [spec, stepRaw, ...rest] = item.split("/");
        if (rest.length > 0) {
            return `${JSON.stringify(item)} has more than one step`;
        }
        if (stepRaw !== undefined) {
            if (!/^[0-9]+$/.test(stepRaw)) {
                return `${JSON.stringify(item)} has a step that is not a number`;
            }
            const step = Number(stepRaw);
            if (step < 1) {
                return `${JSON.stringify(item)} has a step of ${step} — a step must be 1 or more`;
            }
            // A step is only meaningful over a span: `*` or an explicit range.
            if (spec !== "*" && !spec.includes("-")) {
                return `${JSON.stringify(item)} applies a step to a single value — use */${step} or a range like 0-30/${step}`;
            }
        }
        const value = spec;
        if (value === "*")
            continue;
        if (value.includes("-")) {
            const parts = value.split("-");
            if (parts.length !== 2) {
                return `${JSON.stringify(item)} is not a range`;
            }
            const lo = parseValue(parts[0], fieldIndex);
            const hi = parseValue(parts[1], fieldIndex);
            if (lo === undefined)
                return describeBadValue(parts[0], fieldIndex);
            if (hi === undefined)
                return describeBadValue(parts[1], fieldIndex);
            if (!inRange(lo, fieldIndex)) {
                return `${JSON.stringify(parts[0])} is out of range ${rangeText(fieldIndex)}`;
            }
            if (!inRange(hi, fieldIndex)) {
                return `${JSON.stringify(parts[1])} is out of range ${rangeText(fieldIndex)}`;
            }
            if (lo > hi) {
                return `${JSON.stringify(value)} runs backwards — write it low to high`;
            }
            continue;
        }
        const v = parseValue(value, fieldIndex);
        if (v === undefined) {
            return describeBadValue(value, fieldIndex);
        }
        if (!inRange(v, fieldIndex)) {
            return `${JSON.stringify(value)} is out of range ${rangeText(fieldIndex)}`;
        }
    }
    return undefined;
}
/**
 * `legacyMode: true` is POSIX semantics: restricted day-of-month and day-of-week are OR-ed. An
 * unknown zone throws, so `normalizeSchedule` validates zones first.
 */
export function makeCron(schedule) {
    const options = {
        legacyMode: true,
        catch: false,
    };
    if (schedule.timezone)
        options.timezone = schedule.timezone;
    return new Cron(schedule.cron, options);
}
/** Every instant in `(afterExclusive, untilInclusive]`, oldest first, at most `max`. */
export function ticksBetween(schedule, afterExclusive, untilInclusive, max = 10_000) {
    const ticks = [];
    if (!(afterExclusive instanceof Date) || Number.isNaN(afterExclusive.getTime()))
        return ticks;
    if (!(untilInclusive instanceof Date) || Number.isNaN(untilInclusive.getTime()))
        return ticks;
    if (untilInclusive <= afterExclusive)
        return ticks;
    const cron = makeCron(schedule);
    let cursor = afterExclusive;
    for (let i = 0; i < max; i++) {
        const next = cron.nextRun(cursor);
        if (!next)
            break;
        if (next.getTime() > untilInclusive.getTime())
            break;
        ticks.push(next);
        cursor = next;
    }
    return ticks;
}
/** The next cron instant strictly after `from`, or undefined when the pattern has no future run. */
export function nextTick(schedule, from) {
    const next = makeCron(schedule).nextRun(from);
    return next ?? undefined;
}
/** The most recent instant at or before `at` (croner only walks forwards). */
export function previousTick(schedule, at) {
    const period = schedulePeriodMs(schedule, at);
    const lookbackMs = Math.max(period ?? 86_400_000, 60_000) * 2;
    const ticks = ticksBetween(schedule, new Date(at.getTime() - lookbackMs), at);
    return ticks[ticks.length - 1];
}
/** The shortest gap between consecutive fires, looking a few instants ahead. */
export function schedulePeriodMs(schedule, from, samples = 5) {
    const cron = makeCron(schedule);
    let cursor = cron.nextRun(from);
    if (!cursor)
        return undefined;
    let smallest;
    for (let i = 0; i < samples; i++) {
        const next = cron.nextRun(cursor);
        if (!next)
            break;
        const gap = next.getTime() - cursor.getTime();
        if (smallest === undefined || gap < smallest)
            smallest = gap;
        cursor = next;
    }
    return smallest;
}
/** The largest stagger: half the shortest gap, or a per-minute schedule would never fire. */
export function staggerCapFor(schedule, configuredMaxSec, from) {
    if (!schedule)
        return configuredMaxSec;
    const periodMs = schedulePeriodMs(schedule, from);
    if (periodMs === undefined)
        return configuredMaxSec;
    return Math.min(configuredMaxSec, Math.max(0, Math.floor(periodMs / 2000)));
}
/** Wall-clock `HH:mm` for an instant, in the schedule's zone. */
export function clockIn(at, timezone, locale = "en") {
    const fmt = new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        ...(timezone ? { timeZone: timezone } : {}),
    });
    return fmt.format(at);
}
/** `yyyy-mm-dd` for an instant, in the schedule's zone — used only to compare calendar days. */
function dayIn(at, timezone) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        ...(timezone ? { timeZone: timezone } : {}),
    });
    return fmt.format(at);
}
function addDays(at, days) {
    return new Date(at.getTime() + days * 86_400_000);
}
/** The listing's next-fire text: the cron instant, with the stagger shown separately. */
export function describeNext(schedule, from, staggerSec, locale = "en") {
    const next = nextTick(schedule, from);
    if (!next)
        return "—";
    const clock = clockIn(next, schedule.timezone, locale);
    const offset = staggerSec > 0 ? ` ${formatStagger(staggerSec)}` : "";
    const fireAt = new Date(next.getTime() + staggerSec * 1000);
    const deltaMs = fireAt.getTime() - from.getTime();
    let when;
    if (deltaMs < 60_000) {
        when = `in ${Math.max(0, Math.round(deltaMs / 1000))}s`;
    }
    else if (deltaMs < 3_600_000) {
        when = `in ${Math.round(deltaMs / 60_000)}m`;
    }
    else {
        const tz = schedule.timezone;
        const today = dayIn(from, tz);
        const target = dayIn(next, tz);
        if (target === today) {
            when = "today";
        }
        else if (target === dayIn(addDays(from, 1), tz)) {
            when = "tomorrow";
        }
        else if (deltaMs < 7 * 86_400_000) {
            when = new Intl.DateTimeFormat(locale, {
                weekday: "long",
                ...(tz ? { timeZone: tz } : {}),
            }).format(next);
        }
        else {
            when = new Intl.DateTimeFormat(locale, {
                month: "short",
                day: "numeric",
                ...(tz ? { timeZone: tz } : {}),
            }).format(next);
        }
    }
    return `${clock}${offset} ${when}`;
}
/** ISO 8601 with the schedule's own UTC offset (`toISOString` would normalise to Z). */
export function isoWithOffset(at, timezone) {
    if (!timezone)
        return localIso(at);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(at);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
    const hour = get("hour") === "24" ? "00" : get("hour");
    const wall = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
    // Offset = (wall clock read as UTC) - (the real instant).
    const asUtc = Date.parse(`${wall}Z`);
    const offsetMin = Math.round((asUtc - at.getTime()) / 60_000);
    return `${wall}${formatOffset(offsetMin)}`;
}
function localIso(at) {
    const pad = (n) => String(n).padStart(2, "0");
    const wall = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
        `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    return `${wall}${formatOffset(-at.getTimezoneOffset())}`;
}
function formatOffset(offsetMin) {
    if (offsetMin === 0)
        return "Z";
    const sign = offsetMin > 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const pad = (n) => String(n).padStart(2, "0");
    return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
//# sourceMappingURL=cron.js.map