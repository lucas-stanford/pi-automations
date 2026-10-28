/** The words the `/automations` screens use for times, schedules and run history. Pure. */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_NAMES = { sun: "0", mon: "1", tue: "2", wed: "3", thu: "4", fri: "5", sat: "6" };
const two = (n) => String(n).padStart(2, "0");
/** `weekdays 09:00`, `daily 07:30`, `every 15 min`, `hourly at :05`, or the cron itself. */
export function scheduleWords(schedule) {
    const fields = schedule.cron.trim().split(/\s+/);
    if (fields.length !== 5)
        return `cron ${schedule.cron}`;
    const [min, hour, dom, mon, rawDow] = fields;
    const dow = rawDow.toLowerCase().replace(/[a-z]{3}/g, (d) => DAY_NAMES[d] ?? d);
    const isNum = (s) => /^\d+$/.test(s);
    if (dom === "*" && mon === "*" && hour === "*" && dow === "*") {
        const every = min.match(/^\*\/(\d+)$/);
        if (every)
            return `every ${every[1]} min`;
        if (min === "*")
            return "every minute";
        if (isNum(min))
            return `hourly at :${two(Number(min))}`;
    }
    if (dom === "*" && mon === "*" && dow === "*" && isNum(min)) {
        const everyHours = hour.match(/^\*\/(\d+)$/);
        if (everyHours)
            return `every ${everyHours[1]} hours at :${two(Number(min))}`;
    }
    if (!isNum(min) || !isNum(hour) || dom !== "*" || mon !== "*")
        return `cron ${schedule.cron}`;
    const at = `${two(Number(hour))}:${two(Number(min))}`;
    if (dow === "*")
        return `daily ${at}`;
    if (dow === "1-5")
        return `weekdays ${at}`;
    if (dow === "0,6" || dow === "6,0" || dow === "6-7" || dow === "6,7")
        return `weekends ${at}`;
    if (/^[0-7]$/.test(dow))
        return `${DAYS[Number(dow) % 7]}s ${at}`;
    if (/^[0-7](,[0-7])+$/.test(dow)) {
        return `${dow.split(",").map((d) => DAYS[Number(d) % 7].slice(0, 3)).join(", ")} ${at}`;
    }
    return `cron ${schedule.cron}`;
}
/** `45s`, `4m`, `3h`, `1h 20m`, `2d`. */
export function spanWords(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60)
        return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60)
        return `${m}m`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    if (h < 24)
        return rest ? `${h}h ${rest}m` : `${h}h`;
    return `${Math.floor(h / 24)}d`;
}
/** `45 seconds`, `1 hour 20 minutes`: a span in a sentence. */
export function spanLong(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    if (s < 60)
        return unit(s, "second");
    const m = Math.round(s / 60);
    if (m < 60)
        return unit(m, "minute");
    const h = Math.floor(m / 60);
    const rest = m % 60;
    if (h < 24)
        return rest ? `${unit(h, "hour")} ${unit(rest, "minute")}` : unit(h, "hour");
    return unit(Math.floor(h / 24), "day");
}
/** `3 hours ago`, `2 days ago`, `just now`: `agoWords` for a sentence. */
export function agoLong(iso, now) {
    const ms = Math.max(0, now.getTime() - Date.parse(iso));
    if (ms < 60_000)
        return "just now";
    if (ms < 60 * 60_000)
        return `${spanLong(ms)} ago`;
    if (ms < 24 * 60 * 60_000)
        return `${spanLong(Math.round(ms / 3_600_000) * 3_600_000)} ago`;
    return `${spanLong(Math.round(ms / 86_400_000) * 86_400_000)} ago`;
}
/** `in 3 minutes`, `today at 22:00`, `Mon at 07:00`: `whenWords` for a sentence. */
export function whenLong(iso, now, timezone) {
    const ms = Date.parse(iso) - now.getTime();
    if (ms <= 0)
        return "now";
    if (ms < 60 * 60_000)
        return `in ${spanLong(ms)}`;
    return whenWords(iso, now, timezone).replace(/ (\d\d:\d\d)$/, " at $1");
}
/** `31s ago`, `2m ago`, `3h ago`, `2d ago`. */
export function agoWords(iso, now) {
    const ms = Math.max(0, now.getTime() - Date.parse(iso));
    if (ms < 60 * 60_000)
        return `${spanWords(ms)} ago`;
    if (ms < 24 * 60 * 60_000)
        return `${Math.round(ms / (60 * 60_000))}h ago`;
    return `${Math.round(ms / (24 * 60 * 60_000))}d ago`;
}
/** Past times: `26m ago`, then `today 11:38`, `yesterday 18:02`, `Mon 07:00`, `Oct 10`. */
export function momentWords(iso, now) {
    const at = new Date(iso);
    const ms = now.getTime() - at.getTime();
    if (ms >= 0 && ms < 60 * 60_000)
        return ms < 60_000 ? "just now" : `${spanWords(ms)} ago`;
    const time = clock(at);
    const day = dayKey(at);
    const today = dayKey(now);
    if (day === today)
        return `today ${time}`;
    if (nextDayKey(day) === today)
        return `yesterday ${time}`;
    if (ms > 0 && ms < 6.5 * 24 * 3_600_000)
        return `${formatter("en", { weekday: "short" }).format(at)} ${time}`;
    return formatter("en", { month: "short", day: "numeric" }).format(at);
}
/** `2026-10-22 11:38` in local time — the clock every other screen uses, never the record's UTC. */
export function localStamp(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return iso.replace("T", " ").slice(0, 16);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** `in 3m`, or `now` when it is due. */
export function inWords(iso, now) {
    const ms = Date.parse(iso) - now.getTime();
    return ms <= 0 ? "now" : `in ${spanWords(ms)}`;
}
/** Formatters cached per kind and timezone: the list asks on every spinner frame. */
const FORMATTERS = new Map();
function formatter(locale, options, timezone) {
    const key = `${locale}|${JSON.stringify(options)}|${timezone ?? ""}`;
    let f = FORMATTERS.get(key);
    if (!f) {
        f = new Intl.DateTimeFormat(locale, { ...options, ...(timezone ? { timeZone: timezone } : {}) });
        FORMATTERS.set(key, f);
    }
    return f;
}
/** `2026-10-07`: the calendar day in that timezone. */
function dayKey(at, timezone) {
    return formatter("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }, timezone).format(at);
}
/** The calendar day after `2026-10-07`, whatever the clocks do that night. */
function nextDayKey(day) {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
function clock(at, timezone) {
    return formatter("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }, timezone).format(at);
}
/**
 * Future times: `in 12m`, `today 14:00`, `tomorrow 09:00`, `Oct 21 09:00`, in the schedule's zone.
 */
export function whenWords(iso, now, timezone) {
    const at = new Date(iso);
    const ms = at.getTime() - now.getTime();
    if (ms < 60 * 60_000)
        return inWords(iso, now);
    const today = dayKey(now, timezone);
    const day = dayKey(at, timezone);
    const time = clock(at, timezone);
    if (day === today)
        return `today ${time}`;
    if (day === nextDayKey(today))
        return `tomorrow ${time}`;
    if (ms < 6.5 * 24 * 3_600_000)
        return `${formatter("en", { weekday: "short" }, timezone).format(at)} ${time}`;
    return `${formatter("en", { month: "short", day: "numeric" }, timezone).format(at)} ${time}`;
}
/** `23:23`, on the 24-hour clock every screen here uses. */
export function timeWords(iso, timezone) {
    return clock(new Date(iso), timezone);
}
/** `22:24`, today; `Oct 6 22:24` on another day. For "paused since". */
export function sinceWords(iso, now) {
    const at = new Date(iso);
    const time = clock(at);
    if (dayKey(at) === dayKey(now))
        return time;
    return `${formatter("en", { month: "short", day: "numeric" }).format(at)} ${time}`;
}
/** When a schedule fires, without the stagger this host adds. */
export function nominalFire(nextFire, staggerSec) {
    return new Date(Date.parse(nextFire) - Math.max(0, staggerSec) * 1000).toISOString();
}
/** `by hand`, `by its schedule`, `by its watch`. */
export function triggerWord(trigger) {
    if (trigger === "manual")
        return "by hand";
    if (trigger === "schedule")
        return "by its schedule";
    if (trigger === "watch")
        return "by its watch";
    return `by ${trigger}`;
}
/** Why it starts, as one phrase. */
export function startPhrase(a) {
    const auto = [];
    if (a.on.schedule)
        auto.push(`runs ${scheduleWords(a.on.schedule)}`);
    if (a.on.watch)
        auto.push(auto.length ? "when its watch finds something new" : "starts when its watch finds something new");
    if (auto.length === 0)
        return a.on.manual ? "runs only when you run it" : "does not start on its own";
    const head = auto.join(" and ");
    return a.on.manual ? `${head}, or when you run it` : head;
}
/** How long a run took, when the record knows both ends. */
export function tookMs(rec) {
    if (!rec.startedAt || !rec.endedAt)
        return undefined;
    const ms = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
/** The median duration of recent ok runs, when there are at least two. */
export function usualMs(records) {
    const took = (records ?? [])
        .filter((r) => r.outcome === "ok")
        .map(tookMs)
        .filter((ms) => ms !== undefined)
        .sort((x, y) => x - y);
    if (took.length < 2)
        return undefined;
    const mid = Math.floor(took.length / 2);
    return took.length % 2 ? took[mid] : Math.round((took[mid - 1] + took[mid]) / 2);
}
/** What arming an automation lets run on this machine. */
export function armWords(a) {
    if (!a)
        return undefined;
    const scripts = [];
    const add = (s) => {
        if (s && !scripts.includes(s))
            scripts.push(s);
    };
    add(a.on.watch?.script);
    for (const h of [...a.hooks.pre, ...a.hooks.post])
        if ("script" in h)
            add(h.script);
    const what = scripts.length ? scripts.join(", ") : "its prompt";
    const when = a.on.watch
        ? `every ${a.on.watch.every}`
        : a.on.schedule
            ? scheduleWords(a.on.schedule)
            : "when you run it";
    return `arming lets ${what} run ${when} on this machine`;
}
/** A hint that writes the fix, only for mistakes recognised with certainty. */
export function errorHint(reason) {
    const r = reason ?? "";
    if (/cron/i.test(r) && /5-field|five/i.test(r)) {
        return "a cron is five fields: minute hour day month weekday; every morning at 09:00 is 0 9 * * *";
    }
    if (/time ?zone/i.test(r))
        return "use an IANA name such as Europe/London or America/Los_Angeles";
    if (/\bevery\b/i.test(r) && /duration|between|1m|24h/i.test(r)) {
        return "every takes a duration from 1m to 24h, such as 5m or 1h";
    }
    return undefined;
}
/** `3 minutes so far, usually 7. Gives up at 1 hour.` */
export function runningWords(elapsedMs, usual, timeoutMs) {
    const so = spanLong(elapsedMs);
    let text = `${so} so far`;
    if (usual) {
        const u = spanLong(usual);
        const unit = (w) => w.replace(/^\d+ /, "");
        // `3 minutes so far, usually 7`: the unit once, when both use the same one.
        text += `, usually ${/^\d+ \S+$/.test(so) && /^\d+ \S+$/.test(u) && unit(so).replace(/s$/, "") === unit(u).replace(/s$/, "") ? u.split(" ")[0] : u}`;
    }
    text += ".";
    if (timeoutMs > 0)
        text += ` Gives up at ${spanLong(timeoutMs)}.`;
    return text;
}
//# sourceMappingURL=words.js.map