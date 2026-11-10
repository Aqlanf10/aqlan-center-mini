import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { MEASUREMENTS } from '../../lib/ceph';
import { parseCephCompletionSnapshot } from '../../lib/ceph-completion-snapshot';
import { ProtectedCephProvenanceHistoryError } from '../../lib/clinic-reset';
import { stagedRestore } from '../../lib/restore/staging';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openPeriodontalFixture } from './_periodontal-fixture';
import { CEPH_COMPLETION_PROVENANCE_SQL } from '../../lib/ceph-completion-provenance-schema';
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let actorId: number;
const actorName = `synthetic-ceph-archive-${randomUUID()}`;
let validAnalysisId: number;
beforeAll(async () => {
  f = await openPeriodontalFixture(process.env, { pristine: true });
  await f.db.ensureSchema();
  actorId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic signer','synthetic-not-a-secret','admin') RETURNING id", [actorName])).rows[0].id;
  vi.stubEnv("SESSION_SECRET", "synthetic-only-ceph-archive-session-secret");
});
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function analysis(status = 'completed') {
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic ceph patient') RETURNING id", [randomUUID()])).rows[0].id;
  const documentId = (await f.pool.query("INSERT INTO patient_documents(patient_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'Synthetic ceph','image/png',9,$2,$3,'synthetic') RETURNING id", [patientId, createHash('sha256').update('synthetic').digest('hex'), randomUUID()])).rows[0].id;
  const row = (await f.pool.query("INSERT INTO ceph_analyses(patient_id,document_id,created_by,status,completed_by,completed_at) VALUES($1,$2,'synthetic',$3,'synthetic',now()) RETURNING id", [patientId, documentId, status])).rows[0];
  return { id: row.id, patientId };
}
async function seal(id: string) {
  return f.pool.query(`INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at)
    SELECT id,1,'{}',$2,$3,completed_by,completed_at FROM ceph_analyses WHERE id=$1`, [id, 'a'.repeat(64), actorId]);
}
it('registers exact migration checksum', async () => {
  expect((await f.pool.query("SELECT checksum FROM schema_migrations WHERE version='0113'")).rows[0].checksum).toBe(createHash('sha256').update(CEPH_COMPLETION_PROVENANCE_SQL).digest('hex'));
});
it('allows empty fresh reset and rejects mismatched signature metadata', async () => {
  await f.pool.query('TRUNCATE ceph_completion_provenance');
  const a = await analysis();
  await expect(f.pool.query(`INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at)
    SELECT id,1,'{}',$2,$3,'different signer',completed_at FROM ceph_analyses WHERE id=$1`, [a.id, 'a'.repeat(64), actorId])).rejects.toThrow(/must match completed signature/);
});
it('leaves historical completed records unversioned and rejects draft witnesses', async () => {
  const old = await analysis();
  expect((await f.pool.query('SELECT * FROM ceph_completion_provenance WHERE analysis_id=$1', [old.id])).rows).toEqual([]);
  const draft = await analysis('draft');
  await expect(seal(draft.id)).rejects.toThrow(/must match completed signature/);
});
it('protects evidence, actor identity and parent columns but permits legal patient moves', async () => {
  const a = await analysis(); await seal(a.id);
  for (const sql of ["UPDATE ceph_completion_provenance SET witness='{}' WHERE analysis_id=$1", 'DELETE FROM ceph_completion_provenance WHERE analysis_id=$1', "UPDATE ceph_analyses SET note='changed' WHERE id=$1", "UPDATE ceph_analyses SET status='draft' WHERE id=$1"])
    await expect(f.pool.query(sql, [a.id])).rejects.toThrow(/immutable/);
  await expect(f.pool.query('TRUNCATE ceph_completion_provenance')).rejects.toThrow(/immutable/);
  await expect(f.pool.query('DELETE FROM ceph_analyses WHERE id=$1', [a.id])).rejects.toThrow(/foreign key/);
  await expect(f.pool.query('DELETE FROM users WHERE id=$1', [actorId])).rejects.toThrow(/foreign key/);
  const target = await analysis();
  await f.pool.query('UPDATE ceph_analyses SET patient_id=$2 WHERE id=$1', [a.id, target.patientId]);
  expect((await f.pool.query('SELECT witness FROM ceph_completion_provenance WHERE analysis_id=$1', [a.id])).rows[0].witness).toEqual({});
});
it('defers completion checking to commit for atomic insert then signature', async () => {
  const a = await analysis('draft'); const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE ceph_analyses SET status='completed' WHERE id=$1", [a.id]);
    await client.query(`INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at)
      SELECT id,1,'{}',$2,$3,completed_by,completed_at FROM ceph_analyses WHERE id=$1`, [a.id, 'a'.repeat(64), actorId]);
    await client.query('COMMIT');
  } finally { await client.query('ROLLBACK'); client.release(); }
});

