import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { CEPH_COMPLETION_SOURCE_CAS_SQL } from '../../lib/ceph-completion-source-cas-schema';
import { openPeriodontalFixture } from './_periodontal-fixture';

let f: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let actorId: number;
let legacyId: string;
let legacySnapshot: unknown;
let existingTriggers: unknown;
const snapshot = async (id: string) => (await f.pool.query('SELECT to_jsonb(p)::text value FROM ceph_completion_provenance p WHERE analysis_id=$1',[id])).rows;
const triggers = async () => (await f.pool.query(`SELECT tgname,pg_get_triggerdef(oid) definition FROM pg_trigger
  WHERE tgrelid IN ('ceph_completion_provenance'::regclass,'ceph_analyses'::regclass) ORDER BY tgname`)).rows;
async function analysis(status='completed') {
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic source CAS') RETURNING id",[randomUUID()])).rows[0].id;
  const documentId = (await f.pool.query("INSERT INTO patient_documents(patient_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'Synthetic image','image/png',1,$2,$3,'synthetic') RETURNING id",[patientId,'a'.repeat(64),randomUUID()])).rows[0].id;
  return (await f.pool.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,completed_by,completed_at) VALUES($1,$2,$3,'synthetic','synthetic',now()) RETURNING id",[patientId,documentId,status])).rows[0].id as string;
}
async function seal(id:string, version:number, signer='synthetic') {
  // Envelope tests intentionally do not claim full clinical decoder validity.
  const witness=JSON.stringify({schemaVersion:version,synthetic:'retention-envelope'});
  return f.pool.query(`INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at)
    SELECT id,$2,$3,$4,$5,$6,completed_at FROM ceph_analyses WHERE id=$1`,
    [id,version,witness,createHash('sha256').update(witness).digest('hex'),actorId,signer]);
}
beforeAll(async () => {
  f=await openPeriodontalFixture(process.env,{pristine:true});
  const files=await loadMigrationFiles();
  await migrate(f.pool,{apply:true,files:files.filter(file=>file.version<'0114')});
  actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic signer','synthetic-only','admin') RETURNING id",[randomUUID()])).rows[0].id;
  legacyId=await analysis(); await seal(legacyId,1);
  legacySnapshot=await snapshot(legacyId); existingTriggers=await triggers();
  await expect(seal(await analysis(),2)).rejects.toMatchObject({code:'23514'});
  await migrate(f.pool,{apply:true,files});
});
afterAll(async()=>{await f?.close();});
it('upgrades only the envelope, preserving existing v1 evidence and every retention trigger',async()=>{
  expect(await snapshot(legacyId)).toEqual(legacySnapshot);
  expect(await triggers()).toEqual(existingTriggers);
  expect((await f.pool.query("SELECT checksum FROM schema_migrations WHERE version='0114'")).rows[0].checksum)
    .toBe(createHash('sha256').update(CEPH_COMPLETION_SOURCE_CAS_SQL).digest('hex'));
});
it('accepts both versions with matching completed metadata and rejects unknown versions',async()=>{
  for(const version of [1,2]) { const id=await analysis(); await seal(id,version); expect((await f.pool.query('SELECT schema_version FROM ceph_completion_provenance WHERE analysis_id=$1',[id])).rows[0].schema_version).toBe(version); }
  for(const version of [0,3]) await expect(seal(await analysis(),version)).rejects.toMatchObject({code:'23514'});
});
it('retains immutable witness, signature, user and analysis for both envelope versions',async()=>{
  for(const version of [1,2]) {
    const id=await analysis(); await seal(id,version); const before=await snapshot(id);
    await expect(f.pool.query('UPDATE ceph_completion_provenance SET schema_version=$2 WHERE analysis_id=$1',[id,version===1?2:1])).rejects.toThrow(/immutable/);
    await expect(f.pool.query('DELETE FROM ceph_completion_provenance WHERE analysis_id=$1',[id])).rejects.toThrow(/immutable/);
    await expect(f.pool.query("UPDATE ceph_analyses SET completed_by='changed' WHERE id=$1",[id])).rejects.toThrow(/immutable/);
    await expect(f.pool.query('DELETE FROM ceph_analyses WHERE id=$1',[id])).rejects.toThrow(/foreign key/);
    expect(await snapshot(id)).toEqual(before);
  }
  await expect(f.pool.query('TRUNCATE ceph_completion_provenance')).rejects.toThrow(/immutable/);
  await expect(f.pool.query('DELETE FROM users WHERE id=$1',[actorId])).rejects.toThrow(/foreign key/);
});
it('keeps deferred completed-signature checks for v2',async()=>{
  await expect(seal(await analysis('draft'),2)).rejects.toThrow(/must match completed signature/);
  await expect(seal(await analysis(),2,'different')).rejects.toThrow(/must match completed signature/);
});
