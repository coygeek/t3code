import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as InitiativeService from "../project/InitiativeService.ts";
import * as Fiber from "effect/Fiber";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-initiative-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerProviderInstanceRegistryTest = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerInitiativeService,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerProviderInstanceRegistryTest),
  Layer.provide(layerPlatformTest),
);

const seedCoordinator = (projectId: ProjectId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Coordinator",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("initiative orchestration", (it) => {
  it.effect("two coordinators retain their own durable delegated workers and results", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const initiatives = yield* InitiativeService.InitiativeService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projectId = ProjectId.make("project:initiative-workers");
      const coordinator = ThreadId.make("thread:initiative-coordinator");
      const otherCoordinator = ThreadId.make("thread:other-initiative-coordinator");
      yield* projects.create({
        commandId: CommandId.make("project:initiative-workers"),
        projectId,
        title: "Repository",
        workspaceRoot: "/workspace/initiative-workers",
      });
      yield* seedCoordinator(projectId, coordinator);
      yield* seedCoordinator(projectId, otherCoordinator);
      const initiative = yield* initiatives.create({
        projectId,
        coordinatorThreadId: coordinator,
        title: "API migration",
        objective: "Migrate the API",
        definitionOfDone: "Both endpoints use the new API",
        plan: "Inspect both endpoints",
      });
      const other = yield* initiatives.create({
        projectId,
        coordinatorThreadId: otherCoordinator,
        title: "Documentation",
        objective: "Write the guide",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start:initiative-workers"),
        threadId: coordinator,
        messageId: MessageId.make("message:initiative-workers"),
        text: "Inspect both endpoints independently",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parent = yield* orchestrator.getThreadProjection(coordinator);
      const parentRun = parent.runs[0]!;
      for (const endpoint of ["first", "second"]) {
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`delegate:initiative:${endpoint}`),
          parentThreadId: coordinator,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: `Inspect the ${endpoint} endpoint and report the change`,
          title: endpoint,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        });
      }
      const delegated = yield* orchestrator.getThreadProjection(coordinator);
      assert.equal(delegated.subagents.length, 2);
      const before = yield* initiatives.get(initiative.id);
      assert.equal(before.workers.length, 2);
      assert.deepEqual(
        new Set(before.workers.map((worker) => worker.threadId)),
        new Set(delegated.subagents.map((task) => task.childThreadId)),
      );
      assert.deepEqual((yield* initiatives.get(other.id)).workers, []);
      // Results are already a durable part of the delegation read model. Updating
      // one does not complete the body of work or associate a sibling coordinator.
      const task = delegated.subagents[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: CommandId.make("record:initiative-worker-result"),
        events: [
          {
            id: EventId.make("event:initiative-worker-result"),
            type: "subagent.updated",
            threadId: coordinator,
            runId: parentRun.id,
            nodeId: task.id,
            occurredAt: now,
            payload: {
              ...task,
              status: "completed",
              result: "https://github.com/example/repository/pull/42",
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      const withResult = yield* initiatives.get(initiative.id);
      assert.equal(withResult.status, "active");
      assert.equal(
        withResult.workers.find((worker) => worker.threadId === task.childThreadId)?.result,
        "https://github.com/example/repository/pull/42",
      );
      assert.deepEqual((yield* initiatives.get(other.id)).workers, []);
      yield* initiatives.update({
        id: initiative.id,
        plan: "Implement both endpoints",
        decisions: "Retain backwards compatibility",
      });
      yield* initiatives.setStatus({ id: initiative.id, status: "completed" });
      const reopened = yield* initiatives.setStatus({ id: initiative.id, status: "active" });
      assert.equal(reopened.plan, "Implement both endpoints");
      assert.equal(reopened.decisions, "Retain backwards compatibility");
      assert.equal(reopened.workers.length, 2);
    }),
  );

  it.effect(
    "automatic messages accepted while paused resume once with their recorded identity",
    () =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const initiatives = yield* InitiativeService.InitiativeService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make("project:initiative-queue");
        const threadId = ThreadId.make("thread:initiative-queue");
        yield* projects.create({
          commandId: CommandId.make("create:initiative-queue"),
          projectId,
          title: "Repository",
          workspaceRoot: "/workspace/initiative-queue",
        });
        yield* seedCoordinator(projectId, threadId);
        const initiative = yield* initiatives.create({
          projectId,
          coordinatorThreadId: threadId,
          title: "Watch the API",
          objective: "Keep the API current",
        });
        yield* initiatives.setStatus({ id: initiative.id, status: "paused" });
        const command = {
          type: "message.dispatch" as const,
          commandId: CommandId.make("dispatch:paused-initiative"),
          threadId,
          messageId: MessageId.make("message:paused-initiative"),
          text: "Recorded external result",
          attachments: [],
          dispatchMode: { type: "queue_after_active" as const },
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        const receipt = yield* orchestrator.dispatch(command);
        yield* orchestrator.dispatch(command);
        const queued = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(queued.runs.length, 1);
        assert.equal(queued.runs[0]!.status, "queued");
        assert.equal(
          queued.messages.filter((message) => message.id === command.messageId).length,
          1,
        );
        const runId = queued.runs[0]!.id;
        const afterSequence = yield* sink.latestSequence({ threadId });
        const started = yield* sink.stream({ threadId, afterSequence }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === runId &&
              stored.event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* initiatives.setStatus({ id: initiative.id, status: "active" });
        const promoted = yield* Fiber.join(started);
        assert.equal(promoted.length, 1);
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.runs.length, 1);
        assert.equal(resumed.runs[0]!.id, runId);
        assert.equal(resumed.runs[0]!.status, "starting");
        assert.equal(
          resumed.messages.filter((message) => message.id === command.messageId).length,
          1,
        );
        assert.equal(
          receipt.storedEvents.some((stored) => stored.event.type === "run.created"),
          true,
        );
      }),
  );

  it.effect("explicit user direction bypasses paused automatic messages in the queue", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const initiatives = yield* InitiativeService.InitiativeService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projectId = ProjectId.make("project:initiative-manual");
      const threadId = ThreadId.make("thread:initiative-manual");
      yield* projects.create({
        commandId: CommandId.make("create:initiative-manual"),
        projectId,
        title: "Repository",
        workspaceRoot: "/workspace/initiative-manual",
      });
      yield* seedCoordinator(projectId, threadId);
      const initiative = yield* initiatives.create({
        projectId,
        coordinatorThreadId: threadId,
        title: "API",
        objective: "Update the API",
      });
      yield* initiatives.setStatus({ id: initiative.id, status: "paused" });
      for (const message of ["automatic", "first-user", "second-user"]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`dispatch:initiative-manual:${message}`),
          threadId,
          messageId: MessageId.make(`message:initiative-manual:${message}`),
          text: message,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: message === "automatic" ? "agent" : "user",
          creationSource: message === "automatic" ? "server" : "web",
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const automatic = before.runs.find(
        (run) => run.userMessageId === "message:initiative-manual:automatic",
      )!;
      const first = before.runs.find(
        (run) => run.userMessageId === "message:initiative-manual:first-user",
      )!;
      const second = before.runs.find(
        (run) => run.userMessageId === "message:initiative-manual:second-user",
      )!;
      assert.equal(automatic.status, "queued");
      assert.equal(first.status, "starting");
      assert.equal(second.status, "queued");
      const afterSequence = yield* sink.latestSequence({ threadId });
      const promoted = yield* sink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === second.id &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: CommandId.make("complete:initiative-manual:first"),
        events: [
          {
            id: EventId.make("event:initiative-manual:first-complete"),
            type: "run.updated",
            threadId,
            runId: first.id,
            occurredAt: now,
            payload: { ...first, status: "completed", completedAt: now },
          },
        ],
      });
      yield* Fiber.join(promoted);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === automatic.id)?.status, "queued");
      assert.equal(after.runs.find((run) => run.id === second.id)?.status, "starting");
      assert.equal((yield* initiatives.get(initiative.id)).status, "paused");
    }),
  );

  it.effect("a paused usage-limit retry resumes the same recorded run after its reset", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const initiatives = yield* InitiativeService.InitiativeService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projectId = ProjectId.make("project:initiative-limit");
      const threadId = ThreadId.make("thread:initiative-limit");
      yield* projects.create({
        commandId: CommandId.make("create:initiative-limit"),
        projectId,
        title: "Repository",
        workspaceRoot: "/workspace/initiative-limit",
      });
      yield* seedCoordinator(projectId, threadId);
      const initiative = yield* initiatives.create({
        projectId,
        coordinatorThreadId: threadId,
        title: "API",
        objective: "Update the API",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start:initiative-limit"),
        threadId,
        messageId: MessageId.make("message:initiative-limit"),
        text: "Start work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const completedAt = DateTime.add(now, { minutes: -2 });
      const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: -1 }));
      yield* sink.write({
        commandId: CommandId.make("record:initiative-limit"),
        events: [
          {
            id: EventId.make("event:initiative-limit-error"),
            type: "turn-item.updated",
            threadId,
            runId: source.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("item:initiative-limit-error"),
              type: "error",
              threadId,
              runId: source.id,
              nodeId: source.rootNodeId,
              providerThreadId: source.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: completedAt,
              completedAt,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached",
                code: null,
                retryable: null,
                resetAt,
              },
            },
          },
          {
            id: EventId.make("event:initiative-limit-failed"),
            type: "run.updated",
            threadId,
            runId: source.id,
            occurredAt: now,
            payload: {
              ...source,
              status: "failed",
              requestedAt: DateTime.add(now, { minutes: -3 }),
              startedAt: DateTime.add(now, { minutes: -3 }),
              completedAt,
            },
          },
        ],
      });
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      const arm = limitRecoveryCommand(shell, true, DateTime.toEpochMillis(now));
      assert.isNotNull(arm);
      if (arm === null) return assert.fail("Expected recovery arming");
      yield* orchestrator.dispatch(arm);
      const armed = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      const retry = limitRecoveryCommand(armed, true, DateTime.toEpochMillis(now));
      assert.isNotNull(retry);
      if (retry?.type !== "message.dispatch") return assert.fail("Expected recovery dispatch");
      yield* initiatives.setStatus({ id: initiative.id, status: "paused" });
      yield* orchestrator.dispatch(retry);
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === retry.messageId,
      )!;
      assert.equal(queued.status, "queued");
      assert.equal(queued.usageLimitContinuationOfRunId, source.id);
      const afterSequence = yield* sink.latestSequence({ threadId });
      const promoted = yield* sink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === queued.id &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* initiatives.setStatus({ id: initiative.id, status: "active" });
      yield* Fiber.join(promoted);
      const resumed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(resumed.runs.length, 2);
      assert.equal(resumed.runs.find((run) => run.id === queued.id)?.status, "starting");
      assert.equal(
        resumed.runs.find((run) => run.id === queued.id)?.usageLimitContinuationOfRunId,
        source.id,
      );
    }),
  );
});
