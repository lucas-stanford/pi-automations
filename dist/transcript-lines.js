// The line shape between transcript decoders and renderers.
/** Collapse to one line: a pane shows shape, and the full text is in the session file. */
export function flattenText(s) {
    return s.replace(/\s+/g, " ").trim();
}
/** Successive drafts collapse to one line, and a settled line replaces its draft. */
export function collapseSessionLines(lines) {
    const out = [];
    for (const l of lines) {
        const prev = out[out.length - 1];
        if (!prev) {
            out.push(l);
            continue;
        }
        const sameDraft = (l.kind === "partial" || l.kind === "thinking") && prev.kind === l.kind;
        const settles = (l.kind === "text" && prev.kind === "partial") ||
            (l.kind === "thinking" && prev.kind === "thinking");
        if ((sameDraft || settles) && (l.text === prev.text || l.text.startsWith(prev.text))) {
            out[out.length - 1] = l;
            continue;
        }
        out.push(l);
    }
    return out;
}
//# sourceMappingURL=transcript-lines.js.map