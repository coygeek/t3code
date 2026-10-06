import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  ScheduledTaskId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as InitiativeService from "../project/InitiativeService.ts";
import * as ProviderAuthService from "../provider/Services/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { CodexProviderCapabilitiesV2, parseCodexGoalCommand } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterEventStreamError,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

it("does not commit running state when inherited background routing cannot be read", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath: "/tmp/missing-provider-turn-start-worktree",
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, { exists: () => Effect.succeed(false) } as never),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/provider-turn-start-project",
      refName: "feature/restore",
      path: "/tmp/missing-provider-turn-start-worktree",
    });
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly initiative?: {
    readonly context: string | null;
    readonly paused?: boolean;
    readonly pauseDuringThreadLoad?: boolean;
    readonly nativeResume?: boolean;
    readonly driver?: ProviderDriverKind;
    readonly automatic?: "schedule" | "notification" | "completion";
    readonly handoff?: boolean;
    readonly acceptTurn?: Effect.Effect<void>;
  };
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  /** Opens the session, then fails loading its provider thread. */
  readonly ensureThreadFailure?: unknown;
  /**
   * Resumes a thread that has a native ref: resume fails, the fresh-thread
   * fallback succeeds, then reading history for its handoff fails.
   */
  readonly historyReadFailureAfterFallback?: unknown;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  /** Loads the thread and starts the run, then fails every later state read. */
  readonly failReadsAfterRunning?: boolean;
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: input.initiative?.driver ?? ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: input.initiative?.automatic === undefined ? "user" : "agent",
    creationSource: input.initiative?.automatic === undefined ? "web" : "server",
    ...(input.initiative?.automatic === "schedule"
      ? { scheduledTaskId: ScheduledTaskId.make("initiative-schedule") }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      branch: null,
      worktreePath: null,
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  if ("historyReadFailureAfterFallback" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  if (input.initiative?.nativeResume === true) {
    projection = {
      ...projection,
      providerThreads: [
        {
          ...providerThread,
          nativeThreadRef: {
            driver: providerThread.driver,
            nativeId: "native-initiative",
            strength: "strong",
          },
        },
      ],
    };
  }
  if (input.initiative?.handoff === true) {
    projection = {
      ...projection,
      contextHandoffs: [
        {
          id: ContextHandoffId.make("initiative-handoff"),
          threadId,
          targetRunId: runId,
          fromProviderThreadIds: [oldProviderThreadId],
          toProviderThreadId: providerThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: "Prior provider research: preserve portable state.",
          createdByProviderInstanceId: oldInstanceId,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
  }
  let automaticAllowed = input.initiative?.paused !== true;
  const initiativeLock = Semaphore.makeUnsafe(1);
  const providerStart = vi.fn<
    (input: Parameters<ProviderAdapterV2SessionRuntime["startTurn"]>[0]) => Effect.Effect<void>
  >(() => input.initiative?.acceptTurn ?? Effect.void);
  const providerCompact = vi.fn<
    (input: Parameters<ProviderAdapterV2SessionRuntime["startTurn"]>[0]) => Effect.Effect<void>
  >(() => input.initiative?.acceptTurn ?? Effect.void);
  const loadInitiativeThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.initiative?.pauseDuringThreadLoad === true) automaticAllowed = false;
      return projection.providerThreads.find((candidate) => candidate.id === providerThreadId)!;
    }),
  );
  const initiativeSession = {
    driver: providerThread.driver,
    providerSession: {
      id: providerSessionId,
      driver: providerThread.driver,
      providerInstanceId: newInstanceId,
      status: "ready" as const,
      cwd: "/tmp/native-account-command",
      model: null,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    ensureThread: loadInitiativeThread,
    resumeThread: loadInitiativeThread,
    startTurn: providerStart,
    compactThread: providerCompact,
  };
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const resumeFallbackSession = {
    driver: providerThread.driver,
    resumeThread: () =>
      Effect.fail(
        new ProviderAdapterEventStreamError({
          driver: providerThread.driver,
          providerSessionId,
          cause: "native thread is gone",
        }),
      ),
    ensureThread: () => Effect.succeed(providerThread),
  };
  const open = vi.fn(() =>
    input.initiative !== undefined
      ? Effect.succeed(initiativeSession as never)
      : input.interruptOpen === true
        ? Effect.interrupt
        : "historyReadFailureAfterFallback" in input
          ? Effect.succeed(resumeFallbackSession as never)
          : "ensureThreadFailure" in input
            ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
            : "openFailure" in input
              ? Effect.sync(() => {
                  if (input.interruptRunBeforeOpenFailure === true) interruptRun();
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderSessionManager.ProviderSessionOpenError({
                        instanceId: newInstanceId,
                        providerSessionId,
                        cause: input.openFailure,
                      }),
                    ),
                  ),
                )
              : input.failReadsAfterRunning === true
                ? Effect.succeed({
                    driver: providerThread.driver,
                    providerSession: {
                      id: providerSessionId,
                      driver: providerThread.driver,
                      providerInstanceId: newInstanceId,
                      status: "ready",
                      cwd: "/tmp/native-account-command",
                      model: null,
                      capabilities: CodexProviderCapabilitiesV2,
                      createdAt: now,
                      updatedAt: now,
                      lastError: null,
                    },
                    ensureThread: () => Effect.succeed(providerThread),
                  } as never)
                : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (
      input: RunExecutionService.RunExecutionServiceV2StartRootRunInput,
    ) => Effect.Effect<void, RunExecutionService.RunExecutionStartError>
  >((startInput) =>
    (input.initiative !== undefined
      ? startInput.message.text.trim().toLowerCase() === "/compact"
        ? startInput.session.compactThread!(startInput as never)
        : startInput.session.startTurn(startInput as never)
      : input.failReadsAfterRunning === true
        ? Effect.void
        : Effect.die("A local command must not start a native turn.")
    ).pipe(
      Effect.mapError(
        (cause) =>
          new RunExecutionService.RunExecutionStartError({
            commandId: startInput.commandId,
            runId: startInput.run.id,
            cause,
          }),
      ),
    ),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn(({ events: incoming, activeAttemptId, expectedStatus }) =>
    "writeFailure" in input
      ? Effect.fail(
          new EventSink.EventSinkWriteError({
            eventCount: incoming.length,
            cause: input.writeFailure,
          }),
        )
      : Effect.sync(() => {
          const current = projection.runs.find((candidate) => candidate.id === runId);
          const committed =
            current !== undefined &&
            current.activeAttemptId === activeAttemptId &&
            current.status === expectedStatus;
          if (committed) {
            for (const event of incoming) {
              expect(isDomainEvent(event)).toBe(true);
              events.push(event);
              projection = ProjectionStore.applyToProjection(projection, event);
            }
          }
          return { committed, storedEvents: [] };
        }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: () => Effect.die("history read must fail first"),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                expect(isDomainEvent(event)).toBe(true);
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              return { storedEvents: [] } as never;
            }),
        }),
        ...(input.initiative === undefined
          ? []
          : [
              Layer.mock(InitiativeService.InitiativeService)({
                contextForThread: () => Effect.succeed(input.initiative!.context),
                withAutomaticWorkAllowed: (guardThreadId, effect) =>
                  initiativeLock.withPermits(1)(
                    Effect.gen(function* () {
                      if (!automaticAllowed)
                        return yield* new InitiativeService.InitiativeAutomaticWorkBlockedError({
                          threadId: guardThreadId,
                        });
                      return yield* effect;
                    }),
                  ),
              }),
            ]),
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () =>
            Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getRuntimeRecoveryProjection: () =>
            Effect.as(failReadIfRunning, {
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getTurnStartHistory: () =>
            input.initiative === undefined
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: input.historyReadFailureAfterFallback,
                  }),
                )
              : Effect.succeed([]),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );
  return {
    open,
    providerStart,
    providerCompact,
    loadInitiativeThread,
    pauseInitiative: initiativeLock.withPermits(1)(
      Effect.sync(() => {
        automaticAllowed = false;
      }),
    ),
    resumeInitiative: Effect.sync(() => {
      automaticAllowed = true;
    }),
    prepareQueuedRun: Effect.sync(() => {
      projection = {
        ...projection,
        runs: projection.runs.map((candidate) =>
          candidate.id === runId ? { ...candidate, status: "starting" } : candidate,
        ),
      };
    }),
    writeIfRunCurrent,
    startRootRun,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a session-open failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("fails a starting run when its last start attempt cannot load the thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("Pi RPC read failed: pi process exited with code 1."),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: {
          class: "provider_error",
          message: "Pi RPC read failed: pi process exited with code 1.",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a thread-load failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a thread-load failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "keeps a store failure after the provider loaded the thread typed and retryable",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });

      const error = yield* harness.start.pipe(Effect.flip);

      // The provider succeeded; the failing stage is the projection read, so
      // the run is not failed as a provider error on the last attempt.
      expect(error._tag).toBe("ProviderTurnStartError");
      expect((error.cause as { _tag?: string } | undefined)?._tag).toBe("ProjectionStoreReadError");
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");
      expect(harness.events).toEqual([]);
    }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    // "false" would skip the provider turn or the terminal write and leave the
    // run active. A read failure must reach the caller instead.
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect("does not overwrite a run interrupted while its thread loads", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.projection().turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect("persists a failed sign-out without starting a provider turn", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/logout",
      logoutFailure: "Could not stop all sessions for this provider. Try again.",
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider sign-out failed",
        failure: {
          class: "permission_error",
          message: "Could not stop all sessions for this provider. Try again.",
        },
      },
    ]);
  }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

