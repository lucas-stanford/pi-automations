import type { Outcome } from "../types.js";
export declare function sparkline(outcomes: Outcome[], width?: number): string;
/** A short, human summary of the same data, for surfaces with no room for glyphs. */
export declare function summarise(outcomes: Outcome[]): string;
