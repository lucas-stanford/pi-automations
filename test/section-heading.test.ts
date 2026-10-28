import { afterEach, describe, expect, it, vi } from "vitest";
import { type LineTheme, PLAIN_THEME, SECTION_PASTEL, sectionHeading } from "../src/ui/theme.js";

const themed = (mode: "truecolor" | "256color", text: string): LineTheme => ({
  fg: (_c, t) => t,
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  getColorMode: () => mode,
  getFgAnsi: () => text,
});

describe("sectionHeading", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is bold alone when the theme cannot draw colour", () => {
    expect(sectionHeading(PLAIN_THEME, "needs", "Needs you")).toBe("Needs you");
    expect(sectionHeading({ fg: (_c, t) => t, bold: (t) => `*${t}*` }, "needs", "Needs you")).toBe("*Needs you*");
  });

  it("draws each section in its pastel on a dark background", () => {
    const [r, g, b] = SECTION_PASTEL.running.dark;
    expect(sectionHeading(themed("truecolor", "\x1b[38;2;230;230;230m"), "running", "Running now")).toBe(
      `\x1b[38;2;${r};${g};${b}m\x1b[1mRunning now\x1b[22m\x1b[39m`,
    );
  });

  it("uses the deeper shade when the theme's text is dark", () => {
    const [r, g, b] = SECTION_PASTEL.watching.light;
    expect(sectionHeading(themed("truecolor", "\x1b[38;2;30;30;30m"), "watching", "Watching")).toContain(
      `\x1b[38;2;${r};${g};${b}m`,
    );
  });

  it("falls back to the 256-colour cube", () => {
    expect(sectionHeading(themed("256color", "\x1b[38;5;252m"), "coming", "Coming up")).toMatch(/^\x1b\[38;5;\d+m/);
  });

  it("respects NO_COLOR", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(sectionHeading(themed("truecolor", ""), "off", "Off and disabled")).toBe("\x1b[1mOff and disabled\x1b[22m");
  });

  it("gives every section a colour of its own", () => {
    const dark = Object.values(SECTION_PASTEL).map((p) => p.dark.join());
    expect(new Set(dark).size).toBe(dark.length);
  });
});
