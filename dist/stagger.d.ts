/** 32-bit FNV-1a, unsigned. */
export declare function fnv1a(s: string): number;
/** Seconds to delay a scheduled fire for this identity. 0 when staggering is switched off. */
export declare function staggerSeconds(key: string, maxSec: number): number;
/** "+0:47" — how the listing renders an offset. */
export declare function formatStagger(sec: number): string;
