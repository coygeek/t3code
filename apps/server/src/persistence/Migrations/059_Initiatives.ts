import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep initiative history even when its project or coordinator is deleted.
  yield* sql`
    CREATE TABLE initiatives (
      initiative_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      coordinator_thread_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE initiative_coordinators (
      initiative_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (initiative_id, thread_id)
    )
  `;
  yield* sql`CREATE INDEX initiatives_project_idx ON initiatives(project_id, created_at)`;
});
