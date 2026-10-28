// Seven runs, one glyph each. Failures get their own mark: a skipped run is often exactly right.
import { outcomeGlyph } from "./glyphs.js";
export function sparkline(outcomes, width = 7) {
    if (outcomes.length === 0)
        return "";
    const recent = outcomes.slice(-width);
    return recent.map(outcomeGlyph).join("");
}
/** A short, human summary of the same data, for surfaces with no room for glyphs. */
export function summarise(outcomes) {
    if (outcomes.length === 0)
        return "never run";
    const counts = new Map();
    for (const o of outcomes)
        counts.set(o, (counts.get(o) ?? 0) + 1);
    return [...counts.entries()].map(([o, n]) => `${n} ${o}`).join(" · ");
}
//# sourceMappingURL=sparkline.js.map