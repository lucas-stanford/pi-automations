/** The words the `/automations` screens use for times, schedules and run history. Pure. */
import type { Automation, RunRecord, Schedule } from "../types.js";
/** `weekdays 09:00`, `daily 07:30`, `every 15 min`, `hourly at :05`, or the cron itself. */
export declare function scheduleWords(schedule: Pick<Schedule, "cron">): string;
/** `45s`, `4m`, `3h`, `1h 20m`, `2d`. */
export declare function spanWords(ms: number): string;
/** `45 seconds`, `1 hour 20 minutes`: a span in a sentence. */
export declare function spanLong(ms: number): string;
/** `3 hours ago`, `2 days ago`, `just now`: `agoWords` for a sentence. */
export declare function agoLong(iso: string, now: Date): string;
/** `in 3 minutes`, `today at 22:00`, `Mon at 07:00`: `whenWords` for a sentence. */
export declare function whenLong(iso: string, now: Date, timezone?: string): string;
/** `31s ago`, `2m ago`, `3h ago`, `2d ago`. */
export declare function agoWords(iso: string, now: Date): string;
/** Past times: `26m ago`, then `today 11:38`, `yesterday 18:02`, `Mon 07:00`, `Oct 10`. */
export declare function momentWords(iso: string, now: Date): string;
/** `2026-10-22 11:38` in local time — the clock every other screen uses, never the record's UTC. */
export declare function localStamp(iso: string): string;
/** `in 3m`, or `now` when it is due. */
export declare function inWords(iso: string, now: Date): string;
/**
 * Future times: `in 12m`, `today 14:00`, `tomorrow 09:00`, `Oct 21 09:00`, in the schedule's zone.
 */
export declare function whenWords(iso: string, now: Date, timezone?: string): string;
/** `23:23`, on the 24-hour clock every screen here uses. */
export declare function timeWords(iso: string, timezone?: string): string;
/** `22:24`, today; `Oct 6 22:24` on another day. For "paused since". */
export declare function sinceWords(iso: string, now: Date): string;
/** When a schedule fires, without the stagger this host adds. */
export declare function nominalFire(nextFire: string, staggerSec: number): string;
/** `by hand`, `by its schedule`, `by its watch`. */
export declare function triggerWord(trigger: string): string;
/** Why it starts, as one phrase. */
export declare function startPhrase(a: Automation): string;
/** How long a run took, when the record knows both ends. */
export declare function tookMs(rec: RunRecord): number | undefined;
/** The median duration of recent ok runs, when there are at least two. */
export declare function usualMs(records: RunRecord[] | undefined): number | undefined;
/** What arming an automation lets run on this machine. */
export declare function armWords(a: Automation | undefined): string | undefined;
/** A hint that writes the fix, only for mistakes recognised with certainty. */
export declare function errorHint(reason: string | undefined): string | undefined;
/** `3 minutes so far, usually 7. Gives up at 1 hour.` */
export declare function runningWords(elapsedMs: number, usual: number | undefined, timeoutMs: number): string;