async function completeValidStudy(): Promise<number> {
  const a = await analysis('draft'), id = Number(a.id), refKey = `synthetic-${randomUUID()}`;
  const refId = (await f.pool.query("INSERT INTO ceph_reference_sets(key,name,population,version,created_by) VALUES($1,'Synthetic reference','Synthetic population','synthetic-v1',$2) RETURNING id", [refKey, actorName])).rows[0].id;
  for (const def of MEASUREMENTS) if (def.mean != null && def.tol != null && def.tol > 0)
    await f.pool.query('INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,$2,$3,$4)', [refId, def.code, def.mean, def.tol]);
  await f.pool.query('UPDATE ceph_analyses SET ref_set=$2,cal_x1=0,cal_y1=0,cal_x2=100,cal_y2=0,cal_mm=100,mm_per_pixel=1,completed_by=NULL,completed_at=NULL WHERE id=$1', [id, refKey]);
  await f.pool.query('UPDATE patient_documents SET width=500,height=500 WHERE id=(SELECT document_id FROM ceph_analyses WHERE id=$1)', [id]);
  const points = {
    S: [100,100], N: [169,92], A: [167.57,151.98], B: [163.84,179.85],
    Pog: [164.03,186.87], Me: [160,205], Go: [82.97,169.08], Or: [160,125], Po: [100,125],
    U1A: [160,134], U1: [174.08,171.44], L1A: [149,199.2], L1: [168,164],
    OcclA: [170,148], OcclP: [100,135.3], Gn: [161.5,195.5],
  };
  for (const [code, [x,y]] of Object.entries(points)) await f.pool.query(
    "INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,'manual',$5)", [id, code, x, y, actorName]);
  await f.pool.query("INSERT INTO ceph_diagnoses(analysis_id,skeletal,final_dx,created_by) VALUES($1,'Synthetic skeletal','Synthetic signed diagnosis',$2)", [id, actorName]);
  const study = await f.db.getCephStudy(id);
  if (!study) throw new Error('Synthetic archive study missing');
  if (study.completionSources.state !== 'available') throw new Error('Synthetic archive sources unavailable');
  const snapshot = parseCephCompletionSnapshot({ patientId: study.analysis.patientId, documentId: study.analysis.documentId,
    refSet: study.analysis.refSet, calibration: study.analysis.calibration, mmPerPixel: study.analysis.mmPerPixel,
    landmarks: study.landmarks.map(({code,x,y,source}) => ({code,x,y,source})),
    diagnosis: { skeletal: study.diagnosis!.skeletal, dental: study.diagnosis!.dental, softTissue: study.diagnosis!.softTissue,
      note: study.diagnosis!.note, finalDx: study.diagnosis!.finalDx } });
  if (!snapshot) throw new Error('Invalid synthetic reviewed snapshot');
  const session: SessionPayload = { userId: actorId, username: actorName, role: 'admin', expiresAt: Date.now()+3_600_000,
    credentialVersion: sessionCredentialVersion('synthetic-not-a-secret') };
  expect(await f.db.completeCephAnalysis(id, actorName, snapshot, session, study.completionSources.identity)).toMatchObject({ok:true});
  expect((await f.db.getCephStudy(id))?.provenance.state).toBe('versioned');
  return id;
}

