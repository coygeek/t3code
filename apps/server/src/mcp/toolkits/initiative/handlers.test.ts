import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  InitiativeError,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type Initiative,
  type InitiativeCreateInput,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Initiatives from "../../../project/InitiativeService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { InitiativeToolkit } from "./tools.ts";

const projectId = ProjectId.make("project-a");
const threadId = ThreadId.make("coordinator-a");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("test-environment"),
  requestNamespace: "test-session",
  thread: { threadId, providerSessionId: "session", providerInstanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "initiative-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "initiative-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

function initiative(input: Partial<Initiative> = {}): Initiative {
  return {
    id: "initiative-a",
    projectId,
    coordinatorThreadId: threadId,
    title: "Migration",
    objective: "Migrate the API",
    definitionOfDone: "All callers migrated",
    brief: "Preserve the public API",
    plan: "Audit, then migrate callers",
    decisions: "Keep compatibility",
    links: "https://example.com/research",
    blockers: "",
    userActions: "",
    results: "",
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    coordinatorMissing: false,
    workers: [],
    ...input,
  };
}

function shell(
  id: ThreadId,
  runtimeMode: OrchestrationV2ThreadShell["runtimeMode"] = "auto",
  active = true,
): OrchestrationV2ThreadShell {
  return {
    id,
    projectId,
    providerInstanceId,
    runtimeMode,
    interactionMode: "default",
    activeRunId: active ? RunId.make("active-run") : null,
    archivedAt: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
}

function fixture(
  options: {
    readonly active?: boolean;
    readonly runtimeMode?: OrchestrationV2ThreadShell["runtimeMode"];
  } = {},
) {
  const records = new Map<string, Initiative>([
    ["initiative-a", initiative()],
    [
      "initiative-b",
      initiative({
        id: "initiative-b",
        coordinatorThreadId: ThreadId.make("coordinator-b"),
        objective: "Different objective",
        brief: "Different brief",
      }),
    ],
  ]);
  const mutations: string[] = [];
  const lookup = (id: string) => {
    const record = records.get(id);
    return record === undefined
      ? Effect.fail(
          new InitiativeError({ operation: "get", message: "The initiative was not found." }),
        )
      : Effect.succeed(record);
  };
  const layerServices = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === threadId
            ? shell(id, options.runtimeMode ?? "auto", options.active ?? true)
            : shell(id, "full-access"),
        ),
    }),
    Layer.mock(Initiatives.InitiativeService)({
      list: (input) =>
        Effect.succeed({
          initiatives: [...records.values()].filter(
            (record) => input.projectId === undefined || record.projectId === input.projectId,
          ),
        }),
      get: lookup,
      getByCoordinator: (id) =>
        Effect.succeed(
          [...records.values()].find((record) => record.coordinatorThreadId === id) ?? null,
        ),
      create: (input: InitiativeCreateInput) =>
        Effect.sync(() => {
          mutations.push("create");
          const record = initiative({
            id: "initiative-created",
            projectId: input.projectId,
            coordinatorThreadId: input.coordinatorThreadId,
            title: input.title,
            objective: input.objective,
            definitionOfDone: input.definitionOfDone ?? "",
            brief: input.brief ?? "",
            plan: input.plan ?? "",
            decisions: input.decisions ?? "",
            links: input.links ?? "",
            blockers: input.blockers ?? "",
            userActions: input.userActions ?? "",
            results: input.results ?? "",
          });
          records.set(record.id, record);
          return record;
        }),
      update: (input) =>
        Effect.gen(function* () {
          const record = { ...(yield* lookup(input.id)) };
          for (const key of [
            "title",
            "objective",
            "definitionOfDone",
            "brief",
            "plan",
            "decisions",
            "links",
            "blockers",
            "userActions",
            "results",
          ] as const) {
            const value = input[key];
            if (value !== undefined) record[key] = value;
          }
          if (input.coordinatorThreadId !== undefined) {
            record.coordinatorThreadId = input.coordinatorThreadId;
          }
          mutations.push("update");
          records.set(record.id, record);
          return record;
        }),
      setStatus: (input) =>
        Effect.gen(function* () {
          const record = { ...(yield* lookup(input.id)), status: input.status };
          mutations.push(input.status);
          records.set(record.id, record);
          return record;
        }),
    }),
  );
  return {
    records,
    mutations,
    layer: McpHttpServer.layerInitiativeToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(layerServices),
    ),
  };
}

const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const content = result.content[0];
  return result.isError === true && content?.type === "text" ? JSON.parse(content.text) : undefined;
};

it("publishes reference-free object inputs with optional current-coordinator discovery", () => {
  for (const tool of Object.values(InitiativeToolkit.tools)) {
    expect(Tool.getJsonSchema(tool)).toMatchObject({ type: "object" });
    expect(JSON.stringify(Tool.getJsonSchema(tool))).not.toContain('"$ref"');
  }
  expect(Tool.getJsonSchema(InitiativeToolkit.tools.t3_initiative_read)).toMatchObject({
    properties: { id: { anyOf: expect.arrayContaining([{ type: "string" }, { type: "null" }]) } },
  });
  expect(InitiativeToolkit.tools.t3_initiative_read.description).toContain(
    "self-contained worker assignments",
  );
});

