import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import type { DbClient } from '../lib/db';
import { PRESCRIPTION_ISSUANCE_MIGRATIONS as files, validatePrescriptionIssuanceMigration } from '../lib/prescription-issuance-migration';
/** In-memory SQL smoke only. PostgreSQL18 concurrency and restore remain required. */
it('validates receipt DDL, final-row deferred completion and immutable persisted binding in memory', async () => {
 const pg = new PGlite();
 const key = '11111111-1111-4111-8111-111111111111';
 const reserve = `INSERT INTO prescription_issuance_commands(command_key,actor_user_id,actor_username,patient_id,visit_id,payload_sha256) VALUES('${key}',3,'synthetic-clinician',7,9,'${'a'.repeat(64)}')`;
 const client = { query: (sql:string,values?:unknown[]) => pg.query(sql,values), release: () => {} } as unknown as DbClient;
 try {
  await pg.exec("CREATE TABLE prescriptions(id INTEGER PRIMARY KEY,patient_id INTEGER NOT NULL,visit_id INTEGER,created_by TEXT NOT NULL); INSERT INTO prescriptions VALUES(1,7,9,'synthetic-clinician');");
  await validatePrescriptionIssuanceMigration(client,files,[]);
  await pg.exec(files[0].sql);
  await validatePrescriptionIssuanceMigration(client,files,[{...files[0],adopted:false}]);
  await pg.exec('TRUNCATE prescription_issuance_commands');
  await expect(pg.query(reserve)).rejects.toThrow('PRESCRIPTION_COMMAND_INCOMPLETE');
  expect((await pg.query('SELECT * FROM prescription_issuance_commands')).rows).toEqual([]);
  await pg.exec('BEGIN'); await pg.query(reserve); await pg.query('UPDATE prescription_issuance_commands SET prescription_id=1'); await pg.exec('COMMIT');
  expect((await pg.query('SELECT prescription_id FROM prescription_issuance_commands')).rows).toEqual([{prescription_id:1}]);
  await expect(pg.query('TRUNCATE prescription_issuance_commands')).rejects.toThrow('PRESCRIPTION_COMMAND_HISTORY_RETAINED');
  await expect(pg.query('DELETE FROM prescription_issuance_commands')).rejects.toThrow('PRESCRIPTION_COMMAND_IMMUTABLE');
  await expect(pg.query('UPDATE prescription_issuance_commands SET patient_id=8')).rejects.toThrow('PRESCRIPTION_COMMAND_IMMUTABLE');
  await pg.exec('ALTER TABLE prescription_issuance_commands DISABLE TRIGGER prescription_command_complete');
  await expect(validatePrescriptionIssuanceMigration(client,files,[{...files[0],adopted:false}])).rejects.toThrow('PRESCRIPTION_ISSUANCE_CATALOG_MISMATCH');
 } finally { await pg.close(); }
}, 30_000);
