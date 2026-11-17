/** Synthetic CI-only: actual DEFAULT id after late failed replay. */
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
import { tarGzBytes } from '../helpers/backup-tar';
import { knownLateDuplicate, knownNonEmptyRefusal } from '../helpers/synthetic-sequence-refusal';

const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
type State={last_value:string;is_called:boolean};
type Prepared={data:string; history:string; rows:string; sequence:State};
async function deadline<T>(promise:Promise<T>,message:string,ms:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}

async function ownedPair(){
  // Global setup separately checks the same dedicated CI service; repeat the
  // guards before this witness's maintenance connection.
  validateStandaloneWitnessEnvironment(process.env);
  validateOperationalVerificationEnvironment(process.env);
  const checked=validatePostgresTestTarget(process.env);
  const admin=new Client({connectionString:checked.maintenanceUrl.toString(),ssl:false});
  const pools:Pool[]=[];
  try {
    await admin.connect();
    assertPostgres18VersionNum((await admin.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
    const directory=await mkdtemp(path.join(tmpdir(),'synthetic-default-id-rollback-'));
    async function create(kind:'source'|'target'){
      const name=`aqlan_schema_ownership_${kind}_${randomUUID().replaceAll('-','')}`;
      validateGeneratedDatabaseName(name);
      if(name.length>63)throw new Error('Synthetic database name too long');
      const url=new URL(checked.testUrl);url.pathname=`/${name}`;
      validateLocalVerificationTarget(url.toString(),process.env,{varName:'OWNED_SYNTHETIC_RESTORE',databaseName:name});
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount).toBe(0);
      await writeFile(path.join(directory,`intent-${kind}.json`),JSON.stringify({name})+'\n');
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const identity=(await admin.query("SELECT oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role FROM pg_database WHERE datname=$1",[name])).rows[0];
      if(!identity || identity.owner!==identity.role)throw new Error('Synthetic database identity missing');
      await writeFile(path.join(directory,`identity-${kind}.json`),JSON.stringify({name,...identity})+'\n');
      const pool=new Pool({connectionString:url.toString(),ssl:false,max:2});pools.push(pool);
      const actual=(await pool.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role FROM pg_database WHERE datname=current_database()")).rows[0];
      expect(actual?.name===name && actual?.oid===identity.oid && actual?.owner===identity.owner && actual?.role===identity.owner).toBe(true);
      return {name,url,pool,identity};
    }
    const source=await create('source'),target=await create('target');
    return {admin,source,target,directory,async close(){try{for(const pool of pools)await pool.end();}finally{await admin.end();}}};
  }catch(error){
    for(const pool of pools)await pool.end().catch(()=>{});
    await admin.end().catch(()=>{});
    throw error; // Keep created databases and intent/identity files.
  }
}

type Queryable=Pick<Client,'query'>;
async function patients(client:Queryable){return (await client.query('SELECT id::text,patient_number,full_name FROM patients ORDER BY id')).rows;}
async function history(client:Queryable){return sha(Buffer.from(JSON.stringify((await client.query('SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations ORDER BY version')).rows)));}
async function dataDigest(client:Queryable){
  const names=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows as {tablename:string}[];
  const hash=createHash('sha256');
  for(const {tablename} of names){
    const identifier=`"${tablename.replaceAll('"','""')}"`;
    const rows=(await client.query(`SELECT to_jsonb(t)::text AS value FROM ${identifier} t ORDER BY to_jsonb(t)::text`)).rows;
    hash.update(JSON.stringify([tablename,rows]));
  }
  return hash.digest('hex');
}
async function seq(client:Queryable):Promise<State>{return (await client.query('SELECT last_value::text,is_called FROM public.patients_id_seq')).rows[0] as State;}
const next=(value:State)=>BigInt(value.last_value)+(value.is_called?1n:0n);

async function archive(source:Pool){
  const client=await source.connect(),blocks:Buffer[]=[];
  try{for await(const block of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No synthetic documents expected');}}))blocks.push(Buffer.from(block));}
  finally{client.release();}
  const original=gzipSync(Buffer.concat(blocks)),parsed=parseTarBytes(gunzipSync(original));
  const manifest=JSON.parse(Buffer.from(parsed.entries.get('manifest.json')!.data).toString('utf8'));
  expect(Boolean(manifest.identityProvenance)).toBe(false);
  const sql=Buffer.from(parsed.entries.get('database.sql')!.data).toString('utf8');
  expect(/COMMIT;\s*$/.test(sql)).toBe(true);
  const duplicate='INSERT INTO patients ("id", "patient_number", "full_name") VALUES (75000, \'SYNTHETIC-DUPLICATE\', \'SYNTHETIC FAILURE\');\n';
  const changed=Buffer.from(sql.replace(/COMMIT;\s*$/,`${duplicate}COMMIT;\n`));
  manifest.databaseSha256=sha(changed);manifest.databaseBytes=changed.length;
  const faulty=Buffer.from(tarGzBytes(parsed.order.map(name=>({name,data:name==='database.sql'?changed:name==='manifest.json'?Buffer.from(JSON.stringify(manifest)):parsed.entries.get(name)!.data}))));
  return {original,faulty};
}

it.each([
  {entry:'empty',called:false},{entry:'empty',called:true},
  {entry:'nonempty',called:false},{entry:'nonempty',called:true},
] as const)('checks DEFAULT id after failed replay on $entry target with is_called=$called',async({entry,called})=>{
  const fixture=await ownedPair();
  const barrier=new Client({connectionString:fixture.target.url.toString(),ssl:false});
  const actor=new Client({connectionString:fixture.target.url.toString(),ssl:false});
  let held=false;
  try{
    const files=await loadMigrationFiles();
    await migrate(fixture.source.pool,{apply:true,files:files.filter(file=>file.version<='0043')});
    await fixture.source.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(75000,'SYNTHETIC-SOURCE','SYNTHETIC SOURCE')");
    if(entry==='nonempty'){
      await migrate(fixture.target.pool,{apply:true,files});
      await fixture.target.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(300,'SYNTHETIC-TARGET','SYNTHETIC TARGET')");
    }
    const identity=(await fixture.target.pool.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role FROM pg_database WHERE datname=current_database()")).rows[0];
    const adminIdentity=(await fixture.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[fixture.target.name])).rows[0];
    expect(identity.name===fixture.target.name && identity.oid===fixture.target.identity.oid && identity.owner===fixture.target.identity.owner && identity.role===fixture.target.identity.owner).toBe(true);
    expect(adminIdentity?.oid===identity.oid && adminIdentity?.owner===identity.owner).toBe(true);
    const entryCount=(await fixture.target.pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
    expect(entry==='empty'?entryCount===0:entryCount>0).toBe(true);
    // The setting affects only future connections to this new owned DB.
    await fixture.admin.query(`ALTER DATABASE "${fixture.target.name}" SET statement_timeout = '75s'`);
    const sourceRows=await patients(fixture.source.pool), copies=await archive(fixture.source.pool);
    const originalPath=path.join(fixture.directory,'synthetic-original.tar.gz'),archivePath=path.join(fixture.directory,'synthetic-failure.tar.gz');
    await writeFile(originalPath,copies.original);await writeFile(archivePath,copies.faulty);
    const stage=path.join(fixture.directory,'stage'),markerPath=path.join(stage,'synthetic-marker'),marker=Buffer.from('synthetic-default-stage-retained');
    await mkdir(stage,{recursive:true});await writeFile(markerPath,marker);
    await barrier.connect();await actor.connect();
    for(const client of [barrier,actor]){
      const actual=(await client.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role,current_setting('transaction_isolation') AS isolation FROM pg_database WHERE datname=current_database()")).rows[0];
      expect(actual.name===identity.name && actual.oid===identity.oid && actual.owner===identity.owner && actual.role===identity.owner && actual.isolation==='read committed').toBe(true);
    }
    await barrier.query('SELECT pg_advisory_lock(473021::bigint)');held=true;
    let prepared:Prepared|undefined;
    // This documented test-only seam runs after migrations but before replay.
    // It creates only a synthetic trigger and does not remove its evidence.
    const running=stagedRestore({archivePath,targetUrl:fixture.target.url.toString(),stagingDir:stage,allowNonEmptyTarget:entry==='nonempty',
      installUnregisteredProposals:async client=>{
        const actual=(await client.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role,current_setting('transaction_isolation') AS isolation FROM pg_database WHERE datname=current_database()")).rows[0];
        expect(actual.name===identity.name && actual.oid===identity.oid && actual.owner===identity.owner && actual.role===identity.owner && actual.isolation==='read committed').toBe(true);
        const config=(await client.query("SELECT seqincrement::text AS increment,seqcache::text AS cache,seqcycle AS cycle FROM pg_sequence WHERE seqrelid='public.patients_id_seq'::regclass")).rows[0];
        expect(config.increment==='1' && config.cache==='1' && config.cycle===false).toBe(true);
        await client.query("SELECT setval('public.patients_id_seq',100000,$1)",[called]);
        await client.query(`CREATE FUNCTION synthetic_default_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=75000 THEN PERFORM pg_advisory_xact_lock(473021::bigint); END IF; RETURN NEW; END $$`);
        await client.query('CREATE TRIGGER synthetic_default_pause BEFORE INSERT ON patients FOR EACH ROW EXECUTE FUNCTION synthetic_default_pause()');
        prepared={data:await dataDigest(client),history:await history(client),rows:sha(Buffer.from(JSON.stringify(await patients(client)))),sequence:await seq(client)};
        expect(prepared.sequence.last_value==='100000' && prepared.sequence.is_called===called).toBe(true);
      }}).then(result=>({kind:'returned' as const,result}),()=>({kind:'thrown' as const}));
    let completed=false;void running.then(()=>{completed=true;});
    try{
      let reached=false;const until=Date.now()+30000;
      for(;;){
        const waiting=(await fixture.target.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=0 AND objid=473021 AND NOT granted) AS waiting")).rows[0].waiting;
        if(waiting){reached=true;break;}
        if(completed)break;
        if(Date.now()>until)throw new Error('SYNTHETIC_REPLAY_BARRIER_TIMEOUT');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!reached){
        const observation=await running;
        expect(sha(await readFile(originalPath))===sha(copies.original) && sha(await readFile(archivePath))===sha(copies.faulty)).toBe(true);
        expect(sha(await readFile(markerPath))===sha(marker)).toBe(true);
        const after=(await fixture.target.pool.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows[0];
        expect(after.oid===identity.oid && after.owner===identity.owner).toBe(true);
        if(observation.kind==='returned' && knownNonEmptyRefusal(observation.result))throw new Error('SYNTHETIC_KNOWN_REFUSAL_REPLAY_NOT_EXERCISED');
        throw new Error('SYNTHETIC_REPLAY_NOT_EXERCISED_UNCLASSIFIED');
      }
      const before=prepared as Prepared|undefined;
      if(!before)throw new Error('SYNTHETIC_TEST_SEAM_NOT_EXERCISED');
      const reserve=actor.query("SELECT nextval('public.patients_id_seq')::text AS id")
        .then(result=>({kind:'value' as const,value:result.rows[0].id as string}),()=>({kind:'error' as const}));
      let reservationDone=false;void reserve.then(()=>{reservationDone=true;});
      let blocked=false;const reserveUntil=Date.now()+30000;
      while(!reservationDone){
        const waiting=(await fixture.target.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='relation' AND relation='public.patients_id_seq'::regclass AND NOT granted) AS waiting")).rows[0].waiting;
        if(waiting){blocked=true;break;}
        if(Date.now()>reserveUntil)throw new Error('SYNTHETIC_RESERVATION_WAIT_UNCLASSIFIED');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      console.log(blocked?'SYNTHETIC_RESERVATION_BLOCKED_BY_SEQUENCE':'SYNTHETIC_RESERVATION_COMPLETED_BEFORE_REPLAY_RESUMED');
      await barrier.query('SELECT pg_advisory_unlock(473021::bigint)');held=false;
      const [reservation,observation]=await deadline(Promise.all([reserve,running]),'SYNTHETIC_REPLAY_COMPLETION_TIMEOUT',40000);
      if(reservation.kind==='error')throw new Error('SYNTHETIC_RESERVATION_ERROR_UNCLASSIFIED');
      if(observation.kind==='thrown')throw new Error('SYNTHETIC_REPLAY_EXCEPTION_UNCLASSIFIED');
      if(!knownLateDuplicate(observation.result)){
        if(knownNonEmptyRefusal(observation.result))throw new Error('SYNTHETIC_KNOWN_REFUSAL_REPLAY_NOT_EXERCISED');
        throw new Error('SYNTHETIC_REPLAY_OUTCOME_UNCLASSIFIED');
      }
      console.log('SYNTHETIC_LATE_DUPLICATE_REACHED');
      const afterFailure=await seq(fixture.target.pool);
      console.log(next(afterFailure)<next(before.sequence)?'SYNTHETIC_ID_CANDIDATE_REGRESSED_AFTER_FAILURE':'SYNTHETIC_ID_CANDIDATE_NOT_REGRESSED_AFTER_FAILURE');
      expect(await dataDigest(fixture.target.pool)===before.data).toBe(true);
      expect(await history(fixture.target.pool)===before.history).toBe(true);
      expect(sha(Buffer.from(JSON.stringify(await patients(fixture.target.pool))))===before.rows).toBe(true);
      expect(sha(Buffer.from(JSON.stringify(await patients(fixture.source.pool))))===sha(Buffer.from(JSON.stringify(sourceRows)))).toBe(true);
      expect(sha(await readFile(originalPath))===sha(copies.original) && sha(await readFile(archivePath))===sha(copies.faulty)).toBe(true);
      expect(sha(await readFile(markerPath))===sha(marker)).toBe(true);
      const afterIdentity=(await fixture.target.pool.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows[0];
      expect(afterIdentity.oid===identity.oid && afterIdentity.owner===identity.owner).toBe(true);
      // Actual INSERT uses DEFAULT patients.id; patient_number is deliberately
      // fixed synthetic text and is not a test of its separate allocator.
      const inserted=await actor.query("INSERT INTO patients(patient_number,full_name) VALUES('SYNTHETIC-DEFAULT-ACTOR','SYNTHETIC ACTOR') RETURNING id::text,patient_number,full_name");
      const id=inserted.rows[0]?.id as string|undefined;
      expect(inserted.rowCount===1 && typeof id==='string' && inserted.rows[0]?.patient_number==='SYNTHETIC-DEFAULT-ACTOR' && inserted.rows[0]?.full_name==='SYNTHETIC ACTOR').toBe(true);
      if(!id)throw new Error('SYNTHETIC_DEFAULT_INSERT_ID_MISSING');
      const saved=(await patients(fixture.target.pool)).filter(row=>row.id===id);
      expect(sha(Buffer.from(JSON.stringify(saved)))===sha(Buffer.from(JSON.stringify(inserted.rows)))).toBe(true);
      console.log(BigInt(id)>BigInt(reservation.value)?'SYNTHETIC_DEFAULT_ID_ABOVE_RESERVATION':'SYNTHETIC_DEFAULT_ID_AT_OR_BELOW_RESERVATION');
      expect(BigInt(id)>BigInt(reservation.value),'synthetic default ID did not exceed the reservation').toBe(true);
    }finally{
      if(held){await barrier.query('SELECT pg_advisory_unlock(473021::bigint)').catch(()=>{});held=false;}
      await running.catch(()=>{});
    }
  }finally{await barrier.end().catch(()=>{});await actor.end().catch(()=>{});await fixture.close();}
},180_000);
