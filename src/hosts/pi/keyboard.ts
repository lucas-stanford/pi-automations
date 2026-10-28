import type { KeyId } from "@earendil-works/pi-tui";

/** Supplied by the extension entry so the compiled library stays SDK-free at runtime. */
export type KeyMatcher = (data: string, key: KeyId) => boolean;

const PANEL_KEYS: readonly (readonly [KeyId, string])[] = [
  ["escape", "\u001b"],
  ["enter", "\r"],
  ["up", "\u001b[A"],
  ["down", "\u001b[B"],
  ["pageUp", "\u001b[5~"],
  ["pageDown", "\u001b[6~"],
  ["home", "\u001b[H"],
  ["end", "\u001b[F"],
  ["space", " "],
];

/** Map pi's key protocols to canonical key strings. Ctrl+C cancels the interaction, not the run. */
export function withPanelKeyboard<T extends { handleInput(data: string): void }>(
  component: T,
  matchesKey: KeyMatcher | undefined,
  cancel: () => void,
): T {
  if (!matchesKey) return component;
  const handleInput = component.handleInput.bind(component);
  component.handleInput = (data: string): void => {
    if (matchesKey(data, "ctrl+c")) {
      cancel();
      return;
    }
    for (const [key, canonical] of PANEL_KEYS) {
      if (matchesKey(data, key)) {
        handleInput(canonical);
        return;
      }
    }
    handleInput(data);
  };
  return component;
}
