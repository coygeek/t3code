import { describe, expect, it, vi } from "vite-plus/test";

import { applyUserMessagePresentation } from "./userMessagePresentation";

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
    applyUserMessagePresentation(root, "high-contrast");
    expect(dataset.userMessagePresentation).toBe("high-contrast");

    applyUserMessagePresentation(root, "subtle");
    expect(dataset.userMessagePresentation).toBe("subtle");
    expect(setProperty).not.toHaveBeenCalled();
    expect(setProperty).not.toHaveBeenCalledWith("--message-surface", expect.anything());
    expect(setProperty).not.toHaveBeenCalledWith("--message-foreground", expect.anything());
  });
});
