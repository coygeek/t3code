import {
  OrchestratorMcpFailure,
  type Initiative,
  type InitiativeListResult,
  type InitiativeSetStatusInput,
  type InitiativeUpdateInput,
  type OrchestratorMcpInitiativeCreateInput,
  type OrchestratorMcpInitiativeListInput,
  type OrchestratorMcpInitiativeReadInput,
  type OrchestratorMcpInitiativeReadResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Initiatives from "../project/InitiativeService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  assertTargetWithinLimits,
  type Caller,
  readCaller,
  readMutationCaller,
  resolveProjectId,
  unavailable,
} from "./threadAccess.ts";

export class InitiativeMcpService extends Context.Service<
  InitiativeMcpService,
  {
    readonly list: (
      scope: McpInvocationContext.McpInvocationScope,
      input: OrchestratorMcpInitiativeListInput,
    ) => Effect.Effect<InitiativeListResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpInvocationContext.McpInvocationScope,
      input: OrchestratorMcpInitiativeReadInput,
    ) => Effect.Effect<OrchestratorMcpInitiativeReadResult, OrchestratorMcpFailure>;
    readonly create: (
      scope: McpInvocationContext.McpInvocationScope,
      input: OrchestratorMcpInitiativeCreateInput,
    ) => Effect.Effect<Initiative, OrchestratorMcpFailure>;
    readonly update: (
      scope: McpInvocationContext.McpInvocationScope,
      input: InitiativeUpdateInput,
    ) => Effect.Effect<Initiative, OrchestratorMcpFailure>;
    readonly setStatus: (
      scope: McpInvocationContext.McpInvocationScope,
      input: InitiativeSetStatusInput,
    ) => Effect.Effect<Initiative, OrchestratorMcpFailure>;
  }
>()("t3/mcp/InitiativeMcpService") {}

const initiativeFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const make = Effect.gen(function* () {
  const initiatives = yield* Initiatives.InitiativeService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const caller = (scope: McpInvocationContext.McpInvocationScope, mutation = false) =>
    (mutation ? readMutationCaller() : readCaller()).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  const writableCoordinator = Effect.fn("InitiativeMcpService.writableCoordinator")(function* (
    context: Caller,
    coordinatorThreadId: ThreadId,
    allowMissing = false,
  ) {
    const coordinator = yield* threads
      .getThreadShell(coordinatorThreadId)
      .pipe(Effect.mapError(unavailable));
    if (coordinator === null || coordinator.deletedAt !== null) {
      // A deleted coordinator has no work to escalate. Keep its saved brief editable
      // so a user can attach a replacement without losing the initiative history.
      if (allowMissing) return;
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The coordinator thread was not found.",
      });
    }
    yield* assertTargetWithinLimits(context.limits, coordinator);
  });

  const list = Effect.fn("InitiativeMcpService.list")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: OrchestratorMcpInitiativeListInput,
  ) {
    const context = yield* caller(scope);
    return yield* initiatives
      .list({ projectId: input.projectId ?? context.caller?.projectId })
      .pipe(Effect.mapError(initiativeFailure));
  });

  const read = Effect.fn("InitiativeMcpService.read")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: OrchestratorMcpInitiativeReadInput,
  ) {
    const context = yield* caller(scope);
    if (input.id !== undefined) {
      return {
        initiative: yield* initiatives.get(input.id).pipe(Effect.mapError(initiativeFailure)),
      };
    }
    if (context.caller === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass id: this MCP client is not running inside a coordinator thread.",
      });
    }
    return {
      initiative: yield* initiatives
        .getByCoordinator(context.caller.id)
        .pipe(Effect.mapError(initiativeFailure)),
    };
  });

  const create = Effect.fn("InitiativeMcpService.create")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: OrchestratorMcpInitiativeCreateInput,
  ) {
    const context = yield* caller(scope, true);
    const projectId = yield* resolveProjectId(context, input.projectId);
    const coordinatorThreadId = input.coordinatorThreadId ?? context.caller?.id;
    if (coordinatorThreadId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass coordinatorThreadId: this MCP client is not running inside a T3 thread.",
      });
    }
    yield* writableCoordinator(context, coordinatorThreadId);
    return yield* initiatives
      .create({ ...input, projectId, coordinatorThreadId })
      .pipe(Effect.mapError(initiativeFailure));
  });

  const update = Effect.fn("InitiativeMcpService.update")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: InitiativeUpdateInput,
  ) {
    const context = yield* caller(scope, true);
    const initiative = yield* initiatives.get(input.id).pipe(Effect.mapError(initiativeFailure));
    yield* writableCoordinator(context, initiative.coordinatorThreadId, true);
    if (input.coordinatorThreadId !== undefined) {
      yield* writableCoordinator(context, input.coordinatorThreadId);
    }
    return yield* initiatives.update(input).pipe(Effect.mapError(initiativeFailure));
  });

  const setStatus = Effect.fn("InitiativeMcpService.setStatus")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: InitiativeSetStatusInput,
  ) {
    const context = yield* caller(scope, true);
    const initiative = yield* initiatives.get(input.id).pipe(Effect.mapError(initiativeFailure));
    yield* writableCoordinator(context, initiative.coordinatorThreadId, true);
    return yield* initiatives.setStatus(input).pipe(Effect.mapError(initiativeFailure));
  });

  return InitiativeMcpService.of({ list, read, create, update, setStatus });
});

export const layer = Layer.effect(InitiativeMcpService, make);
