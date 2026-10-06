import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import * as InitiativeService from "./InitiativeService.ts";

const timestamp = "2026-10-05T18:00:00.000Z";
const projectId = ProjectId.make("initiative-project");
const coordinator = ThreadId.make("initiative-coordinator");
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const layerTest = InitiativeService.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeCrypto.layer),
);
const seedProject = Effect.fn("InitiativeTest.seedProject")(function* (id = projectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${id},'Repository','/fixture/repository','[]',${timestamp},${timestamp})`;
});
const seedThread = Effect.fn("InitiativeTest.seedThread")(function* (
  id: ThreadId,
  parent: ThreadId | null = null,
  project = projectId,
  relationship: "subagent" | "fork" | null = parent === null ? null : "subagent",
  creationSource: "web" | "provider" = "web",
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = yield* encodeJson({
    creationSource,
    lineage: {
      parentThreadId: parent,
      relationshipToParent: relationship,
      rootThreadId: coordinator,
    },
  });
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
    VALUES (${id},${project},${id},'codex','full-access','default',${timestamp},${timestamp},${payload})`;
});
const seedTask = Effect.fn("InitiativeTest.seedTask")(function* (
  parent: ThreadId,
  child: ThreadId,
  origin: "app_owned" | "provider_native" = "app_owned",
  status = "completed",
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = yield* encodeJson({ title: `Task ${child}`, result: `Result ${child}` });
  yield* sql`INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,child_thread_id,origin,status,updated_at,payload_json)
    VALUES (${`${parent}:${child}`},${parent},'fixture-node','codex',${child},${origin},${status},${timestamp},${payload})`;
});
const createInput = {
  projectId,
  coordinatorThreadId: coordinator,
  title: "API migration",
  objective: "Migrate the API",
  definitionOfDone: "All clients use v2",
};

