/** Synthetic-only witnesses. Every source and target is newly created, checked
 * by database OID/owner, and retained with its files for later inspection.
 * Never connect to or reset the configured test database itself. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Client, Pool } from 'pg';
import { expect, it } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { validateGeneratedDatabaseName } from '../../scripts/verify-schema-ownership';
import { validateLocalVerificationTarget } from '../../lib/verification-target-policy.mjs';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { patientNumberSequenceRestoreSql } from '../../lib/patient-numbering-backup';
import { backupStateDir } from '../../lib/backupVolume';
import { upsertBackupHistoryRecord } from '../../lib/backupHistory';
import { runAdminRestoreDrill } from '../../lib/restore/admin';
import { parseTarBytes } from '../../lib/restore/archive';
import { validateBackupArchive } from '../../lib/restore/validate';
import { prepareBackupSql } from '../../lib/restore/sql.mjs';
import { tarGzBytes } from '../helpers/backup-tar';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const old0090 = '608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25';
const backupId = 'production-backup-20261117-010203-001-abcdef12-abcdef12.tar.gz';

async function ownedPair() {
  // Validate the original environment before rewriting any URL or opening PG.
  const checked = validatePostgresTestTarget(process.env);
  const admin = new Client({ connectionString: checked.maintenanceUrl.toString(), ssl: false });
  const pools: Pool[] = [];
  await admin.connect();
  try {
    const create = async (role: 'source' | 'target') => {
      const name = `aqlan_schema_ownership_${role}_${randomUUID().replaceAll('-', '')}`;
      validateGeneratedDatabaseName(name);
      if (name.length > 63) throw new Error('Synthetic database name too long');
      const url = new URL(checked.testUrl); url.pathname = `/${name}`;
      validateLocalVerificationTarget(url.toString(), process.env, { varName: 'OWNED_SYNTHETIC_RESTORE', databaseName: name });
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rows).toEqual([]);
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const identity = (await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [name])).rows[0];
      if (!identity) throw new Error('Synthetic database identity missing');
      const pool = new Pool({ connectionString: url.toString(), ssl: false, max: 1 }); pools.push(pool);
      expect((await pool.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows[0]).toEqual(identity);
      return { name, url, pool, identity };
    };
    const source = await create('source'), target = await create('target');
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-provenance-numbering-'));
    await writeFile(path.join(directory, 'identity.json'), JSON.stringify({
      source: { name: source.name, ...source.identity }, target: { name: target.name, ...target.identity },
    }) + '\n');
    return { admin, source, target, directory, async close() { for (const pool of pools) await pool.end(); await admin.end(); } };
  } catch (error) {
    for (const pool of pools) await pool.end().catch(() => {});
    await admin.end().catch(() => {});
    throw error; // Any database already created remains retained.
  }
}

it.each([false, true])('rejects a synthetic unknown 0090 archive with booking rows=%s before touching its owned target', async populated => {
  const fixture = await ownedPair();
  try {
    for (const db of [fixture.source.pool, fixture.target.pool]) {
      await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,name text,checksum text,applied_at timestamptz,adopted boolean)');
      await db.query("INSERT INTO schema_migrations VALUES ('0090','synthetic_booking',$1,'2026-01-01T00:00:00Z',FALSE)", [old0090]);
      await db.query('CREATE TABLE booking_requests(id int PRIMARY KEY,request_key text)');
      await db.query('CREATE SEQUENCE patient_number_seq');
      await db.query("SELECT setval('patient_number_seq',15000,true)");
    }
    await fixture.target.pool.query("INSERT INTO booking_requests VALUES (1,'SYNTHETIC TARGET')");
    if (populated) await fixture.source.pool.query("INSERT INTO booking_requests VALUES (2,'SYNTHETIC SOURCE')");
    const snapshot = async (pool: Pool) => ({
      ledger: (await pool.query('SELECT version,name,checksum,applied_at,adopted FROM schema_migrations ORDER BY version')).rows,
      bookings: (await pool.query('SELECT id,request_key FROM booking_requests ORDER BY id')).rows,
      sequence: (await pool.query('SELECT last_value::text,is_called FROM patient_number_seq')).rows,
    });
    const sourceBefore = await snapshot(fixture.source.pool), targetBefore = await snapshot(fixture.target.pool);
    const sourceFile = path.join(fixture.directory, 'synthetic-source-document.txt');
    const sourceBytes = Buffer.from('SYNTHETIC SOURCE DOCUMENT'); await writeFile(sourceFile, sourceBytes);
    const backups = path.join(fixture.directory, 'backups'), stage = path.join(backupStateDir(backups), 'restore-drill-current');
    await mkdir(stage, { recursive: true });
    const priorBytes = Buffer.from('SYNTHETIC TARGET STAGE'); await writeFile(path.join(stage, 'prior.txt'), priorBytes);
    const ledger = `INSERT INTO schema_migrations ("version", "name", "checksum", "applied_at", "adopted") VALUES ('0090', 'synthetic_booking', '${old0090}', '2026-01-01T00:00:00Z', FALSE);`;
    const booking = populated ? "INSERT INTO booking_requests (\"id\", \"request_key\") VALUES (2, 'SYNTHETIC SOURCE');\n" : '';
    const sql = Buffer.from(`BEGIN;\n${ledger}\n${booking}COMMIT;\n`);
    const manifest = { format:'aqlan-full-backup', version:1, createdAt:'2026-01-01T00:00:00.000Z', databaseSha256:digest(sql), documents:[] };
    const archive = tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
    expect(validateBackupArchive(parseTarBytes(gunzipSync(archive)),{documentsDir:stage}).ok).toBe(true);
    const catalog = await loadMigrationFiles();
    expect(() => prepareBackupSql(sql.toString('utf8'), {inspectHistorical0079:true,migrationFiles:catalog})).toThrow('Unknown archived migration version: 0090');
    await writeFile(path.join(backups, backupId), archive);
    await upsertBackupHistoryRecord(backups,{backupId,createdAt:'2026-01-01T00:00:00.000Z',triggerType:'manual',archiveSha256:digest(archive),archiveBytes:archive.length,databaseSha256:digest(sql),documentCount:0,status:'verified',replicationStatus:'none',destinations:[]});
    const result = await runAdminRestoreDrill({backupDir:backups,backupId,actor:'synthetic',env:{DATABASE_URL:fixture.source.url.toString(),RESTORE_DRILL_DATABASE_URL:fixture.target.url.toString(),RESTORE_DRILL_DATABASE_ENVIRONMENT:'test',RESTORE_DRILL_DEDICATED_TARGET:'true'}});
    expect(result).toEqual({ok:false,reason:'archive-integrity-mismatch'});
    for (const db of [fixture.source, fixture.target])
      expect((await fixture.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[db.name])).rows).toEqual([db.identity]);
    expect(await snapshot(fixture.source.pool)).toEqual(sourceBefore);
    expect(await snapshot(fixture.target.pool)).toEqual(targetBefore);
    expect(await readFile(sourceFile)).toEqual(sourceBytes);
    expect(await readFile(path.join(stage,'prior.txt'))).toEqual(priorBytes);
    expect(await readFile(path.join(backups,backupId))).toEqual(archive);
  } finally { await fixture.close(); }
}, 180_000);

it('preserves source and synthetic documents while checking the 12-case allocator replay matrix', async () => {
  const fixture = await ownedPair();
  try {
    const catalog = await loadMigrationFiles();
    const sourceMigrated = await migrate(fixture.source.pool,{apply:true,files:catalog});
    const migrated = await migrate(fixture.target.pool,{apply:true,files:catalog});
    for (const result of [sourceMigrated,migrated]) {
      expect(result.appliedVersions).toContain('0080'); expect(result.appliedVersions).not.toContain('0079');
    }
    await fixture.source.pool.query('CREATE TABLE synthetic_source_witness(value text NOT NULL)');
    await fixture.source.pool.query("INSERT INTO synthetic_source_witness VALUES ('SYNTHETIC SOURCE')");
    const sourcePatient = (await fixture.source.pool.query("INSERT INTO patients(patient_number,full_name) VALUES ('P-27001','SYNTHETIC SOURCE') RETURNING id")).rows[0].id;
    const targetPatient = (await fixture.target.pool.query("INSERT INTO patients(patient_number,full_name) VALUES ('P-07001','SYNTHETIC TARGET') RETURNING id")).rows[0].id;
    await fixture.source.pool.query("SELECT setval('patient_number_seq',31000,true)");
    const sourceBefore = (await fixture.source.pool.query('SELECT value FROM synthetic_source_witness')).rows;
    const sourceSequence = (await fixture.source.pool.query('SELECT last_value::text,is_called FROM patient_number_seq')).rows;
    const sourceDir=path.join(fixture.directory,'source-documents'), targetDir=path.join(fixture.directory,'target-documents');
    await mkdir(sourceDir); await mkdir(targetDir);
    const sourceDoc = path.join(sourceDir,'synthetic-document.txt'), targetDoc = path.join(targetDir,'synthetic-document.txt');
    const sourceBytes = Buffer.from('SYNTHETIC SOURCE DOCUMENT'), targetBytes = Buffer.from('SYNTHETIC TARGET DOCUMENT');
    await writeFile(sourceDoc,sourceBytes); await writeFile(targetDoc,targetBytes);
    for (const [pool,patient,bytes] of [[fixture.source.pool,sourcePatient,sourceBytes],[fixture.target.pool,targetPatient,targetBytes]] as const)
      await pool.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,'xray','synthetic','image/png',$2,$3,'synthetic-document.txt','synthetic')",[patient,bytes.length,digest(bytes)]);
    const targetRows = (await fixture.target.pool.query('SELECT patient_number,full_name FROM patients ORDER BY patient_number')).rows;
    const sourceRows = (await fixture.source.pool.query('SELECT patient_number,full_name FROM patients ORDER BY patient_number')).rows;
    const documents = async (pool: Pool) => (await pool.query('SELECT patient_id::text,storage_key,sha256,size_bytes::int AS size_bytes FROM patient_documents ORDER BY id')).rows;
    const sourceDocuments = await documents(fixture.source.pool), targetDocuments = await documents(fixture.target.pool);
    expect(sourceDocuments).toEqual([{patient_id:String(sourcePatient),storage_key:'synthetic-document.txt',sha256:digest(sourceBytes),size_bytes:sourceBytes.length}]);
    expect(targetDocuments).toEqual([{patient_id:String(targetPatient),storage_key:'synthetic-document.txt',sha256:digest(targetBytes),size_bytes:targetBytes.length}]);
    for (const current of [9000,10000,11000]) for (const currentCalled of [false,true]) for (const backupCalled of [false,true]) {
      await fixture.target.pool.query("SELECT setval('patient_number_seq',$1::bigint,$2)",[String(current),currentCalled]);
      const replay=patientNumberSequenceRestoreSql('10000',backupCalled);
      const expectedValue=Math.max(current,10000);
      const expectedCalled=current>10000 || (current===10000 && currentCalled) || backupCalled;
      for (let pass=0;pass<2;pass++) {
        await fixture.target.pool.query(replay);
        expect((await fixture.target.pool.query('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0]).toEqual({last_value:String(expectedValue),is_called:expectedCalled});
      }
      expect((await fixture.target.pool.query('SELECT aqlan_allocate_patient_number() AS number')).rows[0].number).toBe(`P-${expectedValue+(expectedCalled?1:0)}`);
    }
    expect((await fixture.target.pool.query('SELECT patient_number,full_name FROM patients ORDER BY patient_number')).rows).toEqual(targetRows);
    expect((await fixture.source.pool.query('SELECT patient_number,full_name FROM patients ORDER BY patient_number')).rows).toEqual(sourceRows);
    expect(await documents(fixture.source.pool)).toEqual(sourceDocuments); expect(await documents(fixture.target.pool)).toEqual(targetDocuments);
    expect((await fixture.source.pool.query('SELECT value FROM synthetic_source_witness')).rows).toEqual(sourceBefore);
    expect((await fixture.source.pool.query('SELECT last_value::text,is_called FROM patient_number_seq')).rows).toEqual(sourceSequence);
    for (const db of [fixture.source,fixture.target])
      expect((await fixture.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[db.name])).rows).toEqual([db.identity]);
    expect(await readFile(sourceDoc)).toEqual(sourceBytes); expect(await readFile(targetDoc)).toEqual(targetBytes);
  } finally { await fixture.close(); }
}, 180_000);
