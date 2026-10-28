/** The colour names this package uses. A strict subset of pi's `ThemeColor`. */
export type UiColor = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text" | "toolTitle" | "border" | "borderMuted" | "borderAccent";
export interface LineTheme {
    fg(color: UiColor, text: string): string;
    /** pi's theme has these; a plain theme does not, and every caller copes with that. */
    bg?(color: UiBg, text: string): string;
    bold?(text: string): string;
    getColorMode?(): "truecolor" | "256color";
    getFgAnsi?(color: UiColor): string;
}
/** The background colours this package uses. A strict subset of pi's `ThemeBg`. */
export type UiBg = "selectedBg" | "toolSuccessBg" | "toolErrorBg" | "toolPendingBg";
/** Bold text, or the text alone when the theme cannot do bold. */
export declare function strong(theme: LineTheme, text: string): string;
export type SectionTone = "needs" | "running" | "coming" | "watching" | "off";
type Rgb = readonly [number, number, number];
/** One soft colour per section of the `/automations` page; a deeper shade of each for light themes. */
export declare const SECTION_PASTEL: Record<SectionTone, {
    dark: Rgb;
    light: Rgb;
}>;
/** A section heading: bold, in its pastel when the theme can draw colour, else bold alone. */
export declare function sectionHeading(theme: LineTheme, tone: SectionTone, text: string): string;
/** Used when there is no theme: every surface must render without colour. */
export declare const PLAIN_THEME: LineTheme;
export {};
