import { afterEach, beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { applyRuntimeMigrationFiles } from '../../lib/migrations';
import { PRESCRIPTION_ISSUANCE_MIGRATIONS as files } from '../../lib/prescription-issuance-migration';
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
const key = '11111111-1111-4111-8111-111111111111';
const seed = `CREATE TABLE prescriptions(id INTEGER PRIMARY KEY,patient_id INTEGER NOT NULL,visit_id INTEGER,created_by TEXT NOT NULL); INSERT INTO prescriptions VALUES(1,7,9,'synthetic-clinician'),(2,8,9,'synthetic-clinician');`;
const reserve = `INSERT INTO prescription_issuance_commands(command_key,actor_user_id,actor_username,patient_id,visit_id,payload_sha256) VALUES('${key}',3,'synthetic-clinician',7,9,'${'a'.repeat(64)}')`;
beforeEach(async () => { fixture = await openBackupTimestampFixture(process.env); await fixture.source.query(seed); await applyRuntimeMigrationFiles(fixture.source,files); });
afterEach(async () => { await fixture?.close(); });
async function complete() {
 const client = await fixture.source.connect();
 try { await client.query('BEGIN'); await client.query(reserve); await client.query('UPDATE prescription_issuance_commands SET prescription_id=1'); await client.query('COMMIT'); }
 catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
it('pins numbered/runtime bytes and verifies registered catalog on repeat startup', async () => {
 expect(readFileSync(`migrations/${files[0].filename}`,'utf8')).toBe(files[0].sql);
 expect(await applyRuntimeMigrationFiles(fixture.source,files)).toEqual([]);
});
it('rejects committing a pending reservation and leaves no receipt', async () => {
 await expect(fixture.source.query(reserve)).rejects.toThrow('PRESCRIPTION_COMMAND_INCOMPLETE');
 expect((await fixture.source.query('SELECT * FROM prescription_issuance_commands')).rows).toEqual([]);
});
it('deferred check reads final row rather than initial INSERT NEW, permits completed backup insert', async () => {
 await complete(); expect((await fixture.source.query('SELECT prescription_id FROM prescription_issuance_commands')).rows).toEqual([{prescription_id:1}]);
 await fixture.sqlTarget.query(seed); await applyRuntimeMigrationFiles(fixture.sqlTarget,files);
 const row = (await fixture.source.query('SELECT * FROM prescription_issuance_commands')).rows[0];
 await fixture.sqlTarget.query('INSERT INTO prescription_issuance_commands(command_key,actor_user_id,actor_username,patient_id,visit_id,payload_sha256,prescription_id,warning_fingerprint,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',Object.values(row));
 expect((await fixture.sqlTarget.query('SELECT * FROM prescription_issuance_commands')).rows).toEqual([row]);
});
it.each([
 "command_key='22222222-2222-4222-8222-222222222222'", 'actor_user_id=4', "actor_username='other'", 'patient_id=8', 'visit_id=NULL',
 `payload_sha256='${'b'.repeat(64)}'`, 'prescription_id=2', `warning_fingerprint='${'c'.repeat(64)}'`, "created_at=created_at+interval '1 second'",
])('completed binding is immutable: %s', async change => { await complete(); await expect(fixture.source.query(`UPDATE prescription_issuance_commands SET ${change}`)).rejects.toThrow('PRESCRIPTION_COMMAND_IMMUTABLE'); });
it('rejects deletion and dangling Rx deletion after completion', async () => {
 await fixture.source.query('TRUNCATE prescription_issuance_commands');
 await complete(); await expect(fixture.source.query('TRUNCATE prescription_issuance_commands')).rejects.toThrow('PRESCRIPTION_COMMAND_HISTORY_RETAINED');
 await expect(fixture.source.query('DELETE FROM prescription_issuance_commands')).rejects.toThrow('PRESCRIPTION_COMMAND_IMMUTABLE');
 await expect(fixture.source.query('DELETE FROM prescriptions WHERE id=1')).rejects.toThrow();
});
it('cannot reassign pending binding or complete against a different patient Rx', async () => {
 const client = await fixture.source.connect();
 try {
  await client.query('BEGIN'); await client.query(reserve);
  await expect(client.query('UPDATE prescription_issuance_commands SET patient_id=8')).rejects.toThrow('PRESCRIPTION_COMMAND_IMMUTABLE'); await client.query('ROLLBACK');
  await client.query('BEGIN'); await client.query(reserve); await client.query('UPDATE prescription_issuance_commands SET prescription_id=2');
  await expect(client.query('COMMIT')).rejects.toThrow('PRESCRIPTION_COMMAND_BINDING_MISMATCH'); await client.query('ROLLBACK');
 } finally { client.release(); }
 expect((await fixture.source.query('SELECT * FROM prescription_issuance_commands')).rows).toEqual([]);
});
it('rolls back receipt and newly created Rx on injected completion failure', async () => {
 const client = await fixture.source.connect();
 try {
  await client.query('BEGIN'); await client.query(reserve); await client.query("INSERT INTO prescriptions VALUES(3,7,9,'synthetic-clinician')");
  await client.query('UPDATE prescription_issuance_commands SET prescription_id=3');
  await expect(client.query('SELECT 1/0')).rejects.toThrow(); await client.query('ROLLBACK');
 } finally { client.release(); }
 expect((await fixture.source.query('SELECT * FROM prescription_issuance_commands')).rows).toEqual([]);
 expect((await fixture.source.query('SELECT * FROM prescriptions WHERE id=3')).rows).toEqual([]);
});
it.each(['droptrigger','disabletrigger','function','constraint','column','registry'])('rejects drift before runtime skip: %s', async kind => {
 if(kind==='droptrigger') await fixture.source.query('DROP TRIGGER prescription_command_complete ON prescription_issuance_commands');
 if(kind==='disabletrigger') await fixture.source.query('ALTER TABLE prescription_issuance_commands DISABLE TRIGGER prescription_command_complete');
 if(kind==='function') await fixture.source.query("CREATE OR REPLACE FUNCTION aqlan_prescription_command_complete() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
 if(kind==='constraint') await fixture.source.query('ALTER TABLE prescription_issuance_commands DROP CONSTRAINT prescription_issuance_commands_patient_id_check');
 if(kind==='column') await fixture.source.query('ALTER TABLE prescription_issuance_commands ALTER COLUMN payload_sha256 TYPE TEXT');
 if(kind==='registry') await fixture.source.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0093'",['0'.repeat(64)]);
 await expect(applyRuntimeMigrationFiles(fixture.source,files)).rejects.toThrow(/PRESCRIPTION_ISSUANCE_(CATALOG|REGISTRY)_MISMATCH/);
});