const savedInitiativeBrief = [
  "Initiative: API migration",
  "Objective: migrate all callers",
  "Definition of done: legacy routes removed",
  "Work brief: preserve compatibility",
  "Plan: update clients before deleting routes",
  "Decisions: retain the old schema during rollout",
].join("\n");

for (const driver of ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"]) {
  effectIt.effect(`injects the saved initiative brief into ${driver} provider input`, () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue the migration",
        initiative: { context: savedInitiativeBrief, driver: ProviderDriverKind.make(driver) },
      });
      yield* harness.start;
      const providerInput = harness.providerStart.mock.calls[0]?.[0];
      expect(providerInput?.message.text).toContain(savedInitiativeBrief);
      expect(providerInput?.message.text).toContain("User message:\nContinue the migration");
      expect(harness.projection().messages.at(-1)?.text).toBe("Continue the migration");
      expect(harness.providerStart).toHaveBeenCalledTimes(1);
    }),
  );
}

for (const nativeResume of [false, true]) {
  effectIt.effect(
    `includes initiative context with a portable handoff on native resume ${nativeResume}`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({
          text: "Use the earlier research",
          initiative: { context: savedInitiativeBrief, nativeResume, handoff: true },
        });
        yield* harness.start;
        const text = harness.providerStart.mock.calls[0]?.[0].message.text;
        expect(text).toContain(savedInitiativeBrief);
        expect(text).toContain("Prior provider research: preserve portable state.");
        expect(text).toContain("User message:\nUse the earlier research");
        expect(harness.loadInitiativeThread).toHaveBeenCalledTimes(1);
      }),
  );
}

