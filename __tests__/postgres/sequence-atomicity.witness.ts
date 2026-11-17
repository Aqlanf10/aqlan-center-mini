/** Synthetic CI-only witness: each case owns new databases and retains evidence. */
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
import { knownLateDuplicate, knownNonEmptyRefusal } from '../helpers/synthetic-sequence-refusal';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const marker = 'SYNTHETIC_SEQUENCE_ATOMICITY';

async function ownedPair() {
  // The global setup also runs only in this explicitly guarded CI service.
  validateStandaloneWitnessEnvironment(process.env);
  validateOperationalVerificationEnvironment(process.env);
  const checked = validatePostgresTestTarget(process.env);
  const admin = new Client({connectionString: checked.maintenanceUrl.toString(), ssl:false});
  const pools: Pool[] = [];
  await admin.connect();
  try {
    assertPostgres18VersionNum((await admin.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
    async function create(kind:'source'|'target') {
      const name = `aqlan_schema_ownership_${kind}_${randomUUID().replaceAll('-', '')}`;
      validateGeneratedDatabaseName(name);
      if (name.length > 63) throw new Error('Synthetic database name too long');
      const url = new URL(checked.testUrl); url.pathname = `/${name}`;
      validateLocalVerificationTarget(url.toString(), process.env, {varName:'OWNED_SYNTHETIC_RESTORE',databaseName:name});
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount).toBe(0);
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      const identity = (await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[name])).rows[0];
      if (!identity) throw new Error('Synthetic database identity missing');
      const pool = new Pool({connectionString:url.toString(),ssl:false,max:2}); pools.push(pool);
      const actual = (await pool.query("SELECT oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS current_role FROM pg_database WHERE datname=current_database()")).rows[0];
      expect(actual?.oid === identity.oid && actual?.owner === identity.owner).toBe(true);
      expect(actual?.owner === actual?.current_role).toBe(true);
      return {name,url,pool,identity};
    }
    const source = await create('source'), target = await create('target');
    const directory = await mkdtemp(path.join(tmpdir(),'synthetic-sequence-atomicity-'));
    await writeFile(path.join(directory,'identity.json'),JSON.stringify({source:{name:source.name,...source.identity},target:{name:target.name,...target.identity}})+'\n');
    return {admin,source,target,directory,async close(){for(const pool of pools) await pool.end(); await admin.end();}};
  } catch (error) {
    for (const pool of pools) await pool.end().catch(()=>{});
    await admin.end().catch(()=>{});
    throw error; // Preserve any databases already created.
  }
}

type Seq = {last_value:string; is_called:boolean};
async function sequence(pool:Pool, name:'patients_id_seq'|'patient_number_seq'):Promise<Seq> {
  return (await pool.query(`SELECT last_value::text,is_called FROM ${name}`)).rows[0] as Seq;
}
const next = (s:Seq) => BigInt(s.last_value)+(s.is_called ? 1n : 0n);
const same = (a:Seq,b:Seq) => a.last_value===b.last_value && a.is_called===b.is_called;
function change(before:Seq,after:Seq) {
  return next(after)<next(before)?'REGRESSED':next(after)>next(before)?'ADVANCED':same(before,after)?'UNCHANGED':'STATE_CHANGED_SAME_CANDIDATE';
}
async function deadline<T>(promise:Promise<T>,message:string,ms:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]); }
  finally { if(timer) clearTimeout(timer); }
}

