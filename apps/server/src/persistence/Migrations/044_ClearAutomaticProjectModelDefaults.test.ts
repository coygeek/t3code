import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ClearAutomaticProjectModelDefaults", (it) => {
  it.effect("clears create-time seeds while preserving explicit project default writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          default_thread_env_mode,
          favicon_path,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          ('project-auto', 'Auto', '/tmp/auto', '{"instanceId":"codex","model":"gpt-5.6-sol"}', NULL, NULL, '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL),
          ('project-title-only', 'Title only', '/tmp/title-only', '{"instanceId":"codex","model":"gpt-5.6-sol"}', NULL, NULL, '[]', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL),
          ('project-explicit-reset', 'Explicit reset', '/tmp/explicit-reset', NULL, NULL, NULL, '[]', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL),
          ('project-explicit-same', 'Explicit same', '/tmp/explicit-same', '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}', NULL, NULL, '[]', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL),
          ('project-no-create-event', 'No create event', '/tmp/no-create', '{"instanceId":"codex","model":"custom-model"}', NULL, NULL, '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL)
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          ('event-auto-create', 'project', 'project-auto', 0, 'project.created', '2026-08-01T00:00:00.000Z', 'command-auto-create', NULL, 'command-auto-create', 'client', '{"projectId":"project-auto","title":"Auto","workspaceRoot":"/tmp/auto","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"},"faviconPath":null,"scripts":[],"createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z"}', '{}'),
          ('event-title-create', 'project', 'project-title-only', 0, 'project.created', '2026-08-01T00:00:00.000Z', 'command-title-create', NULL, 'command-title-create', 'client', '{"projectId":"project-title-only","title":"Title only","workspaceRoot":"/tmp/title-only","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"},"faviconPath":null,"scripts":[],"createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z"}', '{}'),
          ('event-title-update', 'project', 'project-title-only', 1, 'project.meta-updated', '2026-08-02T00:00:00.000Z', 'command-title-update', NULL, 'command-title-update', 'client', '{"projectId":"project-title-only","title":"Renamed","updatedAt":"2026-08-02T00:00:00.000Z"}', '{}'),
          ('event-reset-create', 'project', 'project-explicit-reset', 0, 'project.created', '2026-08-01T00:00:00.000Z', 'command-reset-create', NULL, 'command-reset-create', 'client', '{"projectId":"project-explicit-reset","title":"Explicit reset","workspaceRoot":"/tmp/explicit-reset","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"},"faviconPath":null,"scripts":[],"createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z"}', '{}'),
          ('event-reset-update', 'project', 'project-explicit-reset', 1, 'project.meta-updated', '2026-08-02T00:00:00.000Z', 'command-reset-update', NULL, 'command-reset-update', 'client', '{"projectId":"project-explicit-reset","defaultModelSelection":null,"updatedAt":"2026-08-02T00:00:00.000Z"}', '{}'),
          ('event-explicit-create', 'project', 'project-explicit-same', 0, 'project.created', '2026-08-01T00:00:00.000Z', 'command-explicit-create', NULL, 'command-explicit-create', 'client', '{"projectId":"project-explicit-same","title":"Explicit same","workspaceRoot":"/tmp/explicit-same","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"},"faviconPath":null,"scripts":[],"createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z"}', '{}'),
          ('event-explicit-update', 'project', 'project-explicit-same', 1, 'project.meta-updated', '2026-08-02T00:00:00.000Z', 'command-explicit-update', NULL, 'command-explicit-update', 'client', '{"projectId":"project-explicit-same","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]},"updatedAt":"2026-08-02T00:00:00.000Z"}', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly defaultModelSelection: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(
        projectRows.map((row) => ({
          projectId: row.projectId,
          selection: row.defaultModelSelection ? JSON.parse(row.defaultModelSelection) : null,
        })),
        [
          { projectId: "project-auto", selection: null },
          { projectId: "project-explicit-reset", selection: null },
          {
            projectId: "project-explicit-same",
            selection: {
              instanceId: "codex",
              model: "gpt-5.6-sol",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          },
          {
            projectId: "project-no-create-event",
            selection: { instanceId: "codex", model: "custom-model" },
          },
          { projectId: "project-title-only", selection: null },
        ],
      );

      const createdEvents = yield* sql<{
        readonly streamId: string;
        readonly payloadJson: string;
      }>`
        SELECT stream_id AS "streamId", payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_type = 'project.created'
        ORDER BY stream_id
      `;
      assert.deepStrictEqual(
        createdEvents.map((row) => ({
          streamId: row.streamId,
          defaultModelSelection: JSON.parse(row.payloadJson).defaultModelSelection,
        })),
        [
          { streamId: "project-auto", defaultModelSelection: null },
          {
            streamId: "project-explicit-reset",
            defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
          },
          {
            streamId: "project-explicit-same",
            defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
          },
          { streamId: "project-title-only", defaultModelSelection: null },
        ],
      );
    }),
  );
});
