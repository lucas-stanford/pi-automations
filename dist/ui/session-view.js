// Rendering a session transcript, and choosing which decoder reads a reference. Format-agnostic.
import { truncateToWidth, visibleWidth } from "./width.js";
/** Choose a decoder from the reference alone, so an empty transcript still reports its format. */
export function decodeTranscript(text, ref, readers) {
    const format = ref?.format;
    if (format === undefined || format === "") {
        return { ok: true, parsed: readers.legacy(text) };
    }
    const alternative = readers.alternative;
    if (alternative && format === alternative.format) {
        return { ok: true, parsed: alternative.decode(text) };
    }
    return { ok: false, unsupported: format };
}
/** What the pane says about a format nothing here can read. */
export function unsupportedFormatLines(format, width, theme) {
    if (width <= 0)
        return [];
    const fg = theme?.fg ?? ((_c, t) => t);
    return [
        fg("dim", truncateToWidth(`unsupported transcript format ${JSON.stringify(format)}`, width)),
        fg("dim", truncateToWidth(`use a host with a decoder for ${JSON.stringify(format)}`, width)),
    ];
}
const PREFIX = {
    partial: "  ",
    text: "  ",
    thinking: "  ",
    tool: "▸ ",
    result: "  ↳ ",
    user: "› ",
    note: "  ",
};
const COLOR = {
    // Still arriving, but drawn as ordinary text: it is the newest thing that happened.
    partial: "text",
    text: "text",
    thinking: "dim",
    tool: "accent",
    result: "dim",
    user: "text",
    note: "dim",
};
/** One source line becomes one rendered line, so the pane does not reflow as it grows. */
export function buildSessionLines(lines, opts) {
    const theme = opts.theme ?? { fg: (_c, t) => t };
    // No minimum width: a row with no room is not drawn.
    const width = opts.width;
    const out = [];
    for (const l of lines) {
        if (l.kind === "thinking" && opts.showThinking !== true)
            continue;
        const prefix = PREFIX[l.kind];
        const room = width - visibleWidth(prefix);
        if (room <= 0)
            continue;
        out.push(theme.fg(COLOR[l.kind], prefix + truncateToWidth(l.text, room)));
    }
    return out;
}
//# sourceMappingURL=session-view.js.map