// The frame every `/automations` page uses: title, body, key hints. Pure.

import { type LineTheme, PLAIN_THEME, type UiColor } from "./theme.js";
import { truncateToWidth, visibleWidth } from "./width.js";

/** The part of pi's TUI a page reads: the terminal's height, when there is one. */
export interface PageHost {
  terminal?: { readonly rows: number };
}

/** A key hint. Lower `rank` is more important and stays longest as the terminal narrows. */
export interface Hint {
  text: string;
  rank: number;
}

export interface PageFrame {
  /** Already styled. */
  title: string;
  /** Already styled; drawn on the right of line 1 when it fits. */
  right?: string;
  body: string[];
  /** In display order. */
  hints: Hint[];
  /** Kept on the right of the hint line whatever the width, e.g. `? help · esc close`. */
  pinned?: string[];
  /** Replaces the hint line while it lasts. */
  flash?: { text: string; color: UiColor };
}

/** Rows a page has, or `undefined` when the host does not know. */
export function pageRows(host: PageHost | undefined): number | undefined {
  const rows = host?.terminal?.rows;
  return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : undefined;
}

/** How many body lines fit between the title and the hints. */
export function bodyRows(rows: number | undefined, fallback = 20): number {
  return rows === undefined ? fallback : Math.max(1, rows - 4);
}

/** `r run`: the key as it is, the words dim. */
function hintText(text: string, t: LineTheme): string {
  const space = text.indexOf(" ");
  if (space <= 0) return t.fg("muted", text);
  return `${t.fg("text", text.slice(0, space))}${t.fg("muted", text.slice(space))}`;
}

/**
 * The hint line: as many hints as fit, the least important leaving first, the pinned ones never.
 */
export function hintLine(hints: Hint[], pinned: string[], width: number, theme?: LineTheme): string {
  const t = theme ?? PLAIN_THEME;
  const sep = " · ";
  const rightPlain = pinned.join(sep);
  const kept = hints.slice();
  const fits = (): boolean => {
    const left = kept.map((h) => h.text).join(sep);
    return visibleWidth(left) + (rightPlain ? visibleWidth(rightPlain) + (left ? 3 : 0) : 0) <= width;
  };
  while (!fits() && kept.length > 0) {
    let worst = 0;
    kept.forEach((h, i) => {
      if (h.rank >= (kept[worst] as Hint).rank) worst = i;
    });
    kept.splice(worst, 1);
  }
  const left = kept.map((h) => hintText(h.text, t)).join(t.fg("muted", sep));
  const right = pinned.map((p) => hintText(p, t)).join(t.fg("muted", sep));
  if (!right) return truncateToWidth(left, width);
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return truncateToWidth(gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : right, width);
}

/** `left` and `right` on one line, the right side dropped when they do not both fit. */
export function titleLine(left: string, right: string | undefined, width: number): string {
  if (!right) return truncateToWidth(left, width);
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 3) return `${left}${" ".repeat(gap)}${right}`;
  return truncateToWidth(left, width);
}

/**
 * The page, exactly `rows` lines when known: title, blank, body (cut to fit), padding, hint line.
 */
export function renderPage(frame: PageFrame, width: number, rows: number | undefined, theme?: LineTheme): string[] {
  const t = theme ?? PLAIN_THEME;
  const w = Math.max(1, width);
  const top = titleLine(frame.title, frame.right, w);
  const bottom = frame.flash
    ? truncateToWidth(t.fg(frame.flash.color, frame.flash.text), w)
    : hintLine(frame.hints, frame.pinned ?? [], w, t);
  const body = frame.body.map((l) => truncateToWidth(l, w));
  if (rows === undefined) return [top, "", ...body, "", bottom];
  if (rows <= 1) return [bottom].slice(0, rows);
  if (rows <= 3) return [top, ...Array(rows - 2).fill(""), bottom];
  const room = rows - 4;
  const shown = body.slice(0, room);
  while (shown.length < room) shown.push("");
  return [top, "", ...shown, "", bottom];
}

/** A dim rule across the page. */
export function rule(width: number, theme?: LineTheme): string {
  const t = theme ?? PLAIN_THEME;
  return t.fg("borderMuted", "─".repeat(Math.max(0, width)));
}

/** `room` lines of `lines` with `from`..`to` in view, marking what is hidden. */
export function windowBlock(lines: string[], from: number, to: number, room: number, theme?: LineTheme): string[] {
  const t = theme ?? PLAIN_THEME;
  if (lines.length <= room) return lines;
  if (room < 3) {
    const start = Math.max(0, Math.min(from, lines.length - room));
    return lines.slice(start, start + room);
  }
  const c = room - 2;
  const height = Math.max(1, to - from + 1);
  // Centre the block when it fits, so a few lines either side give it context; otherwise its top.
  let start = height >= c ? from : from - Math.floor((c - height + 1) / 2);
  start = Math.max(0, Math.min(start, lines.length - c));
  let end = start + c;
  // A marker is only drawn where something is hidden, so its line goes to the list instead.
  if (start === 0) end += 1;
  else if (end >= lines.length) start -= 1;
  return [
    ...(start > 0 ? [t.fg("muted", "  ↑ more above")] : []),
    ...lines.slice(start, end),
    ...(end < lines.length ? [t.fg("muted", "  ↓ more below")] : []),
  ];
}
