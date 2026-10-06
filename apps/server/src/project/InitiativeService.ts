import {
  Initiative,
  InitiativeError,
  InitiativeWorker,
  ThreadId,
  type InitiativeCreateInput,
  type InitiativeListInput,
  type InitiativeListResult,
  type InitiativeSetStatusInput,
  type InitiativeStatus,
  type InitiativeUpdateInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";

export class InitiativeAutomaticWorkBlockedError extends Schema.TaggedError<InitiativeAutomaticWorkBlockedError>()(
  "InitiativeAutomaticWorkBlockedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Automatic initiative work is paused or completed.";
  }
}

export class InitiativeService extends Context.Service<
  InitiativeService,
  {
    readonly list: (
      input: InitiativeListInput,
    ) => Effect.Effect<InitiativeListResult, InitiativeError>;
    readonly subscribe: (
      input: InitiativeListInput,
    ) => Stream.Stream<InitiativeListResult, InitiativeError>;
    readonly lifecycleChanges: Stream.Stream<{
      readonly threadId: ThreadId;
      readonly status: InitiativeStatus;
    }>;
    readonly get: (id: string) => Effect.Effect<Initiative, InitiativeError>;
    readonly create: (input: InitiativeCreateInput) => Effect.Effect<Initiative, InitiativeError>;
    readonly update: (input: InitiativeUpdateInput) => Effect.Effect<Initiative, InitiativeError>;
    readonly setStatus: (
      input: InitiativeSetStatusInput,
    ) => Effect.Effect<Initiative, InitiativeError>;
    readonly getByCoordinator: (
      threadId: ThreadId,
    ) => Effect.Effect<Initiative | null, InitiativeError>;
    readonly isAutomaticWorkAllowed: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, InitiativeError>;
    readonly contextForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<string | null, InitiativeError>;
    /** Hold only across the final automatic launch, never across nested dispatch. */
    readonly withAutomaticWorkAllowed: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | InitiativeError | InitiativeAutomaticWorkBlockedError, R>;
  }
>()("t3/project/InitiativeService") {}

