/** Synthetic, CI-only pending-allocation/replay witness. No database is dropped. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Client, Pool } from 'pg';
import { expect, it } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { validateStandaloneWitnessEnvironment } from './_standalone-restore-witness-guard';
import { validateGeneratedDatabaseName, assertPostgres18VersionNum } from '../../scripts/verify-schema-ownership';
import { validateLocalVerificationTarget, validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { stagedRestore } from '../../lib/restore/staging';
import { parseTarBytes } from '../../lib/restore/archive';

const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
type Seq={last_value:string;is_called:boolean};
const next=(state:Seq)=>BigInt(state.last_value)+(state.is_called?1n:0n);
const sequence=async(pool:Pool):Promise<Seq>=>(await pool.query('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0] as Seq;
const floor=async(pool:Pool):Promise<bigint>=>BigInt((await pool.query('SELECT aqlan_patient_number_next()::text AS value')).rows[0].value);
const patientRows=async(pool:Pool)=>(await pool.query('SELECT id::text,patient_number,full_name FROM patients ORDER BY id')).rows;
const stableHash=(value:unknown)=>sha(Buffer.from(JSON.stringify(value)));

async function withDeadline<T>(promise:Promise<T>,ms:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SYNTHETIC_PENDING_REPLAY_TIMEOUT_UNCLASSIFIED')),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}

async function ownedPair(){
  validateStandaloneWitnessEnvironment(process.env);
  validateOperationalVerificationEnvironment(process.env);
  const checked=validatePostgresTestTarget(process.env);
  const admin=new Client({connectionString:checked.maintenanceUrl.toString(),ssl:false});
  const pools:Pool[]=[];
  try{
    await admin.connect();
    assertPostgres18VersionNum((await admin.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
    const directory=await mkdtemp(path.join(tmpdir(),'synthetic-pending-patient-number-'));
    async function create(kind:'source'|'target'){
      const name=`aqlan_schema_ownership_${kind}_${randomUUID().replaceAll('-','')}`;
      validateGeneratedDatabaseName(name);
      if(name.length>63)throw new Error('Synthetic database name too long');
      const url=new URL(checked.testUrl);url.pathname=`/${name}`;
      validateLocalVerificationTarget(url.toString(),process.env,{varName:'OWNED_SYNTHETIC_RESTORE',databaseName:name});
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount).toBe(0);
      await writeFile(path.join(directory,`${kind}-intent.json`),JSON.stringify({name})+'\n');
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const identity=(await admin.query("SELECT oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role FROM pg_database WHERE datname=$1",[name])).rows[0];
      if(!identity || identity.owner!==identity.role)throw new Error('Synthetic database ownership mismatch');
      await writeFile(path.join(directory,`${kind}-identity.json`),JSON.stringify({name,...identity})+'\n');
      const pool=new Pool({connectionString:url.toString(),ssl:false,max:2});pools.push(pool);
      return {name,url,pool,identity};
    }
    const source=await create('source'),target=await create('target');
    async function verify(db:typeof source|typeof target){
      const row=(await db.pool.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role,current_setting('transaction_isolation') AS isolation FROM pg_database WHERE datname=current_database()")).rows[0];
      const adminRow=(await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[db.name])).rows[0];
      expect(row?.name===db.name && row?.oid===db.identity.oid && row?.owner===db.identity.owner && row?.role===db.identity.owner && row?.isolation==='read committed').toBe(true);
      expect(adminRow?.oid===db.identity.oid && adminRow?.owner===db.identity.owner).toBe(true);
    }
    await verify(source);await verify(target);
    return {admin,source,target,directory,verify,async close(){try{for(const pool of pools)await pool.end();}finally{await admin.end();}}};
  }catch(error){
    for(const pool of pools)await pool.end().catch(()=>{});
    await admin.end().catch(()=>{});
    throw error; // Preserve all databases and identity files already created.
  }
}

async function fixedRows(pool:Pool,table:'patient_numbering_policy'|'retired_patient_numbers'|'schema_migrations'){
  return (await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
}

function refusal(result:Awaited<ReturnType<typeof stagedRestore>>):'BUSY'|'NONEMPTY'|'UNKNOWN'{
  if(result.ok || result.readyForCutover || result.validationErrors.length!==0 || result.errors.length!==1)return 'UNKNOWN';
  const error=result.errors[0];
  if(error==='فشل تطبيق بيانات الاستعادة على الهدف المعزول: patient numbering busy; refresh and retry')return 'BUSY';
  if(/^الهدف ليس فارغًا \([1-9]\d* جدولًا\)\. الاستعادة فوق بيانات قائمة مرفوضة افتراضًا — إن كان المقصود فعلًا فمرّر allowNonEmptyTarget بوعي كامل\.$/u.test(error))return 'NONEMPTY';
  return 'UNKNOWN';
}

it('keeps a pending synthetic patient allocation and retired floor from being reused across replay',async()=>{
  const fixture=await ownedPair();
  const actor=new Client({connectionString:fixture.target.url.toString(),ssl:false});
  let actorOpen=false;
  let replay:Promise<{kind:'returned';result:Awaited<ReturnType<typeof stagedRestore>>}|{kind:'thrown'}>|undefined;
  try{
    const files=await loadMigrationFiles();
    // All migrations run only on the new empty databases, before test data.
    await migrate(fixture.source.pool,{apply:true,files});
    await migrate(fixture.target.pool,{apply:true,files});
    expect((await fixture.source.pool.query('SELECT count(*)::int AS n FROM patient_numbering_policy')).rows[0].n).toBe(0);
    expect((await fixture.source.pool.query('SELECT count(*)::int AS n FROM retired_patient_numbers')).rows[0].n).toBe(0);
    await fixture.source.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(75000,'P-00220','SYNTHETIC SOURCE')");
    await fixture.target.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(300,'P-00123','SYNTHETIC TARGET')");
    await fixture.target.pool.query('INSERT INTO patient_numbering_policy(singleton,minimum_next,version) VALUES(true,12000,1)');
    await fixture.target.pool.query("INSERT INTO retired_patient_numbers(patient_number,patient_id) VALUES('P-13000',300)");
    // Verify the exact created database name/OID/owner and caller before either
    // explicit setval; no externally supplied database is mutated.
    await fixture.verify(fixture.source);await fixture.verify(fixture.target);
    await fixture.source.pool.query("SELECT setval('patient_number_seq',9000,false)");
    await fixture.target.pool.query("SELECT setval('patient_number_seq',10000,true)");
    const sourceSeq=await sequence(fixture.source.pool);
    const beforeSeq=await sequence(fixture.target.pool),beforeFloor=await floor(fixture.target.pool);
    const sourceRows=await patientRows(fixture.source.pool),targetRows=await patientRows(fixture.target.pool);
    const sourcePolicy=await fixedRows(fixture.source.pool,'patient_numbering_policy');
    const sourceRetired=await fixedRows(fixture.source.pool,'retired_patient_numbers');
    const sourceHistory=await fixedRows(fixture.source.pool,'schema_migrations');
    const policy=await fixedRows(fixture.target.pool,'patient_numbering_policy');
    const retired=await fixedRows(fixture.target.pool,'retired_patient_numbers');
    const history=await fixedRows(fixture.target.pool,'schema_migrations');
    expect(beforeFloor>next(beforeSeq)).toBe(true);

    const client=await fixture.source.pool.connect(),blocks:Buffer[]=[];
    try{for await(const block of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No synthetic document expected');}}))blocks.push(Buffer.from(block));}
    finally{client.release();}
    const archive=gzipSync(Buffer.concat(blocks)),parsed=parseTarBytes(gunzipSync(archive));
    const manifest=JSON.parse(Buffer.from(parsed.entries.get('manifest.json')!.data).toString('utf8'));
    expect(Boolean(manifest.identityProvenance)).toBe(false);
    const sql=Buffer.from(parsed.entries.get('database.sql')!.data).toString('utf8');
    expect(sql.includes("SELECT setval('patient_number_seq', GREATEST(last_value,")).toBe(true);
    expect(sql.includes('INSERT INTO patient_numbering_policy ')).toBe(false);
    expect(sql.includes('P-00220')).toBe(true);
    const archivePath=path.join(fixture.directory,'synthetic-source.tar.gz');await writeFile(archivePath,archive);
    const stage=path.join(fixture.directory,'stage'),markerPath=path.join(stage,'synthetic-stage-marker');
    const marker=Buffer.from('synthetic-pending-allocation-stage-retained');
    await mkdir(stage,{recursive:true});await writeFile(markerPath,marker);

    // Bound new test connections only, on the already verified, newly-created
    // target. Existing pool sessions and other databases are unaffected.
    await fixture.verify(fixture.target);
    await fixture.admin.query(`ALTER DATABASE "${fixture.target.name}" SET statement_timeout = '75s'`);
    await actor.connect();
    const actorIdentity=(await actor.query("SELECT current_database() AS name,oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role,current_setting('transaction_isolation') AS isolation,pg_backend_pid() AS pid FROM pg_database WHERE datname=current_database()")).rows[0];
    expect(actorIdentity.name===fixture.target.name && actorIdentity.oid===fixture.target.identity.oid && actorIdentity.owner===fixture.target.identity.owner && actorIdentity.role===fixture.target.identity.owner && actorIdentity.isolation==='read committed').toBe(true);
    await actor.query('BEGIN');actorOpen=true;
    const allocated=(await actor.query('SELECT aqlan_allocate_patient_number() AS value')).rows[0].value as string;
    expect(allocated==='P-13001').toBe(true);
    const allocatedNumber=BigInt(allocated.slice(2));
    const afterAllocation=await sequence(fixture.target.pool),floorAfterAllocation=await floor(fixture.target.pool);
    expect(next(afterAllocation)>=next(beforeSeq) && floorAfterAllocation>allocatedNumber).toBe(true);

    // Fixed application_name makes pg_blocking_pids identify this replay
    // connection rather than any unrelated session. It cannot change routing.
    const replayUrl=new URL(fixture.target.url);replayUrl.searchParams.set('application_name','SYNTHETIC_PENDING_REPLAY');
    expect(replayUrl.hostname===fixture.target.url.hostname && replayUrl.port===fixture.target.url.port && replayUrl.pathname===fixture.target.url.pathname && replayUrl.username===fixture.target.url.username).toBe(true);
    replay=stagedRestore({archivePath,targetUrl:replayUrl.toString(),stagingDir:stage,allowNonEmptyTarget:true})
      .then(result=>({kind:'returned' as const,result}),()=>({kind:'thrown' as const}));
    let finished=false,finishedWhileActorOpen=false;
    void replay.then(()=>{finishedWhileActorOpen=actorOpen;finished=true;});
    const until=Date.now()+30000;let waited=false,waitTimedOut=false;
    for(;;){
      if(finished)break;
      const blocking=(await fixture.target.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND a.application_name='SYNTHETIC_PENDING_REPLAY' AND $1::int=ANY(pg_blocking_pids(a.pid))) AS waiting",[actorIdentity.pid])).rows[0].waiting;
      if(blocking){waited=true;break;}
      if(Date.now()>until){waitTimedOut=true;break;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    // Snapshot whether replay finished while the actor was open, then release
    // the actor BEFORE awaiting any blocked replay to avoid deadlock.
    const finishedBeforeRollback=finished;
    await actor.query('ROLLBACK');actorOpen=false;
    const observation=await withDeadline(replay,40000);
    const result=observation.kind==='returned'?observation.result:undefined;
    const recognized=result && !result.ok?refusal(result):'UNKNOWN';
    if(waited)console.log('SYNTHETIC_REPLAY_WAITED_FOR_ALLOCATOR_ACTOR');
    if((finishedBeforeRollback || finishedWhileActorOpen) && recognized==='BUSY')console.log('SYNTHETIC_REPLAY_BUSY_WHILE_ACTOR_OPEN');
    if((finishedBeforeRollback || finishedWhileActorOpen) && recognized==='NONEMPTY')console.log('SYNTHETIC_NONEMPTY_GUARD_WHILE_ACTOR_OPEN');
    if(!finishedBeforeRollback && !finishedWhileActorOpen && result?.ok)console.log('SYNTHETIC_REPLAY_SUCCEEDED_AFTER_ACTOR_ROLLBACK');

    const afterReplay=await sequence(fixture.target.pool),afterFloor=await floor(fixture.target.pool);
    expect(next(afterReplay)>=next(afterAllocation)).toBe(true);
    expect(afterFloor>=floorAfterAllocation && afterFloor>allocatedNumber).toBe(true);
    expect(stableHash(await fixedRows(fixture.target.pool,'patient_numbering_policy'))===stableHash(policy)).toBe(true);
    expect(stableHash(await fixedRows(fixture.target.pool,'retired_patient_numbers'))===stableHash(retired)).toBe(true);
    expect(stableHash(await fixedRows(fixture.target.pool,'schema_migrations'))===stableHash(history)).toBe(true);
    expect(stableHash(await patientRows(fixture.source.pool))===stableHash(sourceRows)).toBe(true);
    expect(stableHash(await fixedRows(fixture.source.pool,'patient_numbering_policy'))===stableHash(sourcePolicy)).toBe(true);
    expect(stableHash(await fixedRows(fixture.source.pool,'retired_patient_numbers'))===stableHash(sourceRetired)).toBe(true);
    expect(stableHash(await fixedRows(fixture.source.pool,'schema_migrations'))===stableHash(sourceHistory)).toBe(true);
    const sourceSeqAfter=await sequence(fixture.source.pool);
    expect(sourceSeqAfter.last_value===sourceSeq.last_value && sourceSeqAfter.is_called===sourceSeq.is_called).toBe(true);
    expect(sha(await readFile(archivePath))===sha(archive) && sha(await readFile(markerPath))===sha(marker)).toBe(true);
    await fixture.verify(fixture.source);await fixture.verify(fixture.target);
    const afterRows=await patientRows(fixture.target.pool);
    expect(stableHash(afterRows.filter(row=>row.id==='300'))===stableHash(targetRows)).toBe(true);
    if(result?.ok){
      expect(waited && !finishedBeforeRollback && !finishedWhileActorOpen && result.readyForCutover).toBe(true);
      expect(stableHash(afterRows.filter(row=>row.id==='75000'))===stableHash(sourceRows)).toBe(true);
    }else{
      expect(stableHash(afterRows)===stableHash(targetRows)).toBe(true);
      if(recognized==='UNKNOWN')throw new Error('SYNTHETIC_PENDING_REPLAY_REFUSAL_UNCLASSIFIED');
    }
    if(waitTimedOut)throw new Error('SYNTHETIC_PENDING_REPLAY_WAIT_UNCLASSIFIED');
    const nextNumber=(await fixture.target.pool.query('SELECT aqlan_allocate_patient_number() AS value')).rows[0].value as string;
    expect(nextNumber!==allocated && nextNumber!=='P-13000').toBe(true);
    expect(BigInt(nextNumber.slice(2))>allocatedNumber).toBe(true);
    console.log('SYNTHETIC_PENDING_ALLOCATION_NOT_REUSED');
  }finally{
    if(actorOpen)await actor.query('ROLLBACK').catch(()=>{});
    if(replay)await withDeadline(replay,80000).catch(()=>{});
    await actor.end().catch(()=>{});
    await fixture.close();
  }
},180_000);
