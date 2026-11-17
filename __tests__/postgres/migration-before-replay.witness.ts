/** Readable synthetic witness of migration/replay ordering; CI-only, no DROP. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Client, Pool } from 'pg';
import { expect, it } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { validateGeneratedDatabaseName, assertPostgres18VersionNum } from '../../scripts/verify-schema-ownership';
import { validateLocalVerificationTarget, validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';
import { validateStandaloneWitnessEnvironment } from './_standalone-restore-witness-guard';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { stagedRestore } from '../../lib/restore/staging';
import { parseTarBytes } from '../../lib/restore/archive';
import { tarGzBytes } from '../helpers/backup-tar';

const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
async function ownedPair() {
  validateStandaloneWitnessEnvironment(process.env);
  validateOperationalVerificationEnvironment(process.env);
  const checked=validatePostgresTestTarget(process.env);
  const admin=new Client({connectionString:checked.maintenanceUrl.toString(),ssl:false});
  const pools:Pool[]=[];
  await admin.connect();
  try {
    assertPostgres18VersionNum((await admin.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
    async function create(kind:'source'|'target') {
      const name=`aqlan_schema_ownership_${kind}_${randomUUID().replaceAll('-','')}`;
      validateGeneratedDatabaseName(name);
      if(name.length>63) throw new Error('Synthetic database name too long');
      const url=new URL(checked.testUrl);url.pathname=`/${name}`;
      validateLocalVerificationTarget(url.toString(),process.env,{varName:'OWNED_SYNTHETIC_RESTORE',databaseName:name});
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount).toBe(0);
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const identity=(await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[name])).rows[0];
      if(!identity) throw new Error('Synthetic database identity missing');
      const pool=new Pool({connectionString:url.toString(),ssl:false,max:1});pools.push(pool);
      const actual=(await pool.query("SELECT oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS current_role FROM pg_database WHERE datname=current_database()")).rows[0];
      expect(actual?.oid===identity.oid && actual?.owner===identity.owner && actual?.current_role===identity.owner).toBe(true);
      return {name,url,pool,identity};
    }
    const source=await create('source'),target=await create('target');
    const directory=await mkdtemp(path.join(tmpdir(),'synthetic-migrations-before-replay-'));
    await writeFile(path.join(directory,'identity.json'),JSON.stringify({source:{name:source.name,...source.identity},target:{name:target.name,...target.identity}})+'\n');
    return {admin,source,target,directory,async close(){for(const pool of pools) await pool.end();await admin.end();}};
  } catch(error) {
    for(const pool of pools) await pool.end().catch(()=>{});
    await admin.end().catch(()=>{});
    throw error; // Keep any database already created.
  }
}

it('records whether target migrations remain committed after a late legacy replay failure',async()=>{
  const fixture=await ownedPair();
  try {
    const files=await loadMigrationFiles();
    const legacy=files.filter(file=>file.version<='0043');
    await migrate(fixture.source.pool,{apply:true,files:legacy});
    await migrate(fixture.target.pool,{apply:true,files:legacy});
    await fixture.source.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(75000,'SYNTHETIC-OLD','SYNTHETIC SOURCE')");
    await fixture.target.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(300,'SYNTHETIC-TARGET','SYNTHETIC TARGET')");
    const targetIdentity=(await fixture.target.pool.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows[0];
    expect(targetIdentity.oid===fixture.target.identity.oid && targetIdentity.owner===fixture.target.identity.owner).toBe(true);
    const sourceRows=(await fixture.source.pool.query('SELECT id::text,patient_number,full_name FROM patients ORDER BY id')).rows;
    const beforeRows=(await fixture.target.pool.query('SELECT id::text,patient_number,full_name FROM patients ORDER BY id')).rows;
    const beforeHistory=(await fixture.target.pool.query('SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations ORDER BY version')).rows;
    expect(beforeHistory.some(row=>row.version==='0043')).toBe(true);
    expect((await fixture.target.pool.query("SELECT to_regclass('public.patient_numbering_policy') IS NULL AS absent")).rows[0].absent).toBe(true);
    const client=await fixture.source.pool.connect(),blocks:Buffer[]=[];
    try {for await(const block of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No synthetic document expected');}})) blocks.push(Buffer.from(block));}
    finally {client.release();}
    const original=gzipSync(Buffer.concat(blocks)), parsed=parseTarBytes(gunzipSync(original));
    const manifest=JSON.parse(Buffer.from(parsed.entries.get('manifest.json')!.data).toString('utf8'));
    expect(Boolean(manifest.identityProvenance)).toBe(false);
    const sql=Buffer.from(parsed.entries.get('database.sql')!.data).toString('utf8');
    expect(/COMMIT;\s*$/.test(sql)).toBe(true);
    const duplicate='INSERT INTO patients ("id", "patient_number", "full_name") VALUES (75000, \'SYNTHETIC-DUPLICATE\', \'SYNTHETIC FAILURE\');\n';
    const faultySql=Buffer.from(sql.replace(/COMMIT;\s*$/,`${duplicate}COMMIT;\n`));
    manifest.databaseSha256=sha(faultySql);manifest.databaseBytes=faultySql.length;
    const altered=Buffer.from(tarGzBytes(parsed.order.map(name=>({name,data:name==='database.sql'?faultySql:name==='manifest.json'?Buffer.from(JSON.stringify(manifest)):parsed.entries.get(name)!.data}))));
    const originalPath=path.join(fixture.directory,'synthetic-original.tar.gz'),archivePath=path.join(fixture.directory,'synthetic-failure.tar.gz');
    await writeFile(originalPath,original);await writeFile(archivePath,altered);
    const stage=path.join(fixture.directory,'stage'),markerPath=path.join(stage,'synthetic-stage-marker'),marker=Buffer.from('synthetic-stage-retained');
    await mkdir(stage,{recursive:true});await writeFile(markerPath,marker);
    const result=await stagedRestore({archivePath,targetUrl:fixture.target.url.toString(),stagingDir:stage,allowNonEmptyTarget:true});
    // Recognize only the observed base branch contract. Other errors fail as
    // unclassified; nothing from a database message is printed.
    const duplicateError='فشل تطبيق بيانات الاستعادة على الهدف المعزول: duplicate key value violates unique constraint "patients_pkey"';
    const reached=!result.ok && !result.readyForCutover && result.validationErrors.length===0 && result.errors.length===1 && result.errors[0]===duplicateError;
    if(reached) console.log('SYNTHETIC_LATE_DUPLICATE_REACHED');
    expect(reached).toBe(true);
    const afterHistory=(await fixture.target.pool.query('SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations ORDER BY version')).rows;
    const oldVersions=new Set(beforeHistory.map(row=>row.version));
    expect(sha(Buffer.from(JSON.stringify(afterHistory.filter(row=>oldVersions.has(row.version)))))===sha(Buffer.from(JSON.stringify(beforeHistory)))).toBe(true);
    const has0080=afterHistory.some(row=>row.version==='0080');
    const policyExists=(await fixture.target.pool.query("SELECT to_regclass('public.patient_numbering_policy') IS NOT NULL AS present")).rows[0].present;
    const migrated=afterHistory.length>beforeHistory.length && has0080 && policyExists;
    const unchanged=sha(Buffer.from(JSON.stringify(afterHistory)))===sha(Buffer.from(JSON.stringify(beforeHistory))) && !policyExists;
    expect(sha(Buffer.from(JSON.stringify((await fixture.target.pool.query('SELECT id::text,patient_number,full_name FROM patients ORDER BY id')).rows)))===sha(Buffer.from(JSON.stringify(beforeRows)))).toBe(true);
    expect(sha(Buffer.from(JSON.stringify((await fixture.source.pool.query('SELECT id::text,patient_number,full_name FROM patients ORDER BY id')).rows)))===sha(Buffer.from(JSON.stringify(sourceRows)))).toBe(true);
    expect(sha(await readFile(originalPath))===sha(original) && sha(await readFile(archivePath))===sha(altered)).toBe(true);
    expect(sha(await readFile(markerPath))===sha(marker)).toBe(true);
    const afterIdentity=(await fixture.target.pool.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows[0];
    expect(afterIdentity.oid===targetIdentity.oid && afterIdentity.owner===targetIdentity.owner).toBe(true);
    if(migrated) console.log('SYNTHETIC_TARGET_MIGRATIONS_COMMITTED_BEFORE_REPLAY_FAILURE');
    else if(unchanged) console.log('SYNTHETIC_TARGET_MIGRATIONS_UNCHANGED_AFTER_REPLAY_FAILURE');
    else throw new Error('SYNTHETIC_TARGET_MIGRATION_STATE_UNCLASSIFIED');
  } finally {await fixture.close();}
},180_000);
