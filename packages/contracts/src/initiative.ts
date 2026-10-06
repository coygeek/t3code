import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const InitiativeStatus = Schema.Literals(["active", "paused", "completed"]);
export type InitiativeStatus = typeof InitiativeStatus.Type;

const metadata = {
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  definitionOfDone: Schema.String,
  brief: Schema.String,
  plan: Schema.String,
  decisions: Schema.String,
  links: Schema.String,
  blockers: Schema.String,
  userActions: Schema.String,
  results: Schema.String,
};

export const InitiativeWorker = Schema.Struct({
  threadId: ThreadId,
  parentThreadId: ThreadId,
  title: Schema.String,
  status: Schema.Literals([
    "idle",
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  result: Schema.NullOr(Schema.String),
});
export type InitiativeWorker = typeof InitiativeWorker.Type;

export const Initiative = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  coordinatorThreadId: ThreadId,
  ...metadata,
  status: InitiativeStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  coordinatorMissing: Schema.Boolean,
  workers: Schema.Array(InitiativeWorker),
});
export type Initiative = typeof Initiative.Type;

export const InitiativeListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type InitiativeListInput = typeof InitiativeListInput.Type;
export const InitiativeListResult = Schema.Struct({ initiatives: Schema.Array(Initiative) });
export type InitiativeListResult = typeof InitiativeListResult.Type;

export const InitiativeCreateInput = Schema.Struct({
  projectId: ProjectId,
  coordinatorThreadId: ThreadId,
  title: metadata.title,
  objective: metadata.objective,
  definitionOfDone: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  decisions: Schema.optional(Schema.String),
  links: Schema.optional(Schema.String),
  blockers: Schema.optional(Schema.String),
  userActions: Schema.optional(Schema.String),
  results: Schema.optional(Schema.String),
});
export type InitiativeCreateInput = typeof InitiativeCreateInput.Type;
export const InitiativeUpdateInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  coordinatorThreadId: Schema.optional(ThreadId),
  title: Schema.optional(metadata.title),
  objective: Schema.optional(metadata.objective),
  definitionOfDone: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  decisions: Schema.optional(Schema.String),
  links: Schema.optional(Schema.String),
  blockers: Schema.optional(Schema.String),
  userActions: Schema.optional(Schema.String),
  results: Schema.optional(Schema.String),
});
export type InitiativeUpdateInput = typeof InitiativeUpdateInput.Type;
export const InitiativeSetStatusInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: InitiativeStatus,
});
export type InitiativeSetStatusInput = typeof InitiativeSetStatusInput.Type;
export class InitiativeError extends Schema.TaggedError<InitiativeError>()("InitiativeError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
