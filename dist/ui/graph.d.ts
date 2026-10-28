import type { RunLink, RunNote } from "../types.js";
import { type LineTheme } from "./theme.js";
/** Colour only the glyph, not the text after it, so colour never bleeds across a box border. */
export declare function colorGraphLine(line: string, theme?: LineTheme): string;
export interface GraphLinesOptions {
    /** The text graph, already split into lines. */
    lines: string[];
    /** The pane this must fit in. */
    width: number;
    theme?: LineTheme;
}
/** The coloured graph, or undefined when it does not fit (never clipped). */
export declare function buildGraphLines(opts: GraphLinesOptions): string[] | undefined;
/** The widest line in the graph, ignoring the padding a renderer adds to square it off. */
export declare function graphWidth(lines: string[]): number;
/** What to say when the graph will not fit, with its actual width. */
export declare function graphTooWideLine(width: number, pane: number, theme?: LineTheme): string;
/** One node of a step list: what the progress store or a record says about it. */
export interface StepListNode {
    id: string;
    label: string;
    status: string;
    text?: string | null;
}
/** The run's chart as a list, one node per line, for when there is no graph to show. */
export declare function buildStepListLines(nodes: readonly StepListNode[], width: number, theme?: LineTheme): string[];
/** A terminal hyperlink (OSC 8); control characters are stripped from both halves. */
export declare function hyperlink(url: string, label?: string): string;
/** `label ↗ https://…`, clickable, and cut to `width` without ever cutting the link in half. */
export declare function linkLine(raw: RunLink, width: number, indent: string, theme?: LineTheme): string;
/** A run's notes: each note's text, then its links underneath, newest last. */
export declare function noteLines(notes: readonly RunNote[], width: number, theme?: LineTheme, indent?: string): string[];
/** Notes as a small table: text, then links in one column. No colour. */
export declare function noteRows(notes: readonly RunNote[], width: number, indent?: string): string[];
