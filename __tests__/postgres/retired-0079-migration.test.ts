import { expect, it } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { checksumOf, loadMigrationFiles, migrate, migrationStatus, validateRuntimeHistorical0079 } from "../../lib/migrations";

it("excludes 0079 on fresh migration and preserves exact historical registration and data", async () => {
  const fixture = await openBackupTimestampFixture(process.env);
  try {
    const files = await loadMigrationFiles();
    const coverage = files.find(f => f.version === "0079")!;
    const fresh = fixture.source, old = fixture.sqlTarget;
    const freshRun = await migrate(fresh, { apply: true, files });
    expect(freshRun.appliedVersions).not.toContain("0079");
    expect((await fresh.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows[0].name).toBeNull();
    expect((await migrationStatus(fresh, files)).consistent).toBe(true);
    await validateRuntimeHistorical0079(fresh, coverage);
    expect((await fresh.query("SELECT version FROM schema_migrations WHERE version='0079'")).rows).toEqual([]);

    const historical = await migrate(old, { apply: true, files, historical0079: true });
    expect(historical.appliedVersions).toContain("0079");
    await old.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-0079-HISTORY','Synthetic history')");
    const before = (await old.query("SELECT * FROM schema_migrations WHERE version='0079'")).rows;
    const data = (await old.query("SELECT id,patient_number,full_name FROM patients WHERE patient_number='SYN-0079-HISTORY'")).rows;
    await validateRuntimeHistorical0079(old, coverage);
    expect((await migrate(old, { apply: true, files })).alreadyUpToDate).toBe(true);
    expect((await migrationStatus(old, files)).consistent).toBe(true);
    expect((await old.query("SELECT * FROM schema_migrations WHERE version='0079'")).rows).toEqual(before);
    expect((await old.query("SELECT id,patient_number,full_name FROM patients WHERE patient_number='SYN-0079-HISTORY'")).rows).toEqual(data);
    const altered = files.map(f => f.version === '0079' ? { ...f, sql: f.sql + '\n', checksum: checksumOf(f.sql + '\n') } : f);
    await expect(migrate(old, { apply: true, files: altered })).rejects.toThrow('HISTORICAL_0079_SOURCE_MISMATCH');
    expect((await migrationStatus(old, altered)).consistent).toBe(false);
    await old.query("ALTER TABLE ortho_followup_coverage_revisions DISABLE TRIGGER ortho_followup_coverage_no_rewrite");
    await expect(migrate(old, { apply: true, files })).rejects.toThrow('HISTORICAL_0079_FOOTPRINT_MISMATCH');
    await expect(validateRuntimeHistorical0079(old, coverage)).rejects.toThrow('HISTORICAL_0079_FOOTPRINT_MISMATCH');
    expect((await migrationStatus(old, files)).consistent).toBe(false);
    await old.query("ALTER TABLE ortho_followup_coverage_revisions ENABLE TRIGGER ortho_followup_coverage_no_rewrite");
    await old.query("CREATE OR REPLACE FUNCTION guard_ortho_followup_coverage_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
    await expect(validateRuntimeHistorical0079(old, coverage)).rejects.toThrow('HISTORICAL_0079_FOOTPRINT_MISMATCH');
    await expect(migrate(old, { apply: true, files })).rejects.toThrow('HISTORICAL_0079_FOOTPRINT_MISMATCH');
    expect((await migrationStatus(old, files)).consistent).toBe(false);
    const originalGuard = coverage.sql.match(/CREATE FUNCTION guard_ortho_followup_coverage_append_only\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$[\s\S]*?\$\$;/)?.[0];
    if (!originalGuard) throw new Error('missing exact historic function');
    await old.query(originalGuard.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    await old.query("ALTER TABLE visits ALTER COLUMN ortho_followup_coverage_proof TYPE text USING ortho_followup_coverage_proof::text");
    await expect(validateRuntimeHistorical0079(old, coverage)).rejects.toThrow('HISTORICAL_0079_FOOTPRINT_MISMATCH');
    await expect(migrate(old, { apply: true, files })).rejects.toThrow('HISTORICAL_0079_FOOTPRINT_MISMATCH');
    expect((await migrationStatus(old, files)).consistent).toBe(false);
    await old.query("ALTER TABLE visits ALTER COLUMN ortho_followup_coverage_proof TYPE jsonb USING ortho_followup_coverage_proof::jsonb");
    await validateRuntimeHistorical0079(old, coverage);
    const unregistered = fixture.archiveTarget;
    await migrate(unregistered, { apply: true, files });
    await unregistered.query(coverage.sql);
    await expect(migrate(unregistered, { apply: true, files })).rejects.toThrow('HISTORICAL_0079_FOOTPRINT_MISMATCH');
    await expect(validateRuntimeHistorical0079(unregistered, coverage)).rejects.toThrow('HISTORICAL_0079_FOOTPRINT_MISMATCH');
    expect((await migrationStatus(unregistered, files)).consistent).toBe(false);
    await old.query("UPDATE schema_migrations SET name='unreviewed' WHERE version='0079'");
    await expect(migrate(old, { apply: true, files })).rejects.toThrow('HISTORICAL_0079_REGISTRY_MISMATCH');
    await expect(validateRuntimeHistorical0079(old, coverage)).rejects.toThrow('HISTORICAL_0079_REGISTRY_MISMATCH');
    expect((await migrationStatus(old, files)).consistent).toBe(false);
  } finally { await fixture.close(); }
}, 180000);

it("runtime bootstrap does not install retired coverage on a fresh owned database and accepts an exact old one", async () => {
  const fixture = await openBackupTimestampFixture(process.env);
  const saved = process.env.DATABASE_URL;
  const savedSeed = process.env.SKIP_SEED;
  const db = await import("../../lib/db");
  try {
    process.env.SKIP_SEED = 'true';
    process.env.DATABASE_URL = fixture.source.options.connectionString!;
    await db.resetPoolForTesting();
    await db.ensureSchema();
    expect((await fixture.source.query("SELECT version FROM schema_migrations WHERE version='0079'")).rows).toEqual([]);
    expect((await fixture.source.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows[0].name).toBeNull();
    await db.resetPoolForTesting();
    const files = await loadMigrationFiles();
    await migrate(fixture.sqlTarget, { apply: true, files, historical0079: true });
    const before = (await fixture.sqlTarget.query("SELECT * FROM schema_migrations WHERE version='0079'")).rows;
    process.env.DATABASE_URL = fixture.sqlTarget.options.connectionString!;
    await db.ensureSchema();
    expect((await fixture.sqlTarget.query("SELECT * FROM schema_migrations WHERE version='0079'")).rows).toEqual(before);
  } finally {
    await db.resetPoolForTesting();
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    if (savedSeed === undefined) delete process.env.SKIP_SEED; else process.env.SKIP_SEED = savedSeed;
    await fixture.close();
  }
}, 180000);
