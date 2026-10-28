const PANEL_KEYS = [
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
export function withPanelKeyboard(component, matchesKey, cancel) {
    if (!matchesKey)
        return component;
    const handleInput = component.handleInput.bind(component);
    component.handleInput = (data) => {
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
//# sourceMappingURL=keyboard.js.map