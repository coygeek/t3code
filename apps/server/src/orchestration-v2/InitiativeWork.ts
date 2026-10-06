import type { OrchestrationV2Actor } from "@t3tools/contracts";

/** Explicit user direction remains available while automatic initiative work is paused. */
export function isAutomaticInitiativeMessage(input: {
  readonly createdBy: OrchestrationV2Actor;
}): boolean {
  return input.createdBy !== "user";
}
