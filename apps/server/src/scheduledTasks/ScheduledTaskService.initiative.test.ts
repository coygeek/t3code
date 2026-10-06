import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as InitiativeService from "../project/InitiativeService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const coordinatorId = ThreadId.make("initiative-coordinator");

it.effect.each(["paused", "completed"] as const)(
  "keeps a %s initiative's due schedule while other schedules and manual runs work",
  (status) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-05T12:00:00.000Z"));
      const statusRef = yield* Ref.make<"active" | "paused" | "completed">(status);
      const dueWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const sent = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
      const register: Scheduler.Scheduler["Service"]["register"] = <E, R>(
        _name: string,
        work: Effect.Effect<void, E, R>,
      ) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          yield* Ref.set(dueWork, work.pipe(Effect.provideContext(context), Effect.orDie));
        });
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(Scheduler.Scheduler)({ register }),
        Layer.mock(InitiativeService.InitiativeService)({
          isAutomaticWorkAllowed: (threadId) =>
            Ref.get(statusRef).pipe(
              Effect.map((current) => threadId !== coordinatorId || current === "active"),
            ),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Effect.gen(function* () {
              const manual = input.commandId.endsWith(":manual");
              assert.equal(input.createdBy, manual ? "user" : "system");
              assert.equal(input.creationSource, manual ? "web" : "server");
              yield* Ref.update(sent, (ids) => [...ids, input.threadId]);
              return {} as ThreadManagementService.ThreadManagementSendResult;
            }),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const create = (threadId: string) =>
          decodeInput({
            id: `scheduled-task:${threadId}`,
            title: "Review",
            prompt: "Review the work.",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: "initiative-project",
            threadId,
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }).pipe(Effect.flatMap(service.upsert));
        const { task } = yield* create(coordinatorId);
        const unrelatedId = ThreadId.make("unrelated-coordinator");
        yield* create(unrelatedId);
        yield* TestClock.setTime(Date.parse(task.nextRunAt!));
        yield* yield* Ref.get(dueWork);

        const paused = (yield* service.list()).tasks.find((current) => current.id === task.id)!;
        assert.equal(paused.enabled, true);
        assert.equal(paused.nextRunAt, task.nextRunAt);
        assert.equal(paused.runCount, 0);
        assert.equal(paused.lastRunStatus, "never");
        assert.deepEqual(yield* Ref.get(sent), [unrelatedId]);

        yield* Ref.set(statusRef, "active");
        yield* yield* Ref.get(dueWork);
        const resumed = (yield* service.list()).tasks.find((current) => current.id === task.id)!;
        assert.equal(resumed.runCount, 1);
        assert.equal(resumed.lastRunStatus, "succeeded");
        assert.deepEqual(yield* Ref.get(sent), [unrelatedId, coordinatorId]);

        yield* Ref.set(statusRef, status);
        yield* service.runNow({ id: task.id });
        assert.deepEqual(yield* Ref.get(sent), [unrelatedId, coordinatorId, coordinatorId]);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["active", "paused", "completed"] as const)(
  "preserves agent run-now origin and the %s initiative's pause policy",
  (status) =>
    Effect.gen(function* () {
      const statusRef = yield* Ref.make<"active" | "paused" | "completed">(status);
      const sent = yield* Ref.make<
        ReadonlyArray<{
          readonly createdBy: OrchestrationV2Actor;
          readonly creationSource: OrchestrationV2CreationSource;
        }>
      >([]);
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
        Layer.mock(InitiativeService.InitiativeService)({
          isAutomaticWorkAllowed: () =>
            Ref.get(statusRef).pipe(Effect.map((current) => current === "active")),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Ref.update(sent, (messages) => [
              ...messages,
              { createdBy: input.createdBy, creationSource: input.creationSource },
            ]).pipe(Effect.as({} as ThreadManagementService.ThreadManagementSendResult)),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* decodeInput({
          id: `agent-run-now:${status}`,
          title: "Review",
          prompt: "Review work",
          enabled: false,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: "initiative-project",
          threadId: coordinatorId,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        }).pipe(Effect.flatMap(service.upsert));
        const origin = { createdBy: "agent" as const, creationSource: "mcp" as const };
        const agentRun = yield* service.runNow({ id: task.id }, origin).pipe(Effect.exit);
        const active = status === "active";
        assert.equal(agentRun._tag, active ? "Success" : "Failure");
        assert.deepEqual(yield* Ref.get(sent), active ? [origin] : []);
        const afterAgent = (yield* service.list()).tasks.find((current) => current.id === task.id)!;
        assert.equal(afterAgent.runCount, active ? 1 : 0);
        assert.equal(afterAgent.enabled, false);
        assert.equal(afterAgent.createdBy, "agent");
        assert.equal(afterAgent.lastRunStatus, active ? "succeeded" : "never");

        yield* TestClock.setTime(1_000);
        yield* service.runNow({ id: task.id });
        assert.equal((yield* Ref.get(sent)).at(-1)?.createdBy, "user");
        if (!active) {
          yield* Ref.set(statusRef, "active");
          yield* TestClock.setTime(2_000);
          yield* service.runNow({ id: task.id }, origin);
          assert.deepEqual((yield* Ref.get(sent)).at(-1), origin);
        }
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
