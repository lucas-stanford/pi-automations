// Durations: `s`/`m`/`h` for AUTOMATION.md; days only in config.json (`allowDays`).

export const DURATION_RE = /^([1-9][0-9]*)(s|m|h)$/;
const DURATION_RE_DAYS = /^([1-9][0-9]*)(s|m|h|d)$/;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a duration to milliseconds. `undefined` means "not a duration" — never throws. */
export function parseDuration(s: string, opts?: { allowDays?: boolean }): number | undefined {
  if (typeof s !== "string") return undefined;
  const re = opts?.allowDays ? DURATION_RE_DAYS : DURATION_RE;
  const m = re.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] as string;
  const mult = UNIT_MS[unit];
  if (mult === undefined) return undefined;
  return n * mult;
}

/**
 * Format milliseconds the way the listing shows them. 45000 -> "45s" · 552000 -> "9m12s" · 3600000
 * -> "1h"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.round(ms / 1000);
  if (total === 0) return "0s";

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join("");
}
