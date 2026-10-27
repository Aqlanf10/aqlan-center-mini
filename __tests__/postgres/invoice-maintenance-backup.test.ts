import { expect, it } from "vitest";
import type { Pool } from "pg";
import { applyRuntimeMigrationFiles } from "../../lib/migrations";
import { loadMigrationFiles } from "../../lib/migration-files";
import { prepareBackupSql } from "../../lib/restore/sql.mjs";
import { backupSqlLines } from "../../lib/db";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";

// Actual production backup writer, actual registered migration guards, disposable synthetic
// parent relations. No live backup, existing database reset or trigger bypass.
const parents = `
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active BOOLEAN NOT NULL);
CREATE TABLE patients(id INTEGER PRIMARY KEY);
CREATE TABLE invoices(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), invoice_number TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, base_currency TEXT NOT NULL, status TEXT NOT NULL, total_minor BIGINT NOT NULL,
 discount_minor BIGINT NOT NULL, idempotency_key TEXT, created_by TEXT NOT NULL);
CREATE TABLE invoice_items(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id));
`;
const tables = ["users", "patients", "invoices", "invoice_items", "invoice_archive_events", "invoice_archive_rejections", "invoice_service_additions", "invoice_service_addition_rejections"];
async function state(pool: Pool) {
  return Promise.all(tables.map(async table => [table, (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows]));
}
it("replays nonempty archive and supplement proofs after actor and invoice status changes in dependency/stream order", async () => {
  const fixture = await openBackupTimestampFixture({ ...process.env });
  try {
    const { source, sqlTarget } = fixture;
    const files=(await loadMigrationFiles()).filter(file=>["0081","0082"].includes(file.version));
    expect(files.map(file=>file.version)).toEqual(["0081","0082"]);
    for (const pool of [source, sqlTarget]) {
      await pool.query(parents);
      await applyRuntimeMigrationFiles(pool, files);
    }
    await source.query(`INSERT INTO users VALUES (1,'historical-admin','admin',TRUE); INSERT INTO patients VALUES (1);
      INSERT INTO invoices VALUES (1,1,'SYN-ORIGINAL','2026-10-01T12:00:00Z','YER','paid',10000,0,NULL,'historical-admin'),
        (2,1,'SYN-SUPPLEMENT','2026-10-26T12:00:00Z','YER','open',2000,0,'synthetic-add-key','historical-admin');
      INSERT INTO invoice_items VALUES (1,1),(2,2);`);
    for (const version of [1,2,3]) await source.query(`INSERT INTO invoice_archive_events
      (invoice_id,patient_id,invoice_number,invoice_created_at,currency,version,action,reason,idempotency_key,request_hash,actor_user_id,actor)
      VALUES (1,1,'SYN-ORIGINAL','2026-10-01T12:00:00Z','YER',$1,$2,'Synthetic organization',$3,$4,1,'historical-admin')`,
    [version, version === 2 ? "restore" : "archive", `synthetic-archive-${version}`, "a".repeat(64)]);
    const receipt = { originalInvoiceId:1, additionalInvoiceId:2, additionalInvoiceNumber:"SYN-SUPPLEMENT", patientId:1, currency:"YER", idempotencyKey:"synthetic-add-key", requestHash:"b".repeat(64), createdBy:"historical-admin", addedNetMinor:2000, cashMovementMinor:0 };
    await source.query(`INSERT INTO invoice_service_additions(original_invoice_id,additional_invoice_id,patient_id,currency,source_hash,idempotency_key,request_hash,actor_id,created_by,reason,receipt)
      VALUES (1,2,1,'YER',$1,'synthetic-add-key',$2,1,'historical-admin','Synthetic addition',$3)`, ["a".repeat(64),"b".repeat(64),JSON.stringify(receipt)]);
    await source.query(`INSERT INTO invoice_archive_rejections(idempotency_key,invoice_id,actor_user_id,request_hash,code,message)
      VALUES ('synthetic-archive-rejected',1,1,$1,'period_locked','Synthetic closed period');`, ["c".repeat(64)]);
    await source.query(`INSERT INTO invoice_service_addition_rejections(idempotency_key,original_invoice_id,actor_id,request_hash,expected_source_hash,observed_source_hash)
      VALUES ('synthetic-add-rejected',1,1,$1,$1,$2)`, ["c".repeat(64),"d".repeat(64)]);
    // Historical facts must not become unrestorable when live authority changes.
    await source.query(`UPDATE users SET username='renamed-reader',role='reception',is_active=FALSE WHERE id=1;
      UPDATE invoices SET status='cancelled' WHERE id=1;
      CREATE INDEX synthetic_archive_reverse ON invoice_archive_events(invoice_id,version DESC);
      CLUSTER invoice_archive_events USING synthetic_archive_reverse;`);
    expect((await source.query("SELECT version FROM invoice_archive_events")).rows.map(row=>row.version)).toEqual([3,2,1]);
    const before = await state(source), client = await source.connect();
    let sql = "";
    try { for await (const line of backupSqlLines(client)) sql += line; } finally { client.release(); }
    expect(sql.indexOf('-- invoice_items (')).toBeLessThan(sql.indexOf('-- invoice_service_additions ('));
    await sqlTarget.query(prepareBackupSql(sql).sql);
    expect(await state(sqlTarget)).toEqual(before);
    expect(await state(source)).toEqual(before);
  } finally { await fixture.close(); }
});
