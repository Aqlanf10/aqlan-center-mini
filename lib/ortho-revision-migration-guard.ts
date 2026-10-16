import type { DbClient } from "./db";
import type { MigrationFile } from "./migration-files";
import contracts from "./ortho-assessment-runtime.generated.json";

/** Narrow registry witness for the same two files. Other migration contracts
 * retain their existing validation behavior. */
export function validateOrthoRevisionRegistry(file: MigrationFile, row?: { name: string; checksum: string; adopted: boolean }): void {
  const expected = contracts.find(candidate => candidate.version === file.version);
  if (!expected) return;
  if (file.filename !== expected.filename || file.name !== expected.name || file.checksum !== expected.checksum || file.sql !== expected.sql) {
    throw new Error(`ORTHO_MIGRATION_SOURCE_MISMATCH: ${file.version}`);
  }
  if (row && (row.name !== file.name || row.checksum !== file.checksum || row.adopted)) {
    throw new Error(`ORTHO_MIGRATION_REGISTRY_MISMATCH: ${file.version}`);
  }
}

/** Called inside the existing per-file transaction while the migrator's shared
 * advisory lock is held. Unregistered IF NOT EXISTS objects are never adopted. */
export async function guardOrthoRevisionMigration(client: DbClient, file: MigrationFile): Promise<void> {
  const expected = contracts.find(candidate => candidate.version === file.version);
  if (!expected) return;
  validateOrthoRevisionRegistry(file);
  const stem = file.version === "0051" ? "strategy" : "assessment";
  // Include auto-created relation/type names, explicit index and both routines.
  // pg_class also detects views, sequences or indexes masquerading as a table.
  const names = [
    `ortho_${stem}_revisions`, `ortho_${stem}_revisions_id_seq`,
    `ortho_${stem}_revisions_pkey`, `_ortho_${stem}_revisions`,
    `ortho_${stem}_patient_case_version_idx`,
    `reject_ortho_${stem}_revision_mutation`, `check_ortho_${stem}_revision_final_state`,
    ...[...expected.sql.matchAll(/\bCONSTRAINT\s+([a-z_][a-z0-9_]*)/g)].map(match => match[1]),
  ];
  const collisions = await client.query<{ name: string }>(`
    SELECT c.relname AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    UNION SELECT p.proname AS name FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::text[])
    UNION SELECT t.typname AS name FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public' AND t.typname=ANY($1::text[])
  `, [names]);
  if (collisions.rows.length) throw new Error(`ORTHO_UNREGISTERED_OBJECT_COLLISION: ${file.version}: ${collisions.rows.map(row => row.name).sort().join(",")}`);
}
