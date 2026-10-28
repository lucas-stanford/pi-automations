// Deterministic per-automation offset: a hash of the key, stable everywhere, never stored.

/** 32-bit FNV-1a, unsigned. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  const bytes = Buffer.from(s, "utf8");
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Seconds to delay a scheduled fire for this identity. 0 when staggering is switched off. */
export function staggerSeconds(key: string, maxSec: number): number {
  if (!Number.isFinite(maxSec) || maxSec <= 0) return 0;
  return fnv1a(key) % Math.floor(maxSec);
}

/** "+0:47" — how the listing renders an offset. */
export function formatStagger(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `+${m}:${String(s).padStart(2, "0")}`;
}
