import type { UserMessagePresentation } from "@t3tools/contracts/settings";

export function applyUserMessagePresentation(
  root: HTMLElement,
  presentation: UserMessagePresentation,
): void {
  root.dataset.userMessagePresentation = presentation;
}
