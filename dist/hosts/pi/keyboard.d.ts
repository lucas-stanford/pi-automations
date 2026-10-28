import type { KeyId } from "@earendil-works/pi-tui";
/** Supplied by the extension entry so the compiled library stays SDK-free at runtime. */
export type KeyMatcher = (data: string, key: KeyId) => boolean;
/** Map pi's key protocols to canonical key strings. Ctrl+C cancels the interaction, not the run. */
export declare function withPanelKeyboard<T extends {
    handleInput(data: string): void;
}>(component: T, matchesKey: KeyMatcher | undefined, cancel: () => void): T;
