import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-08-30T00:00:00.000Z";
const projectId = ProjectId.make("project-model-default");
const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

function decodeSingleEvent(result: unknown, sequence: number): OrchestrationEvent {
  const candidate = Array.isArray(result) ? result[0] : result;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    (Array.isArray(result) && result.length !== 1)
  ) {
    throw new Error("Expected exactly one orchestration event.");
  }
  return decodeEvent({ ...candidate, sequence });
}

it.effect("treats project creation as unconfigured and metadata updates as explicit defaults", () =>
  Effect.gen(function* () {
    const created = yield* decideOrchestrationCommand({
      command: {
        type: "project.create",
        commandId: CommandId.make("command-project-create"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-model-default",
        // Older clients supplied an automatic seed here. The domain must not
        // interpret that legacy field as a user-configured project default.
        defaultModelSelection: selection,
        createdAt,
      },
      readModel: createEmptyReadModel(createdAt),
    });
    const createdEvent = decodeSingleEvent(created, 1);
    if (createdEvent.type !== "project.created") {
      throw new Error("Expected one project.created event.");
    }
    expect(createdEvent.payload.defaultModelSelection).toBeNull();

    const withProject = yield* projectEvent(createEmptyReadModel(createdAt), createdEvent);
    const updated = yield* decideOrchestrationCommand({
      command: {
        type: "project.meta.update",
        commandId: CommandId.make("command-project-default-update"),
        projectId,
        defaultModelSelection: selection,
      },
      readModel: withProject,
    });
    const updatedEvent = decodeSingleEvent(updated, 2);
    if (updatedEvent.type !== "project.meta-updated") {
      throw new Error("Expected one project.meta-updated event.");
    }
    expect(updatedEvent.payload.defaultModelSelection).toEqual(selection);
  }).pipe(Effect.provide(NodeServices.layer)),
);