it('refuses reset before calling backup and leaves every table unchanged when witnessed history exists', async () => {
  validAnalysisId = await completeValidStudy();
  const tables = (await f.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows;
  const state = async () => {
    const rows = [];
    for (const {table_name: table} of tables) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected synthetic table identifier');
      rows.push({table, data:(await f.pool.query(`SELECT to_jsonb(t)::text value FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows});
    }
    return rows;
  };
  const before = await state();
  const backup = vi.fn(async () => ({ok:false as const, failure:'Backup must not run'}));
  await expect(f.db.resetClinicData({actor:actorName,actorRole:'admin'}, backup)).rejects.toBeInstanceOf(ProtectedCephProvenanceHistoryError);
  expect(backup).not.toHaveBeenCalled();
  expect(await state()).toEqual(before);
});

it('round-trips sealed evidence and legacy absence through full backup and fresh restore', async () => {
  const state = async () => ({
    provenance: (await f.pool.query('SELECT to_jsonb(p)::text snapshot FROM ceph_completion_provenance p ORDER BY analysis_id')).rows,
    analyses: (await f.pool.query('SELECT to_jsonb(a)::text snapshot FROM ceph_analyses a ORDER BY id')).rows,
  });
  const validStudy = await f.db.getCephStudy(validAnalysisId);
  expect(validStudy?.provenance.state).toBe('versioned');
  if (validStudy?.provenance.state === 'versioned') expect(validStudy.provenance.witness.schemaVersion).toBe(2);
  if(validStudy?.correctionSource.state!=='available')throw Error('Synthetic correction origin unavailable');
  const session:SessionPayload={userId:actorId,username:actorName,role:'admin',expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion('synthetic-not-a-secret')};
  const correction=await f.db.duplicateAuthorizedCephAnalysis(validAnalysisId,{patientId:validStudy.analysis.patientId,documentId:validStudy.analysis.documentId,session},validStudy.correctionSource.token);
  if(!correction.ok)throw Error('Synthetic correction creation failed');
  const correctionStudy=await f.db.getCephStudy(correction.id);
  expect(correctionStudy?.analysis.correctionOrigin).toMatchObject({parentAnalysisId:validAnalysisId,parentCompletion:{state:'versioned',witnessVersion:2}});
  const expected = await state();
  expect(expected.provenance.length).toBeGreaterThan(0);
  expect(expected.analyses.length).toBeGreaterThan(expected.provenance.length);
  const directory = await mkdtemp(path.join(tmpdir(), 'aqlan-ceph-provenance-restore-'));
  try {
    const archivePath = path.join(directory, 'synthetic-full.tar.gz'), source = await f.pool.connect();
    try {
      await pipeline(Readable.from(fullBackupBlocks({ source, readDocument: async () => Buffer.from('synthetic') })), createGzip(), createWriteStream(archivePath));
    } finally { source.release(); }
    await f.close();
    f = await openPeriodontalFixture(process.env, { pristine: true });
    const restored = await stagedRestore({ archivePath, targetUrl: f.url, stagingDir: path.join(directory, 'synthetic-documents') });
    expect(restored.errors).toEqual([]);
    expect(restored.ok).toBe(true);
    expect(restored.migrationsApplied).toContain('0113');
    expect(restored.migrationsApplied).toContain('0124');
    expect(await state()).toEqual(expected);
    const reopened = await f.db.getCephStudy(validAnalysisId);
    expect(reopened?.provenance.state).toBe("versioned");
    expect(reopened).toEqual(validStudy);
    expect(await f.db.getCephStudy(correction.id)).toEqual(correctionStudy);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