async function makeArchive(source:Pool, fail:boolean) {
  const client = await source.connect(), blocks:Buffer[] = [];
  try {
    for await (const block of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No synthetic document expected');}})) blocks.push(Buffer.from(block));
  } finally { client.release(); }
  const bytes = gzipSync(Buffer.concat(blocks));
  const parsed = parseTarBytes(gunzipSync(bytes));
  const manifest = JSON.parse(Buffer.from(parsed.entries.get('manifest.json')!.data).toString('utf8'));
  // The legacy fixture must not take the canonical source branch: that branch
  // correctly forbids nonempty targets and cannot exercise this opt-in path.
  expect(Boolean(manifest.identityProvenance)).toBe(false);
  if (!fail) return bytes;
  const sql = Buffer.from(parsed.entries.get('database.sql')!.data).toString('utf8');
  expect(/COMMIT;\s*$/.test(sql)).toBe(true);
  // Valid writer literal syntax; the duplicate is after writer setval lines.
  const failure = `INSERT INTO patients ("id", "patient_number", "full_name") VALUES (75000, 'P-SYNTHETIC-DUPLICATE', '${marker}');\n`;
  const changed = Buffer.from(sql.replace(/COMMIT;\s*$/,`${failure}COMMIT;\n`));
  manifest.databaseSha256 = sha(changed); manifest.databaseBytes = changed.length;
  return Buffer.from(tarGzBytes(parsed.order.map(name=>({name,data:name==='database.sql'?changed:name==='manifest.json'?Buffer.from(JSON.stringify(manifest)):parsed.entries.get(name)!.data}))));
}

async function prepare(fixture:Awaited<ReturnType<typeof ownedPair>>,called:boolean) {
  const files = await loadMigrationFiles();
  await migrate(fixture.source.pool,{apply:true,files:files.filter(file=>file.version<='0043')});
  await fixture.source.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(75000,'P-SYNTHETIC-OLD','SYNTHETIC ARCHIVE')");
  await migrate(fixture.target.pool,{apply:true,files});
  await fixture.target.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(300,'P-SYNTHETIC-TARGET','SYNTHETIC TARGET')");
  const identity = await dbIdentity(fixture.target.pool);
  const adminIdentity = (await fixture.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[fixture.target.name])).rows[0];
  expect(identity.oid===fixture.target.identity.oid && identity.owner===fixture.target.identity.owner).toBe(true);
  expect(adminIdentity?.oid===fixture.target.identity.oid && adminIdentity?.owner===fixture.target.identity.owner).toBe(true);
  const targetCapabilities=(await fixture.target.pool.query(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('default_transaction_isolation') AS default_isolation,
    (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS current_role,
    has_database_privilege(current_database(),'CONNECT') AS can_connect,
    has_database_privilege(current_database(),'CREATE') AS can_create,
    has_table_privilege('public.patients','INSERT') AS can_insert,
    has_table_privilege('public.patients','SELECT') AS can_select,
    has_sequence_privilege('public.patients_id_seq','USAGE') AS seq_usage,
    has_sequence_privilege('public.patients_id_seq','SELECT') AS seq_select,
    has_sequence_privilege('public.patients_id_seq','UPDATE') AS seq_update,
    has_sequence_privilege('public.patient_number_seq','USAGE') AS number_usage,
    has_sequence_privilege('public.patient_number_seq','SELECT') AS number_select,
    has_sequence_privilege('public.patient_number_seq','UPDATE') AS number_update`)).rows[0];
  expect(targetCapabilities.current_role===fixture.target.identity.owner).toBe(true);
  expect(targetCapabilities.isolation==='read committed' && targetCapabilities.default_isolation==='read committed').toBe(true);
  expect(['can_connect','can_create','can_insert','can_select','seq_usage','seq_select','seq_update','number_usage','number_select','number_update'].every(key=>targetCapabilities[key]===true)).toBe(true);
  await fixture.target.pool.query("SELECT setval('patients_id_seq',100000,$1)",[called]);
  await fixture.target.pool.query("SELECT setval('patient_number_seq',200000,$1)",[called]);
}

const patients = async (pool:Pool) => (await pool.query('SELECT id::text,patient_number,full_name FROM patients ORDER BY id')).rows;
const dbIdentity = async (pool:Pool) => (await pool.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()')).rows[0];
async function dataDigest(pool:Pool) {
  const names=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows as {tablename:string}[];
  const hash=createHash('sha256');
  for (const {tablename} of names) {
    const quoted=`"${tablename.replaceAll('"','""')}"`;
    const rows=(await pool.query(`SELECT to_jsonb(t)::text AS value FROM ${quoted} t ORDER BY to_jsonb(t)::text`)).rows;
    hash.update(JSON.stringify([tablename,rows]));
  }
  return hash.digest('hex');
}

it.each([
  {outcome:'success',called:false}, {outcome:'success',called:true},
  {outcome:'failure',called:false}, {outcome:'failure',called:true},
] as const)('preserves existing sequence high-water after $outcome with is_called=$called',async ({outcome,called})=>{
  const fixture = await ownedPair();
  try {
    await prepare(fixture,called);
    const archive = await makeArchive(fixture.source.pool,outcome==='failure');
    const archivePath = path.join(fixture.directory,'synthetic-archive.tar.gz'); await writeFile(archivePath,archive);
    const stage=path.join(fixture.directory,'stage'), markerPath=path.join(stage,'synthetic-stage-marker');
    const stageMarker=Buffer.from('synthetic-sequence-stage-retained');
    await mkdir(stage,{recursive:true}); await writeFile(markerPath,stageMarker);
    const beforeRows = await patients(fixture.target.pool), sourceRows = await patients(fixture.source.pool);
    const beforeData = await dataDigest(fixture.target.pool);
    const before = await sequence(fixture.target.pool,'patients_id_seq'), beforeNumber = await sequence(fixture.target.pool,'patient_number_seq');
    expect(before.last_value==='100000' && before.is_called===called).toBe(true);
    const result = await stagedRestore({archivePath,targetUrl:fixture.target.url.toString(),stagingDir:stage,allowNonEmptyTarget:true});
    const knownRefusal=knownNonEmptyRefusal(result);
    const lateFailure=outcome==='failure' && knownLateDuplicate(result);
    const after = await sequence(fixture.target.pool,'patients_id_seq'), afterNumber = await sequence(fixture.target.pool,'patient_number_seq');
    if (lateFailure) console.log('SYNTHETIC_LATE_DUPLICATE_REACHED');
    console.log(`SYNTHETIC_ID_SEQUENCE_${change(before,after)}`);
    console.log(`SYNTHETIC_PATIENT_SEQUENCE_${change(beforeNumber,afterNumber)}`);
    if (outcome==='failure') expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.readyForCutover).toBe(false);
      expect(sha(Buffer.from(JSON.stringify(await patients(fixture.target.pool))))===sha(Buffer.from(JSON.stringify(beforeRows)))).toBe(true);
      expect(await dataDigest(fixture.target.pool)===beforeData).toBe(true);
    } else {
      expect((await fixture.target.pool.query('SELECT count(*)::int AS n FROM patients WHERE id IN (300,75000)')).rows[0].n).toBe(2);
      const allPatients=await patients(fixture.target.pool);
      const target=allPatients.filter(row=>row.id==='300');
      const restored=allPatients.filter(row=>row.id==='75000');
      expect(sha(Buffer.from(JSON.stringify(target)))===sha(Buffer.from(JSON.stringify(beforeRows)))).toBe(true);
      expect(sha(Buffer.from(JSON.stringify(restored)))===sha(Buffer.from(JSON.stringify(sourceRows)))).toBe(true);
    }
    // A failed isolated replay must not change value or is_called. On success,
    // do not decide whether a gap is acceptable: report state changes without
    // numbers and independently forbid regression of either next candidate.
    if (!result.ok) {
      expect(same(before,after),'synthetic id sequence value or is_called changed after rollback').toBe(true);
      expect(same(beforeNumber,afterNumber),'synthetic patient number sequence value or is_called changed after rollback').toBe(true);
    } else {
      if (!same(before,after)) console.log('SYNTHETIC_ID_SEQUENCE_STATE_CHANGED_AFTER_SUCCESS');
      if (!same(beforeNumber,afterNumber)) console.log('SYNTHETIC_PATIENT_SEQUENCE_STATE_CHANGED_AFTER_SUCCESS');
    }
    expect(next(after)>=next(before),'synthetic id sequence next candidate regressed').toBe(true);
    expect(next(afterNumber)>=next(beforeNumber),'synthetic patient sequence next candidate regressed').toBe(true);
    expect(sha(Buffer.from(JSON.stringify(await patients(fixture.source.pool))))===sha(Buffer.from(JSON.stringify(sourceRows)))).toBe(true);
    expect(sha(await readFile(archivePath))===sha(archive)).toBe(true);
    expect(sha(await readFile(markerPath))===sha(stageMarker)).toBe(true);
    const identity=await dbIdentity(fixture.target.pool);
    expect(identity.oid===fixture.target.identity.oid && identity.owner===fixture.target.identity.owner).toBe(true);
    if (knownRefusal) {
      console.log('SYNTHETIC_KNOWN_NONEMPTY_REFUSAL_STATE_PRESERVED');
      throw new Error(outcome==='failure'?'SYNTHETIC_LATE_ROLLBACK_NOT_EXERCISED':'SYNTHETIC_VALID_REPLAY_NOT_EXERCISED');
    }
    else if (lateFailure) console.log('SYNTHETIC_LATE_DUPLICATE_REACHED_STATE_PRESERVED');
    else if (!result.ok) throw new Error('SYNTHETIC_REPLAY_FAILURE_UNCLASSIFIED');
  } finally { await fixture.close(); }
},180_000);

