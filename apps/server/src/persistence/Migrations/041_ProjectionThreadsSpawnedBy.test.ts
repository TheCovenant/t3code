import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadsSpawnedBy", (it) => {
  it.effect("adds the optional parent thread column without rewriting rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          created_at,
          updated_at
        ) VALUES (
          'thread-before-041',
          'project-before-041',
          'Existing thread',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const spawnedBy = columns.find((column) => column.name === "spawned_by_thread_id");
      assert.equal(spawnedBy?.notnull, 0);

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly title: string;
        readonly spawned_by_thread_id: string | null;
      }>`
        SELECT thread_id, title, spawned_by_thread_id
        FROM projection_threads
        WHERE thread_id = 'thread-before-041'
      `;
      assert.deepEqual(rows, [
        {
          thread_id: "thread-before-041",
          title: "Existing thread",
          spawned_by_thread_id: null,
        },
      ]);
    }),
  );
});