effectIt.effect("leaves unrelated provider input unchanged", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Ordinary conversation",
      initiative: { context: null },
    });
    yield* harness.start;
    expect(harness.providerStart.mock.calls[0]?.[0].message.text).toBe("Ordinary conversation");
  }),
);

for (const { text, driver } of [
  { text: "/goal pause", driver: "codex" },
  { text: "/review --scope changed", driver: "opencode" },
]) {
  effectIt.effect(
    `preserves native provider control input ${text} with a saved initiative brief`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({
          text,
          initiative: { context: savedInitiativeBrief, driver: ProviderDriverKind.make(driver) },
        });
        harness.tryHandlePromptCommand.mockImplementation(() => Effect.succeed(false));
        yield* harness.start;
        const providerText = harness.providerStart.mock.calls[0]?.[0].message.text;
        expect(providerText).toBe(text);
        if (driver === "codex")
          expect(parseCodexGoalCommand(providerText!)).toEqual({ type: "pause" });
        expect(harness.providerStart).toHaveBeenCalledTimes(1);
        expect(harness.projection().messages.at(-1)?.text).toBe(text);
      }),
  );
}

effectIt.effect("handles account commands before injecting initiative context", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/logout",
      initiative: { context: savedInitiativeBrief, paused: true },
    });
    yield* harness.start;
    expect(harness.tryHandlePromptCommand.mock.calls[0]).toBeDefined();
    expect(harness.providerStart).not.toHaveBeenCalled();
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("completed");
  }),
);

