import { describe, expect, it, vi } from "vite-plus/test";

import { getStandardThemeColors } from "./themePalette";
import {
  applyUserMessagePresentation,
  HIGH_CONTRAST_USER_MESSAGE_FOREGROUND_VARIABLE,
  HIGH_CONTRAST_USER_MESSAGE_SURFACE_VARIABLE,
} from "./userMessagePresentation";

function makeRoot() {
  const setProperty = vi.fn();
  const dataset: DOMStringMap = {};
  return {
    root: { dataset, style: { setProperty } } as unknown as HTMLElement,
    dataset,
    setProperty,
  };
}

describe("applyUserMessagePresentation", () => {
  it("applies preference changes immediately without replacing subtle semantic colors", () => {
    const { root, dataset, setProperty } = makeRoot();
    const colors = getStandardThemeColors("light");

    applyUserMessagePresentation(root, "high-contrast", colors);
    expect(dataset.userMessagePresentation).toBe("high-contrast");

    applyUserMessagePresentation(root, "subtle", colors);
    expect(dataset.userMessagePresentation).toBe("subtle");
    expect(setProperty).toHaveBeenCalledWith(
      HIGH_CONTRAST_USER_MESSAGE_SURFACE_VARIABLE,
      expect.stringMatching(/^oklch\(/),
    );
    expect(setProperty).toHaveBeenCalledWith(
      HIGH_CONTRAST_USER_MESSAGE_FOREGROUND_VARIABLE,
      expect.stringMatching(/^oklch\(/),
    );
    expect(setProperty).not.toHaveBeenCalledWith("--message-surface", expect.anything());
    expect(setProperty).not.toHaveBeenCalledWith("--message-foreground", expect.anything());
  });
});