const { workers: _workers, coordinatorMissing: _missing, ...storedFields } = Initiative.fields;
const StoredInitiative = Schema.Struct(storedFields);
type StoredInitiative = typeof StoredInitiative.Type;
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredInitiative));
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredInitiative));
const decodeStoredValue = Schema.decodeUnknownEffect(StoredInitiative);
const isInitiativeError = Schema.is(InitiativeError);
const decodeWorkers = Schema.decodeUnknownEffect(Schema.Array(InitiativeWorker));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const eventSink = yield* Effect.serviceOption(EventSink.EventSinkV2);
  const lock = yield* KeyedLock.make<string>();
  const changes = yield* PubSub.sliding<void>(1);
  const lifecycle = yield* PubSub.unbounded<{
    readonly threadId: ThreadId;
    readonly status: InitiativeStatus;
  }>();
  const failure = (operation: string, cause: unknown) =>
    new InitiativeError({ operation, message: `Could not ${operation} initiative.`, cause });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readStored = Effect.fn("InitiativeService.readStored")(function* (id: string) {
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM initiatives WHERE initiative_id = ${id}`;
    if (!rows[0])
      return yield* new InitiativeError({
        operation: "read",
        message: "Initiative does not exist.",
      });
    return yield* decodeStored(rows[0].payload_json);
  });

  const workersFor = Effect.fn("InitiativeService.workersFor")(function* (
    initiative: StoredInitiative,
  ) {
    // Follow recorded app-owned delegation, not every thread in the repository.
    // UNION also bounds malformed cyclic lineage. Native-provider tasks have no
    // independent app thread and cannot become members through this path.
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly parent_thread_id: string;
      readonly title: string;
      readonly status: string;
      readonly result: string | null;
    }>`
      WITH RECURSIVE members(thread_id) AS (
        SELECT thread_id FROM initiative_coordinators WHERE initiative_id = ${initiative.id}
        UNION
        SELECT s.child_thread_id
        FROM orchestration_v2_projection_subagents s
        JOIN members m ON m.thread_id = s.thread_id
        JOIN orchestration_v2_projection_threads p ON p.thread_id = s.thread_id
        JOIN orchestration_v2_projection_threads c ON c.thread_id = s.child_thread_id
        WHERE s.origin = 'app_owned' AND s.child_thread_id IS NOT NULL
          AND p.project_id = ${initiative.projectId} AND c.project_id = ${initiative.projectId}
          AND json_extract(c.payload_json, '$.lineage.parentThreadId') = s.thread_id
          AND json_extract(c.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND NOT EXISTS (SELECT 1 FROM initiatives i WHERE i.coordinator_thread_id = s.child_thread_id)
      )
      SELECT s.child_thread_id AS thread_id, s.thread_id AS parent_thread_id,
        COALESCE(json_extract(s.payload_json, '$.title'), c.title) AS title,
        s.status, json_extract(s.payload_json, '$.result') AS result
      FROM orchestration_v2_projection_subagents s
      JOIN members m ON m.thread_id = s.thread_id
      JOIN members child ON child.thread_id = s.child_thread_id
      JOIN orchestration_v2_projection_threads c ON c.thread_id = s.child_thread_id
      WHERE s.origin = 'app_owned' AND NOT EXISTS (SELECT 1 FROM initiative_coordinators roots WHERE roots.initiative_id = ${initiative.id} AND roots.thread_id = s.child_thread_id)
      ORDER BY s.updated_at, s.subagent_id
    `;
    // Reusing a child in successive delegated turns gives it one overview row,
    // with the newest recorded task's status and result.
    const latest = new Map(
      rows.map((row) => [
        row.thread_id,
        {
          threadId: row.thread_id,
          parentThreadId: row.parent_thread_id,
          title: row.title,
          status: row.status,
          result: row.result,
        },
      ]),
    );
    return yield* decodeWorkers([...latest.values()]);
  });

  const hydrate = Effect.fn("InitiativeService.hydrate")(function* (stored: StoredInitiative) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${stored.coordinatorThreadId} AND project_id = ${stored.projectId} AND deleted_at IS NULL
    `;
    return { ...stored, coordinatorMissing: rows.length === 0, workers: yield* workersFor(stored) };
  });
  const get: InitiativeService["Service"]["get"] = (id) =>
    readStored(id).pipe(
      Effect.flatMap(hydrate),
      Effect.mapError((cause) => (isInitiativeError(cause) ? cause : failure("read", cause))),
    );
  const list: InitiativeService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rows =
        input.projectId === undefined
          ? yield* sql<{
              readonly payload_json: string;
            }>`SELECT payload_json FROM initiatives ORDER BY created_at, initiative_id`
          : yield* sql<{
              readonly payload_json: string;
            }>`SELECT payload_json FROM initiatives WHERE project_id = ${input.projectId} ORDER BY created_at, initiative_id`;
      const initiatives = yield* Effect.forEach(rows, (row) =>
        decodeStored(row.payload_json).pipe(Effect.flatMap(hydrate)),
      );
      return { initiatives };
    }).pipe(Effect.mapError((cause) => failure("list", cause)));

  const validateCoordinator = Effect.fn("InitiativeService.validateCoordinator")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    ownId?: string,
  ) {
    const projects =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`;
    const threads = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND project_id = ${projectId} AND deleted_at IS NULL
          AND NOT (COALESCE(json_extract(payload_json, '$.creationSource'), '') = 'provider'
            AND COALESCE(json_extract(payload_json, '$.lineage.relationshipToParent'), '') = 'subagent')`;
    if (projects.length === 0 || threads.length === 0)
      return yield* new InitiativeError({
        operation: "attach",
        message: "Choose an existing writable coordinator in this project.",
      });
    const memberships = yield* list({ projectId });
    if (
      memberships.initiatives.some(
        (initiative) =>
          initiative.id !== ownId &&
          initiative.workers.some((worker) => worker.threadId === threadId),
      )
    )
      return yield* new InitiativeError({
        operation: "attach",
        message:
          "This thread is already a worker of another initiative. Choose an independent coordinator.",
      });
    const existing = yield* sql<{
      readonly initiative_id: string;
    }>`SELECT initiative_id FROM initiative_coordinators WHERE thread_id = ${threadId}`;
    if (existing.some((row) => row.initiative_id !== ownId))
      return yield* new InitiativeError({
        operation: "attach",
        message: "This thread already coordinates another initiative.",
      });
  });
  const write = (stored: StoredInitiative) =>
    Effect.gen(function* () {
      const payload = yield* encodeStored(stored);
      yield* sql`INSERT OR IGNORE INTO initiative_coordinators (initiative_id, thread_id) VALUES (${stored.id}, ${stored.coordinatorThreadId})`;
      yield* sql`
    INSERT INTO initiatives (initiative_id, project_id, coordinator_thread_id, status, created_at, updated_at, payload_json)
    VALUES (${stored.id}, ${stored.projectId}, ${stored.coordinatorThreadId}, ${stored.status}, ${stored.createdAt}, ${stored.updatedAt}, ${payload})
    ON CONFLICT(initiative_id) DO UPDATE SET coordinator_thread_id = excluded.coordinator_thread_id,
      status = excluded.status, updated_at = excluded.updated_at, payload_json = excluded.payload_json
  `;
    });
  const publishMetadata = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const publish = (stored: StoredInitiative) =>
    publishMetadata.pipe(
      Effect.andThen(
        PubSub.publish(lifecycle, { threadId: stored.coordinatorThreadId, status: stored.status }),
      ),
      Effect.asVoid,
    );

  const create: InitiativeService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      yield* validateCoordinator(input.projectId, input.coordinatorThreadId);
      const timestamp = yield* now;
      const stored = yield* decodeStoredValue({
        definitionOfDone: "",
        brief: "",
        plan: "",
        decisions: "",
        links: "",
        blockers: "",
        userActions: "",
        results: "",
        ...input,
        id: yield* crypto.randomUUIDv4,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      yield* write(stored);
      return stored;
    }).pipe(
      sql.withTransaction,
      Effect.tap(publish),
      Effect.flatMap(hydrate),
      Effect.mapError((cause) => (isInitiativeError(cause) ? cause : failure("create", cause))),
    );
  const update: InitiativeService["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const current = yield* readStored(input.id);
      if (
        input.coordinatorThreadId !== undefined &&
        input.coordinatorThreadId !== current.coordinatorThreadId
      ) {
        const previous =
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${current.coordinatorThreadId} AND deleted_at IS NULL`;
        if (previous.length > 0)
          return yield* new InitiativeError({
            operation: "attach",
            message: "Keep the existing coordinator while its thread is available.",
          });
        yield* validateCoordinator(current.projectId, input.coordinatorThreadId, current.id);
      }
      const stored = yield* decodeStoredValue({
        ...current,
        ...input,
        updatedAt: yield* now,
      });
      yield* write(stored);
      return stored;
    }).pipe(
      sql.withTransaction,
      Effect.tap(() => publishMetadata),
      Effect.flatMap(hydrate),
      (effect) => lock.withLock(input.id, effect),
      Effect.mapError((cause) => (isInitiativeError(cause) ? cause : failure("update", cause))),
    );
  const setStatus: InitiativeService["Service"]["setStatus"] = (input) =>
    Effect.gen(function* () {
      const current = yield* readStored(input.id);
      const stored = { ...current, status: input.status, updatedAt: yield* now };
      yield* write(stored);
      return stored;
    }).pipe(
      sql.withTransaction,
      Effect.tap(publish),
      Effect.flatMap(hydrate),
      (effect) => lock.withLock(input.id, effect),
      Effect.mapError((cause) =>
        isInitiativeError(cause) ? cause : failure("change status of", cause),
      ),
    );

  const getByCoordinator: InitiativeService["Service"]["getByCoordinator"] = (threadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM initiatives WHERE coordinator_thread_id = ${threadId}`;
      return rows[0]
        ? yield* decodeStored(rows[0].payload_json).pipe(Effect.flatMap(hydrate))
        : null;
    }).pipe(Effect.mapError((cause) => failure("read", cause)));
  const readByCoordinator = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM initiatives WHERE coordinator_thread_id = ${threadId}`;
      return rows[0] ? yield* decodeStored(rows[0].payload_json) : null;
    }).pipe(Effect.mapError((cause) => failure("read", cause)));
  const isAutomaticWorkAllowed: InitiativeService["Service"]["isAutomaticWorkAllowed"] = (
    threadId,
  ) =>
    readByCoordinator(threadId).pipe(
      Effect.map((initiative) => initiative === null || initiative.status === "active"),
    );
  const contextForThread: InitiativeService["Service"]["contextForThread"] = (threadId) =>
    readByCoordinator(threadId).pipe(
      Effect.map((initiative) =>
        initiative === null
          ? null
          : [
              `Initiative: ${initiative.title} (${initiative.id})`,
              `Status: ${initiative.status}`,
              `Objective: ${initiative.objective}`,
              `Definition of done: ${initiative.definitionOfDone}`,
              `Brief: ${initiative.brief}`,
              `Plan: ${initiative.plan}`,
              `Decisions: ${initiative.decisions}`,
              `Links: ${initiative.links}`,
              `Blockers: ${initiative.blockers}`,
              `User actions: ${initiative.userActions}`,
              `Results: ${initiative.results}`,
              "Use the initiative tools to keep the saved plan, decisions and results current. Completing a worker does not complete this initiative.",
            ].join("\n\n"),
      ),
    );
  const withAutomaticWorkAllowed: InitiativeService["Service"]["withAutomaticWorkAllowed"] = (
    threadId,
    effect,
  ) =>
    Effect.gen(function* () {
      const initiative = yield* readByCoordinator(threadId);
      if (initiative === null) return yield* effect;
      return yield* lock.withLock(
        initiative.id,
        Effect.gen(function* () {
          if (!(yield* isAutomaticWorkAllowed(threadId)))
            return yield* new InitiativeAutomaticWorkBlockedError({ threadId });
          return yield* effect;
        }),
      );
    });

  const subscribe: InitiativeService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const metadataChanges = Stream.fromSubscription(subscription);
        if (Option.isNone(eventSink))
          return Stream.concat(
            Stream.fromEffect(list(input)),
            metadataChanges.pipe(Stream.mapEffect(() => list(input))),
          );
        const sink = eventSink.value;
        const afterSequence = yield* sink
          .latestSequence()
          .pipe(Effect.mapError((cause) => failure("subscribe to", cause)));
        const workerChanges = sink.stream({ afterSequence, bounded: true }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" ||
              stored.event.type === "thread.deleted" ||
              stored.event.type === "thread.created" ||
              stored.event.type === "thread.metadata-updated",
          ),
          Stream.map(() => undefined),
          Stream.mapError((cause) => failure("subscribe to", cause)),
        );
        return Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.merge(metadataChanges, workerChanges).pipe(Stream.mapEffect(() => list(input))),
        );
      }),
    );
  return InitiativeService.of({
    list,
    subscribe,
    lifecycleChanges: Stream.fromPubSub(lifecycle),
    get,
    create,
    update,
    setStatus,
    getByCoordinator,
    isAutomaticWorkAllowed,
    contextForThread,
    withAutomaticWorkAllowed,
  });
});

export const layer = Layer.effect(InitiativeService, make);
