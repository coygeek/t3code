import type { UserMessagePresentation } from "@t3tools/contracts/settings";

import { resolveHighContrastUserMessageColors, type ThemeColors } from "./themePalette";

export const HIGH_CONTRAST_USER_MESSAGE_SURFACE_VARIABLE = "--user-message-high-contrast-surface";
export const HIGH_CONTRAST_USER_MESSAGE_FOREGROUND_VARIABLE =
  "--user-message-high-contrast-foreground";

export function applyUserMessagePresentation(
  root: HTMLElement,
  presentation: UserMessagePresentation,
  colors: ThemeColors,
): void {
  const highContrast = resolveHighContrastUserMessageColors(colors);
  root.style.setProperty(HIGH_CONTRAST_USER_MESSAGE_SURFACE_VARIABLE, highContrast.messageSurface);
  root.style.setProperty(
    HIGH_CONTRAST_USER_MESSAGE_FOREGROUND_VARIABLE,
    highContrast.messageForeground,
  );
  root.dataset.userMessagePresentation = presentation;
}
