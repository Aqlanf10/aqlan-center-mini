import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

/**
 * Retained red artifact for the #392 design (reproduced on #392 f2c9c98c: a database holding one
 * committed correction failed to restore with "U0 kind requires same-transaction authoritative root
 * claim"). The #392 trigger is NOT imported. A minimal synthetic trigger with the same property —
 * it INSERTs rows while validating an INSERT — shows the failure mode on the real backup path, and
 * the shipped 0063/0069 currency triggers are checked never to generate rows.
 */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_restore_generating_trigger_test");
const db = await import("../../lib/db");
const SYNTHETIC = `
CREATE TABLE synthetic_claims (id SERIAL PRIMARY KEY, note TEXT NOT NULL);
CREATE TABLE synthetic_issued (id SERIAL PRIMARY KEY, claim_id INTEGER NOT NULL UNIQUE REFERENCES synthetic_claims(id));
CREATE FUNCTION synthetic_issue() RETURNS TRIGGER AS $$
BEGIN INSERT INTO synthetic_issued(claim_id) VALUES (NEW.id); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER synthetic_issue AFTER INSERT ON synthetic_claims FOR EACH ROW EXECUTE FUNCTION synthetic_issue();`;
beforeAll(async () => { await db.ensureSchema(); await db.getPool().query(SYNTHETIC); }, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("a trigger that issues rows on INSERT cannot be replayed by the backup", () => {
  it("RED: replaying one committed generating claim fails, which is why 0069 only validates", async () => {
    const { openBackupTimestampFixture } = await import("./_backup-timestamp-fixture");
    const { prepareBackupSql } = await import("../../lib/restore/sql.mjs");
    const { loadMigrationFiles, migrate } = await import("../../lib/migrations");
    await db.getPool().query("INSERT INTO synthetic_claims(note) VALUES ('synthetic')");
    const client = await db.getPool().connect(); const parts: string[] = [];
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); for await (const line of db.backupSnapshotSqlLines(client)) parts.push(line); await client.query("COMMIT"); }
    finally { client.release(); }
    const isolated = await openBackupTimestampFixture({ ...process.env });
    try {
      await migrate(isolated.sqlTarget, { apply: true, files: await loadMigrationFiles() });
      await isolated.sqlTarget.query(SYNTHETIC);
      // The replayed claim re-fires the trigger, which issues a second row for the same claim.
      await expect(isolated.sqlTarget.query(prepareBackupSql(parts.join("")).sql)).rejects.toThrow(/duplicate key|unique/i);
    } finally { await isolated.close(); }
  });
  it("the shipped currency transition triggers (0063 + 0069) only validate: none of them inserts rows", async () => {
    const { rows } = await db.getPool().query<{ tgname: string; source: string }>(`
      SELECT t.tgname, p.prosrc AS source FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND t.tgrelid IN ('invoice_settlement_reclassifications'::regclass, 'invoice_settlement_reclassification_events'::regclass)
       ORDER BY t.tgname`);
    expect(rows.map((row) => row.tgname)).toEqual(expect.arrayContaining(["invoice_reclassification_direction_guard", "invoice_reclassification_event_direction_guard"]));
    for (const row of rows) expect(row.source, row.tgname).not.toMatch(/\bINSERT\s+INTO\b/i);
  });
});
