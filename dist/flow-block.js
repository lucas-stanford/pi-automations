function linesOf(markdown) {
    const lines = [];
    let start = 0;
    for (let i = 0; i < markdown.length;) {
        const nl = markdown.indexOf("\n", i);
        if (nl === -1)
            break;
        const textEnd = nl > start && markdown[nl - 1] === "\r" ? nl - 1 : nl;
        lines.push({ start, end: nl + 1, textEnd, text: markdown.slice(start, textEnd), eol: markdown.slice(textEnd, nl + 1) });
        i = nl + 1;
        start = i;
    }
    if (start < markdown.length) {
        lines.push({ start, end: markdown.length, textEnd: markdown.length, text: markdown.slice(start), eol: "" });
    }
    else if (markdown.length === 0) {
        lines.push({ start: 0, end: 0, textEnd: 0, text: "", eol: "" });
    }
    return lines;
}
function bodyStartLine(lines) {
    if ((lines[0]?.text ?? "") !== "---")
        return 0;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].text === "---" || lines[i].text === "...")
            return i + 1;
    }
    return 0;
}
function openingFence(line) {
    const m = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (!m)
        return null;
    const fence = m[2];
    const char = fence[0];
    const info = m[3];
    if (char === "`" && info.includes("`"))
        return null;
    return { indent: m[1], char, length: fence.length, info };
}
function isClosingFence(line, char, length) {
    const escaped = char === "`" ? "`" : "~";
    const re = new RegExp(`^ {0,3}${escaped}{${length},}\\s*$`);
    return re.test(line);
}
function firstInfoWord(info) {
    return info.trim().split(/\s+/)[0] ?? "";
}
function normalizeChart(raw, indent) {
    const withoutIndent = raw
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n")
        .map((line) => (indent && line.startsWith(indent) ? line.slice(indent.length) : line))
        .join("\n");
    return `${withoutIndent.replace(/\n*$/, "")}\n`;
}
function isFlowChart(text) {
    const first = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.startsWith("%%"));
    return first !== undefined && /^(flowchart|graph)\b/i.test(first);
}
function findFlowBlockMatch(markdown) {
    const lines = linesOf(markdown);
    for (let i = bodyStartLine(lines); i < lines.length; i++) {
        const open = openingFence(lines[i].text);
        if (!open)
            continue;
        let closeLine = -1;
        for (let j = i + 1; j < lines.length; j++) {
            if (isClosingFence(lines[j].text, open.char, open.length)) {
                closeLine = j;
                break;
            }
        }
        if (closeLine === -1)
            return null;
        const infoWord = firstInfoWord(open.info);
        if (/^mermaid$/i.test(infoWord)) {
            const contentStart = lines[i].end;
            const contentEnd = lines[closeLine].start;
            const text = normalizeChart(markdown.slice(contentStart, contentEnd), open.indent);
            if (isFlowChart(text)) {
                return {
                    text,
                    start: lines[i].start,
                    end: lines[closeLine].end,
                    contentStart,
                    contentEnd,
                    closeStart: lines[closeLine].start,
                    closeEnd: lines[closeLine].end,
                    indent: open.indent,
                    fenceChar: open.char,
                    fenceLength: open.length,
                };
            }
        }
        i = closeLine;
    }
    return null;
}
/** Find the first ```mermaid flowchart/graph block in an AUTOMATION.md body. */
export function findFlowBlock(markdown) {
    const match = findFlowBlockMatch(markdown);
    return match ? { text: match.text, start: match.start, end: match.end } : null;
}
function eolOf(text) {
    return text.includes("\r\n") ? "\r\n" : "\n";
}
function normalizedChart(chart) {
    return `${chart.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n*$/, "")}\n`;
}
function neededFenceLength(chart, char, current) {
    let needed = current;
    for (const line of normalizedChart(chart).split("\n")) {
        const m = new RegExp(`^ {0,3}(${char === "`" ? "`" : "~"}+)`).exec(line);
        if (m && m[1].length >= needed)
            needed = m[1].length + 1;
    }
    return needed;
}
function renderContent(chart, indent, eol) {
    const normalized = normalizedChart(chart);
    const lines = normalized.split("\n");
    return lines
        .slice(0, -1)
        .map((line) => `${indent}${line}`)
        .join(eol) + eol;
}
function lineIndexAt(lines, offset) {
    const found = lines.findIndex((line) => line.start <= offset && offset < line.end);
    if (found !== -1)
        return found;
    return Math.max(0, lines.length - 1);
}
function blankLineRangeBefore(lines, offset) {
    const idx = lineIndexAt(lines, offset) - 1;
    if (idx < 0)
        return null;
    const line = lines[idx];
    return line.text.trim() === "" ? { start: line.start, end: line.end } : null;
}
function blankLineRangeAfter(lines, offset) {
    const idx = lines.findIndex((line) => line.start === offset);
    if (idx === -1)
        return null;
    const line = lines[idx];
    return line.text.trim() === "" ? { start: line.start, end: line.end } : null;
}
function insertionPoint(markdown) {
    const lines = linesOf(markdown);
    const bodyLine = bodyStartLine(lines);
    let bodyStart = lines[bodyLine]?.start ?? markdown.length;
    if (bodyLine >= lines.length)
        bodyStart = markdown.length;
    for (let i = bodyLine; i < lines.length; i++) {
        const text = lines[i].text;
        if (text.trim() === "")
            continue;
        if (/^#{1,6}(?:\s|$)/.test(text.trimStart()))
            return lines[i].end;
        return bodyStart;
    }
    return bodyStart;
}
function newBlock(chart, eol) {
    const fenceLength = neededFenceLength(chart, "`", 3);
    const fence = "`".repeat(fenceLength);
    return `${fence}mermaid${eol}${renderContent(chart, "", eol)}${fence}${eol}`;
}
export function setFlowBlock(markdown, chart) {
    const match = findFlowBlockMatch(markdown);
    const eol = eolOf(markdown);
    if (match) {
        if (chart === null) {
            const lines = linesOf(markdown);
            const after = blankLineRangeAfter(lines, match.end);
            if (after)
                return markdown.slice(0, match.start) + markdown.slice(after.end);
            const before = blankLineRangeBefore(lines, match.start);
            if (before)
                return markdown.slice(0, before.start) + markdown.slice(match.end);
            return markdown.slice(0, match.start) + markdown.slice(match.end);
        }
        const fenceLength = neededFenceLength(chart, match.fenceChar, match.fenceLength);
        let openLine = markdown.slice(match.start, match.contentStart);
        let closeLine = markdown.slice(match.closeStart, match.closeEnd);
        if (fenceLength !== match.fenceLength) {
            const replacement = match.fenceChar.repeat(fenceLength);
            const old = match.fenceChar.repeat(match.fenceLength);
            openLine = openLine.replace(old, replacement);
            closeLine = closeLine.replace(old, replacement);
        }
        return markdown.slice(0, match.start)
            + openLine
            + renderContent(chart, match.indent, eol)
            + closeLine
            + markdown.slice(match.closeEnd);
    }
    if (chart === null)
        return markdown;
    const at = insertionPoint(markdown);
    const block = newBlock(chart, eol);
    const before = markdown.slice(0, at);
    const after = markdown.slice(at);
    const prefix = before === "" || before.endsWith(`${eol}${eol}`) ? "" : before.endsWith(eol) ? eol : `${eol}${eol}`;
    const suffix = after.startsWith(eol) ? "" : eol;
    return `${before}${prefix}${block}${suffix}${after}`;
}
//# sourceMappingURL=flow-block.js.map