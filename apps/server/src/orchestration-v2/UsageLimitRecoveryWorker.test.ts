import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as InitiativeService from "../project/InitiativeService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

import * as ProjectionStore from "./ProjectionStore.ts";
import { isAutomaticInitiativeMessage } from "./InitiativeWork.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const resetAt = "2026-10-05T12:00:00.000Z";
const runId = RunId.make("limited-run");
const thread: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  id: ThreadId.make("initiative-coordinator"),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: runId,
  usageLimitResetAt: resetAt,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  latestRunCompletedAt: DateTime.makeUnsafe("2026-10-05T11:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T11:00:00.000Z"),
  limitRecovery: {
    runId,
    resetAt,
    autoResume: true,
    snooze: false,
    requestId: CommandId.make("recovery-request"),
  },
  snoozedUntil: null,
};
it("classifies automatic usage-limit recovery as automatic work while preserving its request identity", () => {
  const command = UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, Date.parse(resetAt));
  assert.isNotNull(command);
  if (command?.type !== "message.dispatch") return assert.fail("Expected a recovery dispatch.");
  assert.equal(command.createdBy, "system");
  assert.equal(command.creationSource, "server");
  assert.isTrue(isAutomaticInitiativeMessage(command));
  assert.equal(command.usageLimitContinuationOfRunId, runId);
  assert.equal(command.usageLimitRecoveryRequestId, "recovery-request");
  assert.equal(
    command.commandId,
    `limit-resume:${thread.id}:${runId}:${Date.parse(resetAt)}:recovery-request`,
  );
  assert.deepEqual(thread.limitRecovery, {
    runId,
    resetAt,
    autoResume: true,
    snooze: false,
    requestId: CommandId.make("recovery-request"),
  });
});

it.effect(
  "preserves inactive initiative usage-limit recovery and dispatches the same recovery on resume",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(resetAt));
        const allowed = yield* Ref.make(false);
        const dueWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
        const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
        const register: Scheduler.Scheduler["Service"]["register"] = <E, R>(
          _name: string,
          work: Effect.Effect<void, E, R>,
        ) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<R>();
            yield* Ref.set(dueWork, work.pipe(Effect.provideContext(context), Effect.orDie));
          });
        const layerDependencies = Layer.mergeAll(
          ServerSettings.layerTest({ autoResumeLimitedThreads: true }),
          Layer.mock(Scheduler.Scheduler)({ register }),
          Layer.mock(InitiativeService.InitiativeService)({
            isAutomaticWorkAllowed: () => Ref.get(allowed),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () => Effect.succeed([thread]),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Ref.update(commands, (current) => [...current, command]).pipe(
                Effect.as({} as Orchestrator.OrchestratorV2DispatchResult),
              ),
          }),
        );
        yield* Layer.build(UsageLimitRecoveryWorker.layer.pipe(Layer.provide(layerDependencies)));
        yield* yield* Ref.get(dueWork);
        assert.deepEqual(yield* Ref.get(commands), []);
        assert.isTrue(thread.limitRecovery!.autoResume);
        yield* Ref.set(allowed, true);
        yield* yield* Ref.get(dueWork);
        const expected = UsageLimitRecoveryWorker.limitRecoveryCommand(
          thread,
          true,
          Date.parse(resetAt),
        );
        if (expected === null) return assert.fail("Expected a recovery dispatch after resume.");
        assert.deepEqual(yield* Ref.get(commands), [expected]);
      }),
    ),
);
