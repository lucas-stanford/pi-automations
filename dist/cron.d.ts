import { Cron } from "croner";
import type { Schedule } from "./types.js";
/** Validate a 5-field cron expression. Undefined when valid, otherwise the reason fragment. */
export declare function validateCron(expr: unknown): string | undefined;
/**
 * `legacyMode: true` is POSIX semantics: restricted day-of-month and day-of-week are OR-ed. An
 * unknown zone throws, so `normalizeSchedule` validates zones first.
 */
export declare function makeCron(schedule: Schedule): Cron;
/** Every instant in `(afterExclusive, untilInclusive]`, oldest first, at most `max`. */
export declare function ticksBetween(schedule: Schedule, afterExclusive: Date, untilInclusive: Date, max?: number): Date[];
/** The next cron instant strictly after `from`, or undefined when the pattern has no future run. */
export declare function nextTick(schedule: Schedule, from: Date): Date | undefined;
/** The most recent instant at or before `at` (croner only walks forwards). */
export declare function previousTick(schedule: Schedule, at: Date): Date | undefined;
/** The shortest gap between consecutive fires, looking a few instants ahead. */
export declare function schedulePeriodMs(schedule: Schedule, from: Date, samples?: number): number | undefined;
/** The largest stagger: half the shortest gap, or a per-minute schedule would never fire. */
export declare function staggerCapFor(schedule: Schedule | undefined, configuredMaxSec: number, from: Date): number;
/** Wall-clock `HH:mm` for an instant, in the schedule's zone. */
export declare function clockIn(at: Date, timezone: string | undefined, locale?: string): string;
/** The listing's next-fire text: the cron instant, with the stagger shown separately. */
export declare function describeNext(schedule: Schedule, from: Date, staggerSec: number, locale?: string): string;
/** ISO 8601 with the schedule's own UTC offset (`toISOString` would normalise to Z). */
export declare function isoWithOffset(at: Date, timezone: string | undefined): string;