it.effect(
  "isolates initiatives, follows recursive app-owned lineage, and retains task results",
  () =>
    Effect.gen(function* () {
      const service = yield* InitiativeService.InitiativeService;
      yield* seedProject();
      const otherProject = ProjectId.make("other-project");
      yield* seedProject(otherProject);
      const otherCoordinator = ThreadId.make("other-coordinator");
      const first = ThreadId.make("first-worker");
      const nested = ThreadId.make("nested-worker");
      const second = ThreadId.make("second-worker");
      const native = ThreadId.make("native-worker");
      const fork = ThreadId.make("fork-thread");
      const crossProject = ThreadId.make("cross-project-worker");
      yield* seedThread(coordinator);
      yield* seedThread(otherCoordinator);
      yield* seedThread(first, coordinator);
      yield* seedThread(nested, first);
      yield* seedThread(second, otherCoordinator);
      yield* seedThread(native, coordinator);
      yield* seedThread(fork, coordinator, projectId, "fork");
      yield* seedThread(crossProject, coordinator, otherProject);
      yield* seedThread(ThreadId.make("unrelated"));
      yield* seedTask(coordinator, first, "app_owned", "running");
      yield* seedTask(first, nested);
      yield* seedTask(otherCoordinator, second);
      yield* seedTask(coordinator, native, "provider_native");
      yield* seedTask(coordinator, fork);
      yield* seedTask(coordinator, crossProject);
      const a = yield* service.create(createInput);
      const b = yield* service.create({
        ...createInput,
        coordinatorThreadId: otherCoordinator,
        title: "Second",
        objective: "Independent outcome",
      });
      assert.deepEqual(a.workers.map((worker) => worker.threadId).sort(), [first, nested].sort());
      assert.deepEqual(
        b.workers.map((worker) => worker.threadId),
        [second],
      );
      assert.equal(a.workers.find((worker) => worker.threadId === first)?.status, "running");
      assert.equal(
        a.workers.find((worker) => worker.threadId === nested)?.result,
        `Result ${nested}`,
      );
      assert.equal(a.status, "active");
      assert.equal((yield* service.list({ projectId: otherProject })).initiatives.length, 0);
      assert.equal((yield* service.list({ projectId })).initiatives.length, 2);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("validates project ownership and unique coordinators", () =>
  Effect.gen(function* () {
    const service = yield* InitiativeService.InitiativeService;
    yield* seedProject();
    yield* seedThread(coordinator);
    const other = ProjectId.make("wrong-project");
    yield* seedProject(other);
    const wrongProject = yield* service
      .create({ ...createInput, projectId: other })
      .pipe(Effect.flip);
    assert.equal(wrongProject._tag, "InitiativeError");
    const attempts = yield* Effect.all(
      [
        service.create(createInput).pipe(
          Effect.map(() => "created"),
          Effect.catch(() => Effect.succeed("rejected")),
        ),
        service.create(createInput).pipe(
          Effect.map(() => "created"),
          Effect.catch(() => Effect.succeed("rejected")),
        ),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepEqual([...attempts].sort(), ["created", "rejected"]);
    assert.equal((yield* service.list({})).initiatives.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps metadata and membership through pause, completion, reopening and deleted-coordinator replacement",
  () =>
    Effect.gen(function* () {
      const service = yield* InitiativeService.InitiativeService;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject();
      yield* seedThread(coordinator);
      const worker = ThreadId.make("history-worker");
      yield* seedThread(worker, coordinator);
      yield* seedTask(coordinator, worker);
      const created = yield* service.create({
        ...createInput,
        brief: "Compatibility required",
        plan: "Upgrade clients",
        decisions: "Keep v1 available",
        results: "Research finished",
      });
      yield* service.setStatus({ id: created.id, status: "paused" });
      assert.isFalse(yield* service.isAutomaticWorkAllowed(coordinator));
      assert.isTrue(yield* service.isAutomaticWorkAllowed(worker));
      yield* service.setStatus({ id: created.id, status: "completed" });
      yield* service.setStatus({ id: created.id, status: "active" });
      const replacement = ThreadId.make("replacement-coordinator");
      yield* seedThread(replacement);
      assert.equal(
        (yield* service
          .update({ id: created.id, coordinatorThreadId: replacement })
          .pipe(Effect.flip))._tag,
        "InitiativeError",
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${timestamp} WHERE thread_id = ${coordinator}`;
      assert.isTrue((yield* service.get(created.id)).coordinatorMissing);
      const updated = yield* service.update({ id: created.id, coordinatorThreadId: replacement });
      assert.isFalse(updated.coordinatorMissing);
      assert.deepEqual(
        updated.workers.map((entry) => entry.threadId),
        [worker],
      );
      assert.equal(updated.brief, "Compatibility required");
      assert.equal(updated.decisions, "Keep v1 available");
      assert.equal(updated.results, "Research finished");
      assert.isTrue((yield* service.contextForThread(replacement))?.includes("Upgrade clients"));
      // A new service instance reads the committed state from the same database.
      const reloaded = yield* Effect.gen(function* () {
        const fresh = yield* InitiativeService.InitiativeService;
        return yield* fresh.get(created.id);
      }).pipe(Effect.provide(InitiativeService.layer.pipe(Layer.provide(NodeCrypto.layer))));
      assert.deepEqual(reloaded, updated);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "publishes a snapshot and committed metadata changes without missing subscription races",
  () =>
    Effect.gen(function* () {
      const service = yield* InitiativeService.InitiativeService;
      yield* seedProject();
      yield* seedThread(coordinator);
      const created = yield* service.create(createInput);
      const initial = yield* Deferred.make<void>();
      const snapshots = yield* service.subscribe({ projectId }).pipe(
        Stream.tap(() => Deferred.succeed(initial, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(initial);
      yield* service.update({ id: created.id, plan: "Changed constraint incorporated" });
      const seen = yield* Fiber.join(snapshots);
      assert.equal(seen.length, 2);
      assert.equal(seen[1]?.initiatives[0]?.plan, "Changed constraint incorporated");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("serializes pause with automatic acceptance without blocking another initiative", () =>
  Effect.gen(function* () {
    const service = yield* InitiativeService.InitiativeService;
    yield* seedProject();
    yield* seedThread(coordinator);
    const other = ThreadId.make("independent-coordinator");
    yield* seedThread(other);
    const created = yield* service.create(createInput);
    yield* service.create({ ...createInput, coordinatorThreadId: other });
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const launch = yield* service
      .withAutomaticWorkAllowed(
        coordinator,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const pause = yield* service
      .setStatus({ id: created.id, status: "paused" })
      .pipe(Effect.forkChild);
    assert.equal(
      yield* service.withAutomaticWorkAllowed(other, Effect.succeed("accepted")),
      "accepted",
    );
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(launch);
    yield* Fiber.join(pause);
    const blocked = yield* service
      .withAutomaticWorkAllowed(coordinator, Effect.die("must not launch"))
      .pipe(Effect.flip);
    assert.equal(blocked._tag, "InitiativeAutomaticWorkBlockedError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("persists initiative metadata across closing and reopening SQLite", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-initiative-test-" });
    const layer = InitiativeService.layer.pipe(
      Layer.provideMerge(Sqlite.layerFromPath(`${directory}/state.sqlite`)),
      Layer.provide(NodeServices.layer),
    );
    const id = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* seedProject();
        yield* seedThread(coordinator);
        const service = yield* InitiativeService.InitiativeService;
        const initiative = yield* service.create({
          ...createInput,
          plan: "Saved plan",
          decisions: "Saved decision",
        });
        yield* service.setStatus({ id: initiative.id, status: "completed" });
        return initiative.id;
      }).pipe(Effect.provide(layer)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* InitiativeService.InitiativeService;
        const initiative = yield* service.get(id);
        assert.equal(initiative.plan, "Saved plan");
        assert.equal(initiative.decisions, "Saved decision");
        assert.equal(initiative.status, "completed");
        const reopened = yield* service.setStatus({ id, status: "active" });
        assert.equal(reopened.plan, "Saved plan");
      }).pipe(Effect.provide(layer)),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rejects a provider-owned read-only subagent as coordinator", () =>
  Effect.gen(function* () {
    const service = yield* InitiativeService.InitiativeService;
    yield* seedProject();
    const native = ThreadId.make("native-read-only-coordinator");
    yield* seedThread(native, coordinator, projectId, "subagent", "provider");
    assert.equal(
      (yield* service.create({ ...createInput, coordinatorThreadId: native }).pipe(Effect.exit))
        ._tag,
      "Failure",
    );
    assert.deepEqual((yield* service.list({ projectId })).initiatives, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps an existing worker associated with its initiative when choosing another coordinator",
  () =>
    Effect.gen(function* () {
      const service = yield* InitiativeService.InitiativeService;
      yield* seedProject();
      yield* seedThread(coordinator);
      const worker = ThreadId.make("reserved-initiative-worker");
      yield* seedThread(worker, coordinator);
      yield* seedTask(coordinator, worker);
      const initiative = yield* service.create(createInput);
      const attempted = yield* service
        .create({ ...createInput, coordinatorThreadId: worker, objective: "Different work" })
        .pipe(Effect.exit);
      assert.equal(attempted._tag, "Failure");
      assert.deepEqual(
        (yield* service.get(initiative.id)).workers.map((member) => member.threadId),
        [worker],
      );
      assert.equal((yield* service.list({ projectId })).initiatives.length, 1);
    }).pipe(Effect.provide(layerTest)),
);