for (const automatic of ["schedule", "notification", "completion"] as const) {
  effectIt.effect(`preserves a paused ${automatic} run for one start after resume`, () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Automatic initiative work",
        initiative: { context: savedInitiativeBrief, paused: true, automatic },
      });
      const originalRun = harness.projection().runs.at(-1)!;
      const originalMessage = harness.projection().messages.at(-1)!;
      yield* harness.start;
      const queued = harness.projection();
      expect(queued.runs.at(-1)).toEqual({
        ...originalRun,
        status: "queued",
        queuePosition: originalRun.ordinal,
      });
      expect(queued.messages.at(-1)).toEqual(originalMessage);
      expect(queued.attempts[0]?.status).toBe("pending");
      expect(queued.nodes[0]?.status).toBe("pending");
      expect(queued.providerThreads.at(-1)?.status).toBe("not_loaded");
      expect(harness.providerStart).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      yield* harness.start;
      expect(harness.events).toHaveLength(4);
      yield* harness.resumeInitiative;
      yield* harness.prepareQueuedRun;
      yield* harness.start;
      expect(harness.providerStart).toHaveBeenCalledTimes(1);
      expect(harness.projection().runs.at(-1)?.id).toBe(originalRun.id);
      expect(harness.projection().runs.at(-1)?.status).toBe("running");
      expect(harness.projection().messages.at(-1)?.id).toBe(originalMessage.id);
    }),
  );
}

effectIt.effect("checks pause after provider setup and before writing running state", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Automatic initiative work",
      initiative: {
        context: savedInitiativeBrief,
        pauseDuringThreadLoad: true,
        automatic: "completion",
        nativeResume: true,
      },
    });
    yield* harness.start;
    expect(harness.loadInitiativeThread).toHaveBeenCalledTimes(1);
    expect(harness.providerStart).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("queued");
    expect(harness.projection().providerThreads.at(-1)?.status).toBe("idle");
    expect(
      harness.events.some(
        (event) => event.type === "run.updated" && event.payload.status === "running",
      ),
    ).toBe(false);
  }),
);

effectIt.effect("allows explicit user direction while the initiative is paused", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Change the plan",
      initiative: { context: savedInitiativeBrief, paused: true },
    });
    yield* harness.start;
    expect(harness.providerStart).toHaveBeenCalledTimes(1);
    expect(harness.providerStart.mock.calls[0]?.[0].message.text).toContain(savedInitiativeBrief);
  }),
);

effectIt.effect("holds the automatic-work guard until provider acceptance", () =>
  Effect.gen(function* () {
    const accepting = yield* Deferred.make<void>();
    const accepted = yield* Deferred.make<void>();
    const paused = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Automatic initiative work",
      initiative: {
        context: savedInitiativeBrief,
        automatic: "schedule",
        acceptTurn: Deferred.succeed(accepting, undefined).pipe(
          Effect.andThen(Deferred.await(accepted)),
        ),
      },
    });
    const starting = yield* harness.start.pipe(Effect.forkChild);
    yield* Deferred.await(accepting);
    const pausing = yield* harness.pauseInitiative.pipe(
      Effect.andThen(Deferred.succeed(paused, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    expect(yield* Deferred.isDone(paused)).toBe(false);
    yield* Deferred.succeed(accepted, undefined);
    yield* Fiber.join(starting);
    yield* Fiber.join(pausing);
    expect(yield* Deferred.isDone(paused)).toBe(true);
    expect(harness.providerStart).toHaveBeenCalledTimes(1);
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
  }),
);

effectIt.effect("keeps initiative compaction on the provider compaction path", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/compact",
      previousMessages: ["Earlier conversation"],
      initiative: { context: savedInitiativeBrief, nativeResume: true },
    });
    // Compaction is provider work, so the local auth handler declines it.
    harness.tryHandlePromptCommand.mockImplementation(() => Effect.succeed(false));
    yield* harness.start;
    expect(harness.startRootRun.mock.calls[0]?.[0].message.text).toBe("/compact");
    expect(harness.providerCompact).toHaveBeenCalledTimes(1);
    expect(harness.providerCompact.mock.calls[0]?.[0].message.text).toBe("/compact");
    expect(harness.providerStart).not.toHaveBeenCalled();
  }),
);
