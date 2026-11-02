import { afterEach, beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from '../../lib/migrations';
import { PRESCRIPTION_LINEAGE_MIGRATIONS as lineage } from '../../lib/prescription-migration-lineage';
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
beforeEach(async()=> { fixture=await openBackupTimestampFixture(process.env); });
afterEach(async()=> { await fixture?.close(); });
const base=async()=> { const files=await loadMigrationFiles();await migrate(fixture.source,{apply:true,files:files.filter(file=>file.version<'0090')}); };
const registry=async()=> (await fixture.source.query('SELECT to_jsonb(r)::text AS row FROM schema_migrations r ORDER BY version')).rows;
it('pins original booking bytes, preserves historic0090 and adds independent0091/0092 on both bootstrap paths',async()=>{
 for(const file of lineage)expect(readFileSync(`migrations/${file.filename}`,'utf8')).toBe(file.sql);
 await base();await applyRuntimeMigrationFiles(fixture.source,[lineage[0]]);
 await fixture.source.query("INSERT INTO booking_requests(full_name,phone,request_key,preferences) VALUES('Synthetic retained request','000000000','synthetic-key','{\"fixture\":true}')");
 const history=await registry();const rows=(await fixture.source.query('SELECT to_jsonb(b)::text AS row FROM booking_requests b')).rows;
 expect(await applyRuntimeMigrationFiles(fixture.source,lineage)).toEqual(['0091','0092']);
 expect((await registry()).slice(0,history.length)).toEqual(history);
 expect((await fixture.source.query('SELECT to_jsonb(b)::text AS row FROM booking_requests b')).rows).toEqual(rows);
 expect(await applyRuntimeMigrationFiles(fixture.source,lineage)).toEqual([]);
 const files=await loadMigrationFiles();await migrate(fixture.sqlTarget,{apply:true,files});
 expect((await migrate(fixture.sqlTarget,{apply:true,files})).appliedVersions).toEqual([]);
 expect((await fixture.sqlTarget.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version>='0090' ORDER BY version")).rows)
  .toEqual(lineage.map(({version,name,checksum})=>({version,name,checksum,adopted:false})));
});
it.each(['checksum','old_rx0090','adopted'])('rejects %s registry before either pending Rx column is added',async kind=>{
 await base();await applyRuntimeMigrationFiles(fixture.source,[lineage[0]]);
 if(kind==='checksum')await fixture.source.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0090'",['0'.repeat(64)]);
 if(kind==='old_rx0090')await fixture.source.query("UPDATE schema_migrations SET name='prescribing_doctor_snapshot',checksum=$1 WHERE version='0090'",[lineage[2].checksum]);
 if(kind==='adopted')await fixture.source.query("UPDATE schema_migrations SET adopted=true WHERE version='0090'");
 const before=await registry();
 await expect(applyRuntimeMigrationFiles(fixture.source,lineage)).rejects.toThrow('PRESCRIPTION_MIGRATION_REGISTRY_MISMATCH: 0090');
 await expect(migrate(fixture.source,{apply:true,files:await loadMigrationFiles()})).rejects.toThrow('PRESCRIPTION_MIGRATION_REGISTRY_MISMATCH: 0090');
 expect(await registry()).toEqual(before);
 expect((await fixture.source.query("SELECT column_name FROM information_schema.columns WHERE table_name='prescriptions' AND column_name LIKE 'prescribing_doctor%'")).rows).toEqual([]);
});
it.each(['registered_wrong_type','pending_wrong_type','missing_index','unregistered_booking'])('rejects catalog state %s rather than treating IF NOT EXISTS as verification',async kind=>{
 await base();
 if(kind!=='unregistered_booking')await applyRuntimeMigrationFiles(fixture.source,lineage);
 if(kind==='registered_wrong_type')await fixture.source.query('ALTER TABLE prescriptions ALTER COLUMN prescribing_doctor_name TYPE integer USING NULL');
 if(kind==='pending_wrong_type'){await fixture.source.query("DELETE FROM schema_migrations WHERE version='0092'");await fixture.source.query('ALTER TABLE prescriptions ALTER COLUMN prescribing_doctor_name TYPE integer USING NULL');}
 if(kind==='missing_index')await fixture.source.query('DROP INDEX booking_requests_request_key_idx');
 if(kind==='unregistered_booking')await fixture.source.query(lineage[0].sql);
 const before=await registry();
 await expect(applyRuntimeMigrationFiles(fixture.source,lineage)).rejects.toThrow('PRESCRIPTION_MIGRATION_CATALOG_MISMATCH');
 await expect(migrate(fixture.source,{apply:true,files:await loadMigrationFiles()})).rejects.toThrow('PRESCRIPTION_MIGRATION_CATALOG_MISMATCH');
 expect(await registry()).toEqual(before);
});
