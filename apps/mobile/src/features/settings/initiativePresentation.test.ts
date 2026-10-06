import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  initiativeCoordinatorChoices,
  initiativeDraft,
  initiativeUpdateFromDraft,
} from "./initiativePresentation";

const environmentId = EnvironmentId.make("environment-one");
const projectId = ProjectId.make("project-one");
const thread = (
  id: string,
  overrides: Partial<Parameters<typeof initiativeCoordinatorChoices>[0][number]> = {},
) => ({
  id: ThreadId.make(id),
  title: id,
  environmentId,
  projectId,
  archivedAt: null,
  ...overrides,
});

describe("initiative updates while coordinator progress changes", () => {
  const initial = {
    ...initiativeDraft(),
    title: "Migration",
    objective: "Migrate the API",
    plan: "Inspect the API",
    results: "",
    coordinatorThreadId: ThreadId.make("coordinator-one"),
  };

  it("updates only the edited title and preserves a newer coordinator plan and results", () => {
    const draft = { ...initial, title: "API migration" };
    const latest = {
      ...initial,
      plan: "Implement the first endpoint",
      results: "Research complete",
    };
    const update = initiativeUpdateFromDraft("initiative-one", initial, draft, latest);
    expect(update).toEqual({ id: "initiative-one", title: "API migration" });
    expect({ ...latest, ...update }).toMatchObject({
      title: "API migration",
      plan: "Implement the first endpoint",
      results: "Research complete",
    });
  });

  it("rejects a same-field concurrent edit with instructions for retaining the user's work", () => {
    const draft = { ...initial, plan: "Migrate the authentication endpoint first" };
    const latest = { ...initial, plan: "Migrate the health endpoint first" };
    expect(() => initiativeUpdateFromDraft("initiative-one", initial, draft, latest)).toThrow(
      "Plan changed while you were editing. Copy your edits, reopen the initiative, and apply them to its latest brief. Your edits have not been saved.",
    );
  });

  it("sends a replacement coordinator only when its selection changed", () => {
    expect(initiativeUpdateFromDraft("initiative-one", initial, initial, initial)).toEqual({
      id: "initiative-one",
    });
    const coordinatorThreadId = ThreadId.make("coordinator-two");
    expect(
      initiativeUpdateFromDraft(
        "initiative-one",
        initial,
        { ...initial, coordinatorThreadId },
        initial,
      ),
    ).toEqual({ id: "initiative-one", coordinatorThreadId });
  });

  it("accepts matching concurrent edits without sending the field again", () => {
    const draft = { ...initial, plan: "Implement the first endpoint" };
    expect(initiativeUpdateFromDraft("initiative-one", initial, draft, draft)).toEqual({
      id: "initiative-one",
    });
  });
});

describe("initiative coordinator selection", () => {
  it("keeps coordinator candidates scoped to the selected remote environment and project", () => {
    const candidates = [
      thread("local"),
      thread("remote", { environmentId: EnvironmentId.make("environment-two") }),
      thread("another-project", { projectId: ProjectId.make("project-two") }),
      thread("archived", { archivedAt: "2026-10-06T00:00:00.000Z" }),
    ];
    expect(
      initiativeCoordinatorChoices(candidates, environmentId, projectId, []).map(
        (entry) => entry.id,
      ),
    ).toEqual(["local"]);
  });

  it("reserves coordinators for their initiative while letting its own editor retain the selection", () => {
    const candidates = [thread("coordinator-one"), thread("coordinator-two"), thread("available")];
    const initiatives = [
      { id: "initiative-one", coordinatorThreadId: ThreadId.make("coordinator-one") },
      { id: "initiative-two", coordinatorThreadId: ThreadId.make("coordinator-two") },
    ];
    expect(
      initiativeCoordinatorChoices(candidates, environmentId, projectId, initiatives).map(
        (entry) => entry.id,
      ),
    ).toEqual(["available"]);
    expect(
      initiativeCoordinatorChoices(
        candidates,
        environmentId,
        projectId,
        initiatives,
        "initiative-one",
      ).map((entry) => entry.id),
    ).toEqual(["coordinator-one", "available"]);
  });

  it("keeps an archived current coordinator available when editing its saved brief", () => {
    const candidates = [thread("archived-current", { archivedAt: "2026-10-06T00:00:00.000Z" })];
    const initiatives = [
      { id: "initiative-one", coordinatorThreadId: ThreadId.make("archived-current") },
    ];
    expect(
      initiativeCoordinatorChoices(
        candidates,
        environmentId,
        projectId,
        initiatives,
        "initiative-one",
      ).map((entry) => entry.id),
    ).toEqual(["archived-current"]);
  });
});
