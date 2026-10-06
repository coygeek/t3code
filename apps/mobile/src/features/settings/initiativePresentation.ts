import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  type Initiative,
  type InitiativeUpdateInput,
  type ProjectId,
} from "@t3tools/contracts";

export const initiativeFields = [
  { key: "title", label: "Name" },
  { key: "objective", label: "Objective" },
  { key: "definitionOfDone", label: "Definition of done" },
  { key: "brief", label: "Requirements and constraints" },
  { key: "plan", label: "Plan" },
  { key: "decisions", label: "Decisions" },
  { key: "links", label: "Research and artifact links" },
  { key: "blockers", label: "Blockers" },
  { key: "userActions", label: "Needs your attention" },
  { key: "results", label: "Results" },
] as const;

export type InitiativeDraft = Pick<Initiative, (typeof initiativeFields)[number]["key"]> & {
  readonly coordinatorThreadId: Initiative["coordinatorThreadId"] | null;
};

export function initiativeDraft(initiative?: Initiative): InitiativeDraft {
  return {
    title: initiative?.title ?? "",
    objective: initiative?.objective ?? "",
    definitionOfDone: initiative?.definitionOfDone ?? "",
    brief: initiative?.brief ?? "",
    plan: initiative?.plan ?? "",
    decisions: initiative?.decisions ?? "",
    links: initiative?.links ?? "",
    blockers: initiative?.blockers ?? "",
    userActions: initiative?.userActions ?? "",
    results: initiative?.results ?? "",
    coordinatorThreadId: initiative?.coordinatorThreadId ?? null,
  };
}

export function initiativeUpdateFromDraft(
  id: string,
  initial: InitiativeDraft,
  draft: InitiativeDraft,
  latest: InitiativeDraft,
): InitiativeUpdateInput {
  const next = { ...draft, title: draft.title.trim(), objective: draft.objective.trim() };
  const input: InitiativeUpdateInput = { id };
  const conflicts: string[] = [];
  for (const field of initiativeFields) {
    if (next[field.key] === initial[field.key] || next[field.key] === latest[field.key]) continue;
    if (latest[field.key] !== initial[field.key]) conflicts.push(field.label);
    else Object.assign(input, { [field.key]: next[field.key] });
  }
  if (
    next.coordinatorThreadId !== initial.coordinatorThreadId &&
    next.coordinatorThreadId !== latest.coordinatorThreadId
  ) {
    if (latest.coordinatorThreadId !== initial.coordinatorThreadId) {
      conflicts.push("Coordinator conversation");
    } else if (next.coordinatorThreadId === null) {
      throw new Error("Choose an available coordinator before saving.");
    } else {
      Object.assign(input, { coordinatorThreadId: next.coordinatorThreadId });
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `${conflicts.join(", ")} changed while you were editing. Copy your edits, reopen the initiative, and apply them to its latest brief. Your edits have not been saved.`,
    );
  }
  return input;
}

export function initiativeCoordinatorChoices(
  threads: readonly (Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "id" | "title" | "archivedAt"
  > &
    Partial<Pick<EnvironmentThreadShell, "lineage">>)[],
  environmentId: EnvironmentId,
  projectId: ProjectId,
  initiatives: readonly Pick<Initiative, "id" | "coordinatorThreadId">[],
  initiativeId?: string,
) {
  const occupied = new Set(
    initiatives
      .filter((initiative) => initiative.id !== initiativeId)
      .map((initiative) => initiative.coordinatorThreadId),
  );
  const currentCoordinator = initiatives.find(
    (initiative) => initiative.id === initiativeId,
  )?.coordinatorThreadId;
  return threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === projectId &&
      (thread.archivedAt === null || thread.id === currentCoordinator) &&
      thread.lineage?.relationshipToParent !== "subagent" &&
      !occupied.has(thread.id),
  );
}

export const initiativeStatusLabel = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
} as const;

export const initiativeStatusEffect = {
  active: "Automatic work is allowed. Completing a worker does not complete this initiative.",
  paused:
    "New automatic coordinator turns are paused. Running coordinator and worker turns continue until you stop them in their conversations.",
  completed:
    "New automatic work is stopped. The brief, decisions, workers, and results remain available when you reopen.",
} as const;