it('preserves a nonempty target when the existing guard refuses replay',async()=>{
  const fixture=await ownedPair();
  try {
    await prepare(fixture,false);
    const archive=await makeArchive(fixture.source.pool,false);
    const archivePath=path.join(fixture.directory,'synthetic-refusal.tar.gz'); await writeFile(archivePath,archive);
    const stage=path.join(fixture.directory,'refusal-stage'), markerPath=path.join(stage,'synthetic-stage-marker');
    const stageMarker=Buffer.from('synthetic-refusal-stage-retained');
    await mkdir(stage,{recursive:true}); await writeFile(markerPath,stageMarker);
    const beforeData=await dataDigest(fixture.target.pool), beforeSource=await patients(fixture.source.pool);
    const beforeSeq=await sequence(fixture.target.pool,'patients_id_seq'), beforeNumber=await sequence(fixture.target.pool,'patient_number_seq');
    const result=await stagedRestore({archivePath,targetUrl:fixture.target.url.toString(),stagingDir:stage,allowNonEmptyTarget:false});
    expect(knownNonEmptyRefusal(result)).toBe(true);
    expect(await dataDigest(fixture.target.pool)===beforeData).toBe(true);
    expect(same(await sequence(fixture.target.pool,'patients_id_seq'),beforeSeq)).toBe(true);
    expect(same(await sequence(fixture.target.pool,'patient_number_seq'),beforeNumber)).toBe(true);
    expect(sha(Buffer.from(JSON.stringify(await patients(fixture.source.pool))))===sha(Buffer.from(JSON.stringify(beforeSource)))).toBe(true);
    expect(sha(await readFile(archivePath))===sha(archive)).toBe(true);
    expect(sha(await readFile(markerPath))===sha(stageMarker)).toBe(true);
    const identity=await dbIdentity(fixture.target.pool);
    expect(identity.oid===fixture.target.identity.oid && identity.owner===fixture.target.identity.owner).toBe(true);
  } finally { await fixture.close(); }
},180_000);

