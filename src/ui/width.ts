// Column widths for lines that carry SGR colour. Our own, since `src/` never imports pi-tui.

// Control sequences that occupy no columns: CSI (colour), OSC (hyperlinks) and APC (pi's cursor).
const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[0-9;:?]*[ -/]*[@-~]|\u001B[\]_P^][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

/** Strip every non-printing sequence, leaving exactly the characters a terminal shows. */
export function stripAnsi(s: string): string {
  return s.replace(CONTROL_RE, "");
}

// eslint-disable-next-line no-control-regex
const C0_C1 = /[\u0000-\u001F\u007F-\u009F]/g;
// eslint-disable-next-line no-control-regex
const C0_C1_BUT_LINES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Remove control characters from outside text so it cannot start an escape sequence. */
export function stripControls(s: string, keepLines = false): string {
  return s.replace(keepLines ? C0_C1_BUT_LINES : C0_C1, "");
}

/** Columns a code point occupies: the standard wcwidth partition (0, 1 or 2), not a full table. */
function charWidth(cp: number): number {
  if (cp === 0x200b || cp === 0x200d || cp === 0xfeff) return 0;
  // Combining marks.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Columns the string occupies once the terminal has consumed its escape sequences. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

const RESET = "\u001B[0m";

/** Cut to `max` columns keeping colour intact; a straddling wide character is dropped. */
export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(s) <= max) return s;

  let out = "";
  let w = 0;
  let sawEscape = false;

  // Walk the string, copying control sequences verbatim and counting everything else.
  let i = 0;
  while (i < s.length) {
    CONTROL_RE.lastIndex = i;
    const m = CONTROL_RE.exec(s);
    if (m && m.index === i) {
      out += m[0];
      sawEscape = true;
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > max) break;
    out += ch;
    w += cw;
    i += ch.length;
  }

  CONTROL_RE.lastIndex = 0;
  return sawEscape && !out.endsWith(RESET) ? out + RESET : out;
}

/** Pad on the right to `n` columns. Never truncates — callers decide what may be cut. */
export function padTo(s: string, n: number): string {
  const w = visibleWidth(s);
  return w >= n ? s : s + " ".repeat(n - w);
}

/** Pad on the left to `n` columns. */
export function padLeft(s: string, n: number): string {
  const w = visibleWidth(s);
  return w >= n ? s : " ".repeat(n - w) + s;
}

/** Truncate, then pad, so the result is exactly `n` columns wide. */
export function fitTo(s: string, n: number): string {
  return padTo(truncateToWidth(s, n), n);
}

/** Hard-wrap into chunks of at most `n` columns, losing nothing (for data such as JSON). */
export function wrapHard(s: string, n: number): string[] {
  if (n <= 0) return [s];
  if (visibleWidth(s) <= n) return [s];
  const out: string[] = [];
  let rest = s;
  // Bounded by the string's own length: every pass consumes at least one character.
  while (visibleWidth(rest) > n) {
    const head = truncateToWidth(rest, n);
    const consumed = stripAnsi(head).length;
    if (consumed === 0) break;
    out.push(head);
    rest = stripAnsi(rest).slice(consumed);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Cut to `max` columns and end with `…` when anything was cut. */
export function ellipsize(s: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(s) <= max) return s;
  if (max === 1) return "…";
  return `${truncateToWidth(s, max - 1)}…`;
}

/** Wrap at spaces with a hanging indent, so continuation lines start under the value. */
export function wrapHanging(s: string, width: number): string[] {
  if (width <= 0) return [s];
  if (visibleWidth(s) <= width) return [s];
  const plain = stripAnsi(s);
  const lead = (plain.match(/^ */) as RegExpMatchArray)[0].length;
  const label = plain.match(/^(\s*\S(?:.*?\S)?\s{2,})\S/);
  let indent = label && visibleWidth(label[1] as string) <= Math.floor(width / 2) ? visibleWidth(label[1] as string) : lead + 2;
  if (indent >= width - 8) indent = Math.min(lead, 2);
  const pad = " ".repeat(indent);

  const out: string[] = [];
  let line = " ".repeat(lead);
  const flush = (): void => {
    out.push(line.replace(/\s+$/, ""));
    line = pad;
  };
  for (const word of s.slice(lead).split(" ")) {
    if (word === "") {
      line += " ";
      continue;
    }
    const sep = line.trim() === "" ? "" : " ";
    if (visibleWidth(line) + visibleWidth(sep) + visibleWidth(word) <= width) {
      line += `${sep}${word}`;
      continue;
    }
    const fitsAlone = visibleWidth(word) <= width - indent;
    if (line.trim() !== "" && (fitsAlone || width - visibleWidth(line) - 1 < 8)) flush();
    else if (line.trim() !== "") line += " ";
    let rest = word;
    while (visibleWidth(line) + visibleWidth(rest) > width) {
      let take = truncateToWidth(rest, Math.max(1, width - visibleWidth(line)));
      // A path breaks after a separator rather than in the middle of a name.
      const plainTake = stripAnsi(take);
      const sep = Math.max(plainTake.lastIndexOf("\\"), plainTake.lastIndexOf("/"));
      if (plainTake === take && sep > plainTake.length / 2) take = plainTake.slice(0, sep + 1);
      const consumed = stripAnsi(take).length;
      if (consumed === 0) break;
      line += take;
      rest = stripAnsi(rest).slice(consumed);
      flush();
    }
    line += rest;
  }
  if (line.trim() !== "") out.push(line.replace(/\s+$/, ""));
  return out;
}