it.effect(
  "discovers only the current coordinator's saved brief, even with two initiatives in one project",
  () => {
    const state = fixture();
    return Effect.gen(function* () {
      const current = yield* call("t3_initiative_read", {});
      expect(current.structuredContent).toMatchObject({
        initiative: {
          id: "initiative-a",
          objective: "Migrate the API",
          brief: "Preserve the public API",
        },
      });
      const other = yield* call("t3_initiative_read", { id: "initiative-b" });
      expect(other.structuredContent).toMatchObject({
        initiative: {
          id: "initiative-b",
          objective: "Different objective",
          brief: "Different brief",
        },
      });
      const unrelated = yield* call(
        "t3_initiative_read",
        {},
        { ...scope, thread: { ...scope.thread!, threadId: ThreadId.make("unrelated-thread") } },
      );
      expect(unrelated.structuredContent).toEqual({ initiative: null });
    }).pipe(Effect.provide(state.layer));
  },
);

it.effect(
  "saves progress, pauses, completes, and reopens without dropping the brief or results",
  () => {
    const state = fixture();
    return Effect.gen(function* () {
      const update = yield* call("t3_initiative_update", {
        id: "initiative-a",
        plan: "Migrate the final caller",
        decisions: "Keep compatibility until rollout",
        results: "Two callers migrated",
        blockers: "Waiting on rollout",
        userActions: "Choose rollout time",
      });
      expect(update.structuredContent).toMatchObject({
        brief: "Preserve the public API",
        definitionOfDone: "All callers migrated",
        results: "Two callers migrated",
        userActions: "Choose rollout time",
      });
      for (const status of ["paused", "completed", "active"]) {
        const changed = yield* call("t3_initiative_set_status", { id: "initiative-a", status });
        expect(changed.structuredContent).toMatchObject({
          status,
          decisions: "Keep compatibility until rollout",
          results: "Two callers migrated",
        });
      }
      const read = yield* call("t3_initiative_read", {});
      expect(read.structuredContent).toMatchObject({
        initiative: {
          status: "active",
          plan: "Migrate the final caller",
          links: "https://example.com/research",
        },
      });
      expect(state.records.get("initiative-b")?.brief).toBe("Different brief");
    }).pipe(Effect.provide(state.layer));
  },
);

it.effect(
  "creates in this thread's project and reports missing targets for external clients",
  () => {
    const state = fixture();
    const external: McpInvocationContext.McpInvocationScope = {
      ...scope,
      thread: undefined,
      client: { sessionId: "external", label: "External", runtimeModeCeiling: "full-access" },
    };
    return Effect.gen(function* () {
      const created = yield* call("t3_initiative_create", {
        title: "New work",
        objective: "Ship the change",
        brief: "Retain compatibility",
      });
      expect(created.structuredContent).toMatchObject({
        projectId,
        coordinatorThreadId: threadId,
        brief: "Retain compatibility",
      });
      const missingRead = yield* call("t3_initiative_read", {}, external);
      expect(declaredFailure(missingRead)).toMatchObject({ code: "target_required" });
      const missingCreate = yield* call(
        "t3_initiative_create",
        { title: "External", objective: "Ship it" },
        external,
      );
      expect(declaredFailure(missingCreate)).toMatchObject({ code: "target_required" });
      const explicitRead = yield* call("t3_initiative_read", { id: "initiative-a" }, external);
      expect(explicitRead.structuredContent).toMatchObject({ initiative: { id: "initiative-a" } });
      expect(state.mutations).toEqual(["create"]);
    }).pipe(Effect.provide(state.layer));
  },
);

it.effect("refuses stale provider writes and higher-permission coordinator mutations", () => {
  const state = fixture({ active: false });
  return Effect.gen(function* () {
    const stale = yield* call("t3_initiative_update", {
      id: "initiative-a",
      objective: "Overwrite",
    });
    expect(declaredFailure(stale)).toMatchObject({ code: "parent_not_active" });
    const external: McpInvocationContext.McpInvocationScope = {
      ...scope,
      thread: undefined,
      client: { sessionId: "external", label: "External", runtimeModeCeiling: "auto" },
    };
    const escalation = yield* call(
      "t3_initiative_set_status",
      { id: "initiative-b", status: "active" },
      external,
    );
    expect(declaredFailure(escalation)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const missingCapability = yield* call(
      "t3_initiative_read",
      { id: "initiative-a" },
      { ...scope, capabilities: new Set() },
    );
    expect(declaredFailure(missingCapability)).toMatchObject({ code: "capability_denied" });
    expect(state.mutations).toEqual([]);
  }).pipe(Effect.provide(state.layer));
});
