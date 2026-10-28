// Colour: `LineTheme` is a structural subset of pi's `Theme`.
/** Bold text, or the text alone when the theme cannot do bold. */
export function strong(theme, text) {
    return theme.bold ? theme.bold(text) : text;
}
/** One soft colour per section of the `/automations` page; a deeper shade of each for light themes. */
export const SECTION_PASTEL = {
    needs: { dark: [244, 167, 185], light: [180, 70, 106] },
    running: { dark: [156, 203, 247], light: [47, 111, 168] },
    coming: { dark: [195, 177, 225], light: [107, 79, 160] },
    watching: { dark: [168, 230, 207], light: [46, 139, 106] },
    off: { dark: [200, 194, 180], light: [122, 116, 102] },
};
/** A section heading: bold, in its pastel when the theme can draw colour, else bold alone. */
export function sectionHeading(theme, tone, text) {
    const bold = strong(theme, text);
    const mode = theme.getColorMode?.();
    if (!mode || process.env.NO_COLOR)
        return bold;
    const [r, g, b] = SECTION_PASTEL[tone][onLightBackground(theme) ? "light" : "dark"];
    const open = mode === "truecolor" ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${ansi256(r, g, b)}m`;
    return `${open}${bold}\x1b[39m`;
}
/** The theme's text colour is dark, so the background is light. Unknown means dark, as most terminals are. */
function onLightBackground(theme) {
    const rgb = ansiRgb(theme.getFgAnsi?.("text") ?? "");
    return rgb !== undefined && 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128;
}
function ansiRgb(code) {
    const tc = /38;2;(\d+);(\d+);(\d+)/.exec(code);
    if (tc)
        return [Number(tc[1]), Number(tc[2]), Number(tc[3])];
    const n = /38;5;(\d+)/.exec(code);
    if (!n)
        return undefined;
    const i = Number(n[1]);
    if (i >= 232) {
        const v = 8 + (i - 232) * 10;
        return [v, v, v];
    }
    if (i < 16)
        return i === 0 || i === 8 ? [0, 0, 0] : i === 7 || i === 15 ? [255, 255, 255] : undefined;
    const c = i - 16;
    const step = (x) => (x === 0 ? 0 : 55 + x * 40);
    return [step(Math.floor(c / 36)), step(Math.floor(c / 6) % 6), step(c % 6)];
}
function ansi256(r, g, b) {
    const q = (x) => Math.round((x / 255) * 5);
    return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
/** Used when there is no theme: every surface must render without colour. */
export const PLAIN_THEME = { fg: (_c, text) => text };
//# sourceMappingURL=theme.js.map