it('does not regress a concurrently allocated sequence value during replay',async()=>{
  const fixture=await ownedPair();
  const blocker = new Client({connectionString:fixture.target.url.toString(),ssl:false});
  const allocator = new Client({connectionString:fixture.target.url.toString(),ssl:false});
  let held=false;
  try {
    await prepare(fixture,true);
    // Only this freshly created, identity-checked synthetic DB gets a timeout;
    // it bounds a stuck replay connection without changing any product setting.
    const adminIdentity=(await fixture.admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[fixture.target.name])).rows[0];
    expect(adminIdentity?.oid===fixture.target.identity.oid && adminIdentity?.owner===fixture.target.identity.owner).toBe(true);
    await fixture.admin.query(`ALTER DATABASE "${fixture.target.name}" SET statement_timeout = '75s'`);
    const archive=await makeArchive(fixture.source.pool,false);
    const archivePath=path.join(fixture.directory,'synthetic-concurrent.tar.gz'); await writeFile(archivePath,archive);
    const stage=path.join(fixture.directory,'concurrent-stage'), markerPath=path.join(stage,'synthetic-stage-marker');
    const stageMarker=Buffer.from('synthetic-concurrent-stage-retained');
    await mkdir(stage,{recursive:true}); await writeFile(markerPath,stageMarker);
    // Only the synthetic restored row waits; the test controls this lock and
    // retains the helper trigger as evidence in its newly created database.
    await fixture.target.pool.query(`CREATE FUNCTION synthetic_pause_replay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=75000 THEN PERFORM pg_advisory_xact_lock(473019::bigint); END IF; RETURN NEW; END $$`);
    await fixture.target.pool.query('CREATE TRIGGER synthetic_pause_replay BEFORE INSERT ON patients FOR EACH ROW EXECUTE FUNCTION synthetic_pause_replay()');
    const config=(await fixture.target.pool.query("SELECT seqincrement::text AS increment,seqcache::text AS cache,seqcycle AS cycle FROM pg_sequence WHERE seqrelid='public.patients_id_seq'::regclass")).rows[0];
    expect(config?.increment==='1' && config?.cache==='1' && config?.cycle===false).toBe(true);
    const beforeData=await dataDigest(fixture.target.pool), beforeSource=await patients(fixture.source.pool);
    const originalTarget=await patients(fixture.target.pool);
    const beforeSeq=await sequence(fixture.target.pool,'patients_id_seq'), beforeNumber=await sequence(fixture.target.pool,'patient_number_seq');
    await blocker.connect(); await allocator.connect();
    for (const client of [blocker,allocator]) {
      const identity=(await client.query("SELECT oid::text,datdba::text AS owner,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS current_role FROM pg_database WHERE datname=current_database()")).rows[0];
      expect(identity.oid===fixture.target.identity.oid && identity.owner===fixture.target.identity.owner && identity.current_role===fixture.target.identity.owner).toBe(true);
    }
    await blocker.query('SELECT pg_advisory_lock(473019::bigint)'); held=true;
    const restore = stagedRestore({archivePath,targetUrl:fixture.target.url.toString(),stagingDir:stage,allowNonEmptyTarget:true})
      .then(result=>({kind:'returned' as const,result}),()=>({kind:'thrown' as const}));
    let completed=false;
    void restore.then(()=>{completed=true;},()=>{completed=true;});
    const barrierDeadline=Date.now()+30000;
    try {
      let reached=false;
      for (;;) {
        const waiting=(await fixture.target.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=0 AND objid=473019 AND NOT granted) AS waiting")).rows[0].waiting;
        if (waiting) { reached=true; break; }
        if (completed) break;
        if (Date.now()>barrierDeadline) throw new Error('Synthetic replay did not reach concurrency barrier');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if (!reached) {
        const observation=await restore;
        expect(await dataDigest(fixture.target.pool)===beforeData).toBe(true);
        expect(same(await sequence(fixture.target.pool,'patients_id_seq'),beforeSeq)).toBe(true);
        expect(same(await sequence(fixture.target.pool,'patient_number_seq'),beforeNumber)).toBe(true);
        expect(sha(Buffer.from(JSON.stringify(await patients(fixture.source.pool))))===sha(Buffer.from(JSON.stringify(beforeSource)))).toBe(true);
        expect(sha(await readFile(archivePath))===sha(archive)).toBe(true);
        expect(sha(await readFile(markerPath))===sha(stageMarker)).toBe(true);
        const identity=await dbIdentity(fixture.target.pool);
        expect(identity.oid===fixture.target.identity.oid && identity.owner===fixture.target.identity.owner).toBe(true);
        if (observation.kind==='returned' && knownNonEmptyRefusal(observation.result)) {
          console.log('SYNTHETIC_KNOWN_NONEMPTY_REFUSAL_BEFORE_CONCURRENCY_BARRIER');
          return;
        }
        throw new Error('SYNTHETIC_EARLY_REPLAY_OUTCOME_UNCLASSIFIED');
      }
      // A transactional fix may hold an exclusive sequence lock and correctly
      // block nextval. Start it asynchronously and release the replay barrier
      // once it has either completed or demonstrably waits for that sequence.
      const allocate=allocator.query("SELECT nextval('patients_id_seq')::text AS value")
        .then(result=>({kind:'value' as const,value:result.rows[0].value as string}),()=>({kind:'error' as const}));
      let allocationDone=false;
      void allocate.then(()=>{allocationDone=true;});
      const allocationDeadline=Date.now()+30000;
      while (!allocationDone) {
        const waiting=(await fixture.target.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='relation' AND relation='public.patients_id_seq'::regclass AND NOT granted) AS waiting")).rows[0].waiting;
        if (waiting) { console.log('SYNTHETIC_ALLOCATION_WAITS_FOR_SEQUENCE'); break; }
        if (Date.now()>allocationDeadline) throw new Error('SYNTHETIC_ALLOCATION_WAIT_UNCLASSIFIED');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      await blocker.query('SELECT pg_advisory_unlock(473019::bigint)'); held=false;
      const [allocation,observation]=await deadline(Promise.all([allocate,restore]),'SYNTHETIC_CONCURRENT_COMPLETION_TIMEOUT',40000);
      if (allocation.kind==='error') throw new Error('SYNTHETIC_ALLOCATION_ERROR_UNCLASSIFIED');
      const allocated=allocation.value;
      if (observation.kind==='thrown') throw new Error('SYNTHETIC_CONCURRENT_REPLAY_EXCEPTION_UNCLASSIFIED');
      const result=observation.result;
      if (result.ok) {
        const all=await patients(fixture.target.pool);
        expect(sha(Buffer.from(JSON.stringify(all.filter(row=>row.id==='300'))))===sha(Buffer.from(JSON.stringify(originalTarget)))).toBe(true);
        expect(sha(Buffer.from(JSON.stringify(all.filter(row=>row.id==='75000'))))===sha(Buffer.from(JSON.stringify(beforeSource)))).toBe(true);
        console.log('SYNTHETIC_CONCURRENT_REPLAY_SUCCEEDED');
      } else {
        expect(result.readyForCutover).toBe(false);
        expect(await dataDigest(fixture.target.pool)===beforeData).toBe(true);
      }
      const afterSeq=await sequence(fixture.target.pool,'patients_id_seq');
      console.log(next(afterSeq)>BigInt(allocated)?'SYNTHETIC_CONCURRENT_SEQUENCE_NOT_REGRESSED':'SYNTHETIC_CONCURRENT_SEQUENCE_REGRESSED');
      expect(next(afterSeq)>BigInt(allocated)).toBe(true);
      if (!result.ok) expect(same(await sequence(fixture.target.pool,'patient_number_seq'),beforeNumber)).toBe(true);
      expect(sha(Buffer.from(JSON.stringify(await patients(fixture.source.pool))))===sha(Buffer.from(JSON.stringify(beforeSource)))).toBe(true);
      expect(sha(await readFile(archivePath))===sha(archive)).toBe(true);
      expect(sha(await readFile(markerPath))===sha(stageMarker)).toBe(true);
      const identity=await dbIdentity(fixture.target.pool);
      expect(identity.oid===fixture.target.identity.oid && identity.owner===fixture.target.identity.owner).toBe(true);
      if (!result.ok && knownNonEmptyRefusal(result)) console.log('SYNTHETIC_KNOWN_NONEMPTY_REFUSAL_AFTER_CONCURRENCY_BARRIER');
      else if (!result.ok) throw new Error('SYNTHETIC_CONCURRENT_REPLAY_FAILURE_UNCLASSIFIED');
    } finally {
      if(held){await blocker.query('SELECT pg_advisory_unlock(473019::bigint)').catch(()=>{}); held=false;}
      await restore.catch(()=>{});
    }
  } finally { await blocker.end().catch(()=>{}); await allocator.end().catch(()=>{}); await fixture.close(); }
},180_000);
