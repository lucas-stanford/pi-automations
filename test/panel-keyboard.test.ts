import { describe, expect, it, vi } from "vitest";
import { matchesKey } from "@earendil-works/pi-tui";
import { withPanelKeyboard } from "../src/hosts/pi/keyboard.js";

function harness() {
  const input = vi.fn();
  const cancel = vi.fn();
  const component = { handleInput: input, render: () => [], dispose: vi.fn() };
  const adapted = withPanelKeyboard(component, matchesKey, cancel);
  return { input, cancel, component, adapted };
}

describe("Pi panel keyboard protocols", () => {
  it.each(["\u001b", "\u001b[27u", "\u001b[27;1u", "\u001b[27;1:1u", "\u001b[27;1;27~"])(
    "normalizes Escape %j", (data) => {
      const h = harness();
      h.adapted.handleInput(data);
      expect(h.input).toHaveBeenCalledExactlyOnceWith("\u001b");
      expect(h.cancel).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["\u001b[13u", "\r"],
    ["\u001bOA", "\u001b[A"],
    ["\u001b[1;1B", "\u001b[B"],
    ["\u001b[5;1~", "\u001b[5~"],
    ["\u001b[6;1~", "\u001b[6~"],
    ["\u001b[1;1H", "\u001b[H"],
    ["\u001b[1;1F", "\u001b[F"],
    ["\u001b[32u", " "],
  ])("normalizes navigation %j", (data, expected) => {
    const h = harness();
    h.adapted.handleInput(data);
    expect(h.input).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each(["\u0003", "\u001b[99;5u"])("Ctrl+C %j cancels only the panel", (data) => {
    const h = harness();
    h.adapted.handleInput(data);
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.input).not.toHaveBeenCalled();
  });

  it.each(["v", "R", "\u001b[27;2u", "\u001b[1;5A", "\u001b[200~paste\u001b[201~"])(
    "leaves unrelated input %j unchanged", (data) => {
      const h = harness();
      h.adapted.handleInput(data);
      expect(h.input).toHaveBeenCalledExactlyOnceWith(data);
      expect(h.cancel).not.toHaveBeenCalled();
    },
  );

  it("preserves component identity, lifecycle and method binding", () => {
    const component = {
      received: "",
      handleInput(data: string) { this.received = data; },
      dispose: vi.fn(),
    };
    const adapted = withPanelKeyboard(component, matchesKey, vi.fn());
    expect(adapted).toBe(component);
    adapted.handleInput("\u001b[27u");
    expect(component.received).toBe("\u001b");
    adapted.dispose();
    expect(component.dispose).toHaveBeenCalledOnce();
  });
});
