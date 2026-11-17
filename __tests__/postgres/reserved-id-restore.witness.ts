/** Synthetic CI-only observation of an ID allocated before a restore. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Client, Pool } from 'pg';
import { expect, it } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { validateStandaloneWitnessEnvironment } from './_standalone-restore-witness-guard';
import { assertPostgres18VersionNum, validateGeneratedDatabaseName } from '../../scripts/verify-schema-ownership';
import { validateLocalVerificationTarget, validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { parseTarBytes } from '../../lib/restore/archive';
import { stagedRestore } from '../../lib/restore/staging';
import { knownNonEmptyRefusal } from '../helpers/synthetic-sequence-refusal';

const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');

async function ownedPair(){
  // The Vitest setup validates this same dedicated CI service before its own
  // connection; these checks are repeated before this file's connections.
  validateStandaloneWitnessEnvironment(process.env);
  validateOperationalVerificationEnvironment(process.env);
  const checked=validatePostgresTestTarget(process.env);
  const admin=new Client({connectionString:checked.maintenanceUrl.toString(),ssl:false});
  const pools:Pool[]=[];
  try {
    await admin.connect();
    assertPostgres18VersionNum((await admin.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
    const directory=await mkdtemp(path.join(tmpdir(),'synthetic-reserved-id-restore-'));
    async function create(kind:'source'|'target'){
      const name=`aqlan_schema_ownership_${kind}_${randomUUID().replaceAll('-','')}`;
      validateGeneratedDatabaseName(name);
      if(name.length>63) throw new Error('Synthetic database name too long');
      const url=new URL(checked.testUrl);url.pathname=`/${name}`;
      validateLocalVerificationTarget(url.toString(),process.env,{varName:'OWNED_SYNTHETIC_RESTORE',databaseName:name});
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount).toBe(0);
      await writeFile(path.join(directory,`intent-${kind}.json`),JSON.stringify({name})+'\n');
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const identity=(await admin.query("SELECT oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role FROM pg_database WHERE datname=$1",[name])).rows[0];
      if(!identity || identity.owner!==identity.role) throw new Error('Synthetic database identity missing');
      await writeFile(path.join(directory,`identity-${kind}.json`),JSON.stringify({name,...identity})+'\n');
      const pool=new Pool({connectionString:url.toString(),ssl:false,max:2});pools.push(pool);
      const actual=(await pool.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role FROM pg_database WHERE datname=current_database()")).rows[0];
      expect(actual?.name===name && actual?.oid===identity.oid && actual?.owner===identity.owner && actual?.role===identity.owner).toBe(true);
      return {name,url,pool,identity};
    }
    const source=await create('source'),target=await create('target');
    return {admin,pools,source,target,directory,async close(){try{for(const pool of pools) await pool.end();}finally{await admin.end();}}};
  } catch(error){
    for(const pool of pools) await pool.end().catch(()=>{});
    await admin.end().catch(()=>{});
    throw error; // Keep any databases and the intent file as synthetic evidence.
  }
}

async function rows(pool:Pool){return (await pool.query('SELECT id::text,patient_number,full_name FROM patients ORDER BY id')).rows;}
async function rowDigest(pool:Pool){return sha(Buffer.from(JSON.stringify(await rows(pool))));}
async function tableDigest(pool:Pool){
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows as {tablename:string}[];
  const hash=createHash('sha256');
  for(const {tablename} of tables){
    const quoted=`"${tablename.replaceAll('"','""')}"`;
    const values=(await pool.query(`SELECT to_jsonb(t)::text AS value FROM ${quoted} t ORDER BY to_jsonb(t)::text`)).rows;
    hash.update(JSON.stringify([tablename,values]));
  }
  return hash.digest('hex');
}
async function seq(pool:Pool){return (await pool.query('SELECT last_value::text,is_called FROM public.patients_id_seq')).rows[0] as {last_value:string;is_called:boolean};}

it.each([{state:'uncalled',start:'75000',called:false},{state:'called',start:'74999',called:true}] as const)(
  'classifies a synthetic ID allocated before legacy replay with $state sequence state',async({start,called})=>{
  const fixture=await ownedPair();
  const allocator=new Client({connectionString:fixture.target.url.toString(),ssl:false});
  try {
    const files=await loadMigrationFiles();
    await migrate(fixture.source.pool,{apply:true,files:files.filter(file=>file.version<='0043')});
    await migrate(fixture.target.pool,{apply:true,files});
    await fixture.source.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(75000,'SYNTHETIC-ARCHIVE','SYNTHETIC SOURCE')");
    await fixture.target.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(300,'SYNTHETIC-TARGET','SYNTHETIC TARGET')");
    const identity=(await fixture.target.pool.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role FROM pg_database WHERE datname=current_database()")).rows[0];
    const adminIdentity=(await fixture.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[fixture.target.name])).rows[0];
    expect(identity.name===fixture.target.name && identity.oid===fixture.target.identity.oid && identity.owner===fixture.target.identity.owner && identity.role===fixture.target.identity.owner).toBe(true);
    expect(adminIdentity?.oid===identity.oid && adminIdentity?.owner===identity.owner).toBe(true);
    await fixture.admin.query(`ALTER DATABASE "${fixture.target.name}" SET statement_timeout = '75s'`);
    await fixture.target.pool.query("SELECT setval('public.patients_id_seq',$1::bigint,$2)",[start,called]);
    const initialSeq=await seq(fixture.target.pool);
    expect(initialSeq.last_value===start && initialSeq.is_called===called).toBe(true);
    const sourceRows=await rows(fixture.source.pool), targetRows=await rows(fixture.target.pool);
    const sourceClient=await fixture.source.pool.connect(),blocks:Buffer[]=[];
    try {for await(const block of fullBackupBlocks({source:sourceClient,readDocument:async()=>{throw new Error('No synthetic documents expected');}})) blocks.push(Buffer.from(block));}
    finally {sourceClient.release();}
    const archive=gzipSync(Buffer.concat(blocks)), parsed=parseTarBytes(gunzipSync(archive));
    const manifest=JSON.parse(Buffer.from(parsed.entries.get('manifest.json')!.data).toString('utf8'));
    expect(Boolean(manifest.identityProvenance)).toBe(false);
    const archivePath=path.join(fixture.directory,'synthetic-archive.tar.gz');await writeFile(archivePath,archive);
    const stage=path.join(fixture.directory,'stage'), markerPath=path.join(stage,'synthetic-marker');
    const marker=Buffer.from('synthetic-reservation-stage-retained');
    await mkdir(stage,{recursive:true});await writeFile(markerPath,marker);
    const beforeRows=await tableDigest(fixture.target.pool);
    await allocator.connect();
    const actual=(await allocator.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role,current_setting('transaction_isolation') AS isolation FROM pg_database WHERE datname=current_database()")).rows[0];
    expect(actual.name===identity.name && actual.oid===identity.oid && actual.owner===identity.owner && actual.role===identity.owner && actual.isolation==='read committed').toBe(true);
    // Separate autocommit queries deliberately represent an ID returned to a
    // caller before its later insert. The value remains synthetic and private.
    const reserved=(await allocator.query("SELECT nextval('public.patients_id_seq')::text AS id")).rows[0].id as string;
    expect(reserved==='75000').toBe(true);
    const reservedSeq=await seq(fixture.target.pool);
    expect(reservedSeq.last_value===reserved && reservedSeq.is_called===true).toBe(true);
    const result=await stagedRestore({archivePath,targetUrl:fixture.target.url.toString(),stagingDir:stage,allowNonEmptyTarget:true});
    if(result.ok){
      const restored=(await rows(fixture.target.pool)).filter(row=>row.id==='75000');
      expect(sha(Buffer.from(JSON.stringify(restored)))===sha(Buffer.from(JSON.stringify(sourceRows)))).toBe(true);
      const attempt=await allocator.query("INSERT INTO patients(id,patient_number,full_name) VALUES($1,'SYNTHETIC-ALLOCATOR','SYNTHETIC ACTOR')",[reserved])
        .then(()=>({kind:'inserted' as const}),error=>({kind:error?.code==='23505' && error?.constraint==='patients_pkey'?'duplicate' as const:'unclassified' as const}));
      if(attempt.kind==='duplicate') console.log('SYNTHETIC_RESERVED_ID_COLLISION_AFTER_ACCEPTED_REPLAY');
      else if(attempt.kind==='inserted') console.log('SYNTHETIC_RESERVED_ID_INSERTED_AFTER_ACCEPTED_REPLAY');
      else throw new Error('SYNTHETIC_RESERVED_INSERT_OUTCOME_UNCLASSIFIED');
    }else{
      expect(result.readyForCutover).toBe(false);
      expect(await tableDigest(fixture.target.pool)===beforeRows).toBe(true);
      const after=await seq(fixture.target.pool);
      expect(after.last_value===reservedSeq.last_value && after.is_called===reservedSeq.is_called).toBe(true);
      expect(sha(await readFile(markerPath))===sha(marker)).toBe(true);
      if(!knownNonEmptyRefusal(result)) throw new Error('SYNTHETIC_REPLAY_REJECTION_UNCLASSIFIED');
      const inserted=await allocator.query("INSERT INTO patients(id,patient_number,full_name) VALUES($1,'SYNTHETIC-ALLOCATOR','SYNTHETIC ACTOR')",[reserved]);
      expect(inserted.rowCount).toBe(1);
      console.log('SYNTHETIC_KNOWN_REFUSAL_THEN_RESERVED_INSERT');
    }
    const afterTarget=await rows(fixture.target.pool);
    expect(sha(Buffer.from(JSON.stringify(afterTarget.filter(row=>row.id==='300'))))===sha(Buffer.from(JSON.stringify(targetRows)))).toBe(true);
    expect(await rowDigest(fixture.source.pool)===sha(Buffer.from(JSON.stringify(sourceRows)))).toBe(true);
    expect(sha(await readFile(archivePath))===sha(archive)).toBe(true);
    expect(sha(await readFile(markerPath))===sha(marker)).toBe(true);
    const afterIdentity=(await fixture.target.pool.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows[0];
    expect(afterIdentity.oid===identity.oid && afterIdentity.owner===identity.owner).toBe(true);
  } finally {await allocator.end().catch(()=>{});await fixture.close();}
},180_000);
