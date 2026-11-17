/** Synthetic only: creates uniquely named local databases and retains them and
 * their files. Never connects to, resets, or cleans the configured test DB. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { Client, Pool } from 'pg';
import { expect, it } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { validateGeneratedDatabaseName, assertPostgres18VersionNum } from '../../scripts/verify-schema-ownership';
import { validateLocalVerificationTarget, validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { patientNumberSequenceRestoreSql } from '../../lib/patient-numbering-backup';
import { storageKeyOf, sha256Of } from '../helpers/backup-blocks';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
import { validateStandaloneWitnessEnvironment } from './_standalone-restore-witness-guard';

async function ownedPair() {
  // This witness belongs only to the dedicated, disposable CI service. Check
  // all aliases even if someone invokes the file with another Vitest config.
  validateStandaloneWitnessEnvironment(process.env);
  validateOperationalVerificationEnvironment(process.env);
  const checked = validatePostgresTestTarget(process.env);
  const admin = new Client({ connectionString: checked.maintenanceUrl.toString(), ssl: false });
  const pools: Pool[] = [];
  await admin.connect();
  try {
    assertPostgres18VersionNum((await admin.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
    const create = async (role: 'source' | 'target') => {
      const name = `aqlan_schema_ownership_${role}_${randomUUID().replaceAll('-', '')}`;
      validateGeneratedDatabaseName(name);
      if (name.length > 63) throw new Error('Synthetic database name too long');
      const url = new URL(checked.testUrl); url.pathname = `/${name}`;
      validateLocalVerificationTarget(url.toString(), process.env, { varName:'OWNED_SYNTHETIC_RESTORE', databaseName:name });
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const identity = (await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [name])).rows[0];
      if (!identity) throw new Error('Synthetic database identity missing');
      const pool = new Pool({ connectionString:url.toString(), ssl:false, max:1 }); pools.push(pool);
      expect((await pool.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows[0]).toEqual(identity);
      return {name,url,pool,identity};
    };
    const source = await create('source'), target = await create('target');
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-allocator-archive-'));
    await writeFile(path.join(directory,'identity.json'), JSON.stringify({source:{name:source.name,...source.identity},target:{name:target.name,...target.identity}})+'\n');
    return { admin,source,target,directory,async close(){ for(const pool of pools) await pool.end(); await admin.end(); } };
  } catch (error) {
    for (const pool of pools) await pool.end().catch(()=>{});
    await admin.end().catch(()=>{});
    throw error; // Keep any already-created DB as evidence.
  }
}

const tables = ['patients','patient_documents','invoices','retired_patient_numbers','patient_numbering_policy','audit_log'];
async function snapshot(pool: Pool) {
  const data: Record<string,unknown> = {};
  for (const table of tables) data[table] = (await pool.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS data FROM ${table} t`)).rows[0].data;
  return data;
}
async function sequence(pool: Pool) {
  return (await pool.query('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0];
}

async function checkMatrix(pool: Pool) {
  // Fixed cases are an independent oracle; do not repeat the restore formula.
  const cases = [
    [9000, false, false, '10000', false, 'P-10000'],
    [9000, false, true,  '10000', true,  'P-10001'],
    [9000, true,  false, '10000', false, 'P-10000'],
    [9000, true,  true,  '10000', true,  'P-10001'],
    [10000,false, false, '10000', false, 'P-10000'],
    [10000,false, true,  '10000', true,  'P-10001'],
    [10000,true,  false, '10000', true,  'P-10001'],
    [10000,true,  true,  '10000', true,  'P-10001'],
    [11000,false, false, '11000', true,  'P-11001'],
    [11000,false, true,  '11000', true,  'P-11001'],
    [11000,true,  false, '11000', true,  'P-11001'],
    [11000,true,  true,  '11000', true,  'P-11001'],
  ] as const;
  for (const [current,currentCalled,backupCalled,value,called,next] of cases) {
    await pool.query("SELECT setval('patient_number_seq',$1::bigint,$2)",[String(current),currentCalled]);
    const sql = patientNumberSequenceRestoreSql('10000',backupCalled);
    for (let pass=0;pass<2;pass++) {
      await pool.query(sql);
      expect(await sequence(pool)).toEqual({last_value:String(value),is_called:called});
    }
    expect((await pool.query('SELECT aqlan_allocate_patient_number() AS number')).rows[0].number).toBe(next);
  }
}

it('restores an actual synthetic full archive and its patient-document links and bytes; refuses full replay to its nonempty target', async () => {
  const fixture = await ownedPair();
  try {
    const files = await loadMigrationFiles();
    await migrate(fixture.source.pool,{apply:true,files});
    const patient = (await fixture.source.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('P-00123','SYNTHETIC RESTORE') RETURNING id")).rows[0];
    await fixture.source.pool.query("INSERT INTO retired_patient_numbers(patient_number,patient_id) VALUES('P-07000',$1)",[patient.id]);
    await fixture.source.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor) VALUES('SYNTHETIC-RESTORE',$1,100)",[patient.id]);
    const text = 'SYNTHETIC DOCUMENT CONTENT';
    const bytes = Buffer.from(text), key = storageKeyOf(text), sourceFile = path.join(fixture.directory,'source-document');
    await writeFile(sourceFile,bytes);
    await fixture.source.pool.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'other','SYNTHETIC','image/png',$2,$3,$4,'synthetic')",[patient.id,bytes.length,sha256Of(bytes),key]);
    const policy = await fixture.source.pool.query('INSERT INTO patient_numbering_policy(singleton,minimum_next,version) VALUES(true,8000,1)');
    expect(policy.rowCount).toBe(1);
    await fixture.source.pool.query("SELECT setval('patient_number_seq',9000,true)");
    const sourceBefore = await snapshot(fixture.source.pool), sourceSequence = await sequence(fixture.source.pool);
    expect(sourceSequence).toEqual({last_value:'9000',is_called:true});
    const source = await fixture.source.pool.connect();
    const blocks: Buffer[] = [];
    try {
      for await (const block of fullBackupBlocks({source,readDocument:async requested => {
        if (requested !== key) throw new Error('Unexpected synthetic document key');
        return readFile(sourceFile);
      }})) blocks.push(Buffer.from(block));
    } finally { source.release(); }
    const archivePath = path.join(fixture.directory,'synthetic.tar.gz');
    const archive = gzipSync(Buffer.concat(blocks)); await writeFile(archivePath,archive);
    const stage = path.join(fixture.directory,'restored-documents');
    expect((await fixture.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[fixture.target.name])).rows).toEqual([fixture.target.identity]);
    const restored = await stagedRestore({archivePath,targetUrl:fixture.target.url.toString(),stagingDir:stage});
    expect(restored).toMatchObject({ok:true,errors:[],validationErrors:[],readyForCutover:true,documentsRestored:1,documentsVerified:1});
    expect(restored.migrationsApplied).toContain('0080');
    expect(await snapshot(fixture.target.pool)).toEqual(sourceBefore);
    expect(await sequence(fixture.target.pool)).toEqual(sourceSequence);
    expect((await fixture.target.pool.query('SELECT aqlan_patient_number_next()::text AS next')).rows[0].next).toBe('9001');
    const link = (await fixture.target.pool.query('SELECT d.patient_id,p.patient_number,d.storage_key,d.sha256 FROM patient_documents d JOIN patients p ON p.id=d.patient_id')).rows;
    expect(link).toEqual([{patient_id:patient.id,patient_number:'P-00123',storage_key:key,sha256:sha256Of(bytes)}]);
    expect(await readFile(path.join(stage,key))).toEqual(bytes);
    const beforeReplay = await snapshot(fixture.target.pool), sequenceBeforeReplay = await sequence(fixture.target.pool);
    const replay = await stagedRestore({archivePath,targetUrl:fixture.target.url.toString(),stagingDir:stage});
    expect(replay.ok).toBe(false);
    expect(replay.errors.some(message => /الهدف (?:ليس فارغًا|يحمل هوية موحّدة)/.test(message))).toBe(true);
    expect(await snapshot(fixture.target.pool)).toEqual(beforeReplay);
    expect(await sequence(fixture.target.pool)).toEqual(sequenceBeforeReplay);
    expect(await readFile(path.join(stage,key))).toEqual(bytes);
    // Keep the restored target's original sequence and rows as evidence.
    expect(await snapshot(fixture.source.pool)).toEqual(sourceBefore);
    expect(await sequence(fixture.source.pool)).toEqual(sourceSequence);
    expect(await readFile(sourceFile)).toEqual(bytes);
    expect(await readFile(archivePath)).toEqual(archive);
  } finally { await fixture.close(); }
},180_000);

it('checks the 12 historical high-water SQL replay cases on a separately owned target', async () => {
  const fixture = await ownedPair();
  try {
    await migrate(fixture.target.pool,{apply:true,files:await loadMigrationFiles()});
    await fixture.target.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('P-00123','SYNTHETIC MATRIX')");
    const rows = await snapshot(fixture.target.pool);
    await checkMatrix(fixture.target.pool);
    expect(await snapshot(fixture.target.pool)).toEqual(rows);
    // Retired aliases and policy can exceed both the restored and target sequence.
    await fixture.target.pool.query("INSERT INTO patient_numbering_policy(singleton,minimum_next,version) VALUES(true,12000,1)");
    await fixture.target.pool.query("INSERT INTO retired_patient_numbers(patient_number,patient_id) SELECT 'P-13000',id FROM patients WHERE patient_number='P-00123'");
    await fixture.target.pool.query("SELECT setval('patient_number_seq',10000,true)");
    await fixture.target.pool.query(patientNumberSequenceRestoreSql('10000',false));
    await fixture.target.pool.query(patientNumberSequenceRestoreSql('10000',false));
    const allocated = (await fixture.target.pool.query('SELECT aqlan_allocate_patient_number() AS number')).rows[0].number;
    expect(allocated).toBe('P-13001');
    await fixture.target.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYNTHETIC ALLOCATED')",[allocated]);
    expect((await fixture.target.pool.query("SELECT count(*)::int AS count FROM patients WHERE patient_number='P-13001'")).rows[0].count).toBe(1);
    for (const db of [fixture.source,fixture.target]) expect((await fixture.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[db.name])).rows).toEqual([db.identity]);
  } finally { await fixture.close(); }
},180_000);
