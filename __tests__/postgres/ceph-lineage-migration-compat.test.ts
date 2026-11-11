import { afterEach, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from '../../lib/migrations';
import { checksumOf } from '../../lib/migration-files';
import { loadRestoreMigrationChecksums } from '../../lib/restore/migration-provenance.mjs';
import { prepareBackupSql } from '../../lib/restore/sql.mjs';
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
const files = await loadMigrationFiles();
const lineage = files.find(file => file.version === '0124')!;
beforeEach(async () => { fixture = await openBackupTimestampFixture(process.env); });
afterEach(async () => { await fixture?.close(); });
async function base(pool = fixture.source) {
  await migrate(pool, {apply: true, files: files.filter(file => file.version < '0124')});
}
const legacy = `ALTER TABLE ceph_analyses ADD COLUMN corrects_analysis_id BIGINT;
 CREATE UNIQUE INDEX ceph_analyses_patient_id_key ON ceph_analyses(patient_id,id);
 ALTER TABLE ceph_analyses ADD CONSTRAINT ceph_analyses_corrects_older_chk CHECK(corrects_analysis_id IS NULL OR corrects_analysis_id<id),
 ADD CONSTRAINT ceph_analyses_corrects_same_patient_fk FOREIGN KEY(patient_id,corrects_analysis_id) REFERENCES ceph_analyses(patient_id,id);`;
async function snapshot(pool = fixture.source) {
  return (await pool.query(`SELECT to_jsonb(c)::text AS row FROM ceph_analyses c ORDER BY id`)).rows;
}
async function analysis() {
  const patient = (await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES('synthetic','Synthetic') RETURNING id")).rows[0].id;
  const doc = (await fixture.source.query("INSERT INTO patient_documents(patient_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'Synthetic','image/png',1,$2,'synthetic','synthetic') RETURNING id",[patient,'a'.repeat(64)])).rows[0].id;
  const parent = (await fixture.source.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by) VALUES($1,$2,'completed','synthetic') RETURNING id",[patient,doc])).rows[0].id;
  return {patient,doc,parent};
}
const registry = async () => (await fixture.source.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
it('keeps immutable bytes; fresh and legacy upgrades add the same 0124 objects and preserve old columns/constraints',async () => {
  expect(checksumOf(lineage.sql)).toBe('0d1d94a2003db6599dee120be75c3ff092ad4a19f4e1c911cbde1aa9fc845355');
  await base(); await fixture.source.query(legacy); await analysis();
  const before = await snapshot();
  expect(await applyRuntimeMigrationFiles(fixture.source,[lineage])).toEqual(['0124']);
  expect((await snapshot()).map(({row}) => {const value=JSON.parse(row);delete value.correction_source;delete value.correction_source_canonical;delete value.correction_source_sha256;return value;}))
    .toEqual(before.map(({row})=>JSON.parse(row)));
  await migrate(fixture.sqlTarget,{apply:true,files});
  const catalog = async (pool: Pool) => (await pool.query(`SELECT 'constraint' AS kind,conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='ceph_analyses'::regclass AND conname IN ('ceph_correction_origin_complete','ceph_analyses_corrects_analysis_id_fkey')
    UNION ALL SELECT 'trigger',tgname,pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='ceph_analyses'::regclass AND tgname LIKE 'ceph_correction%'
    UNION ALL SELECT 'function',proname,pg_get_functiondef(oid) FROM pg_proc WHERE proname IN ('guard_ceph_correction_lineage','check_ceph_correction_final_state') ORDER BY kind,name`)).rows;
  expect(await catalog(fixture.source)).toEqual(await catalog(fixture.sqlTarget));
  expect((await fixture.source.query("SELECT conname FROM pg_constraint WHERE conrelid='ceph_analyses'::regclass AND conname LIKE 'ceph_analyses_corrects_%' ORDER BY conname")).rows).toHaveLength(3);
  const registered=await registry();const after=await snapshot();
  expect(await applyRuntimeMigrationFiles(fixture.source,[lineage])).toEqual([]);
  expect((await migrate(fixture.source,{apply:true,files:files.filter(file=>file.version<='0124')})).appliedVersions).toEqual([]);
  expect(await registry()).toEqual(registered);expect(await snapshot()).toEqual(after);
});
it.each(['type','default','not_null','missing_check','unvalidated','source_residue','linked','collision','wrong_check_name'])('fails closed and rolls back incompatible legacy %s',async kind => {
  await base();await fixture.source.query(legacy);
  if(kind==='type')await fixture.source.query('ALTER TABLE ceph_analyses ALTER COLUMN corrects_analysis_id TYPE integer');
  if(kind==='default')await fixture.source.query('ALTER TABLE ceph_analyses ALTER COLUMN corrects_analysis_id SET DEFAULT 1');
  if(kind==='not_null')await fixture.source.query('ALTER TABLE ceph_analyses ALTER COLUMN corrects_analysis_id SET NOT NULL');
  if(kind==='wrong_check_name')await fixture.source.query('ALTER TABLE ceph_analyses RENAME CONSTRAINT ceph_analyses_corrects_older_chk TO ceph_analyses_corrects_older_ck');
  if(kind==='missing_check')await fixture.source.query('ALTER TABLE ceph_analyses DROP CONSTRAINT ceph_analyses_corrects_older_chk');
  if(kind==='unvalidated')await fixture.source.query('ALTER TABLE ceph_analyses DROP CONSTRAINT ceph_analyses_corrects_older_chk; ALTER TABLE ceph_analyses ADD CONSTRAINT ceph_analyses_corrects_older_chk CHECK(corrects_analysis_id IS NULL OR corrects_analysis_id<id) NOT VALID');
  if(kind==='source_residue')await fixture.source.query('ALTER TABLE ceph_analyses ADD COLUMN correction_source JSONB');
  if(kind==='linked'){const {patient,doc,parent}=await analysis();await fixture.source.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,corrects_analysis_id) VALUES($1,$2,'draft','synthetic',$3)",[patient,doc,parent]);}
  if(kind==='collision')await fixture.source.query('CREATE FUNCTION guard_ceph_correction_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
  const rows=await snapshot(),registered=await registry();
  await expect(applyRuntimeMigrationFiles(fixture.source,[lineage])).rejects.toThrow();
  await expect(migrate(fixture.source,{apply:true,files:files.filter(file=>file.version<='0124')})).rejects.toThrow();
  expect(await snapshot()).toEqual(rows);expect(await registry()).toEqual(registered);
  expect((await fixture.source.query("SELECT column_name FROM information_schema.columns WHERE table_name='ceph_analyses' AND column_name IN ('correction_source_canonical','correction_source_sha256')")).rows).toEqual([]);
});
it('serializes runtime and CLI callers and rejects changed source even on replay', async () => {
  await base();await fixture.source.query(legacy);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname='/'+(await fixture.source.query('SELECT current_database() AS name')).rows[0].name;
  const other = new Pool({connectionString:url.toString(),max:1});
  try {
    const result=await Promise.all([applyRuntimeMigrationFiles(fixture.source,[lineage]),migrate(other,{apply:true,files:files.filter(file=>file.version<='0124')})]);
    expect([...result[0],...result[1].appliedVersions]).toEqual(['0124']);
  } finally {await other.end();}
  const changed={...lineage,sql:lineage.sql+'\n'};changed.checksum=checksumOf(changed.sql);
  await expect(applyRuntimeMigrationFiles(fixture.source,[changed])).rejects.toThrow('CEPH_LINEAGE_SOURCE_MISMATCH');
  await expect(migrate(fixture.source,{apply:true,files:files.map(file=>file.version==='0124'?changed:file)})).rejects.toThrow('CEPH_LINEAGE_SOURCE_MISMATCH');
});

it('restore provenance retains the original 0124 identity and rejects tampering',async () => {
  await base();await fixture.source.query(legacy);await applyRuntimeMigrationFiles(fixture.source,[lineage]);
  const migrationFiles=await loadRestoreMigrationChecksums();
  const record=`BEGIN; INSERT INTO schema_migrations (version,name,checksum) VALUES ('0124','ceph_correction_lineage','${lineage.checksum}'); COMMIT;`;
  const prepared=prepareBackupSql(record,{migrationFiles});
  expect(prepared.skippedMigrationRecordLines).toBe(1);
  const registered=await registry();await fixture.source.query(prepared.sql);expect(await registry()).toEqual(registered);
  expect(()=>prepareBackupSql(record.replace(lineage.checksum,'0'.repeat(64)),{migrationFiles})).toThrow('Archived migration checksum mismatch: 0124');
});
it.each(['checksum','name','adopted'])('rejects incompatible registered 0124 %s on both replay paths',async kind => {
  await base();await applyRuntimeMigrationFiles(fixture.source,[lineage]);
  if(kind==='checksum')await fixture.source.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0124'",['0'.repeat(64)]);
  if(kind==='name')await fixture.source.query("UPDATE schema_migrations SET name='wrong_contract' WHERE version='0124'");
  if(kind==='adopted')await fixture.source.query("UPDATE schema_migrations SET adopted=true WHERE version='0124'");
  const before=await registry();
  await expect(applyRuntimeMigrationFiles(fixture.source,[lineage])).rejects.toThrow('CEPH_LINEAGE_REGISTRY_MISMATCH');
  await expect(migrate(fixture.source,{apply:true,files})).rejects.toThrow('CEPH_LINEAGE_REGISTRY_MISMATCH');
  expect(await registry()).toEqual(before);
});
