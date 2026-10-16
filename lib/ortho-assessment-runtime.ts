import type { DbClient, DbPool } from "./db";
import { applyRuntimeMigrationFiles, listAppliedMigrations, MIGRATION_ADVISORY_LOCK_KEY } from "./migrations";
import contracts from "./ortho-assessment-runtime.generated.json";
import { guardOrthoRevisionMigration, validateOrthoRevisionRegistry } from "./ortho-revision-migration-guard";

/** Add only the two authorized extensions. Reuse the existing lock and exact
 * per-file transaction writer on the same connection; no full migrate/backfill. */
export async function applyOrthoAssessmentRuntime(pool: DbPool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      const applied = await listAppliedMigrations(client);
      // Guard the entire candidate pair before any DDL. Existing registered
      // contracts are validated, never silently adopted from object presence.
      for (const file of contracts) {
        const row = applied.find(candidate => candidate.version === file.version);
        validateOrthoRevisionRegistry(file, row);
        if (!row) await guardOrthoRevisionMigration(client, file);
      }
      // Advisory session locks are reentrant. The inner method acquires/releases
      // its own count and owns BEGIN/COMMIT; this outer count spans preflight.
      const shared: DbClient = { query: client.query.bind(client), release() {} };
      return await applyRuntimeMigrationFiles({ query: shared.query, connect: async () => shared }, contracts);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally { client.release(); }
}
