import { assertNoPrescriptionIssuanceHistory, ProtectedPrescriptionHistoryError } from '../../lib/clinic-reset';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sessionCredentialVersion } from '../../lib/auth';
import { issuePrescriptionTransaction, type IssuanceContext } from '../../lib/prescription-issuance';
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from './_setup';
import { prescriptionHistoryProtectionCases } from '../helpers/prescription-history-protection-cases';
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import('../../lib/db');
beforeAll(async () => { await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema(); });
afterAll(async () => { await db.resetPoolForTesting(); });
prescriptionHistoryProtectionCases(db);

// Real PostgreSQL lock races. Neither writer nor issuer persistence is mocked.
// Local runs remain subject to the repository's owned-PG resource/target guard.
// The shared cases initialize one synthetic session secret before creating actors.
afterAll(() => { vi.unstubAllEnvs(); });
const query = (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function setupIssuanceRace() {
 const username = `rx-race-${randomUUID()}`;
 const { rows: [doctor] } = await query("INSERT INTO parties(name,kind) VALUES('Synthetic race doctor','doctor') RETURNING id");
 const { rows: [user] } = await query("INSERT INTO users(username,display_name,password_hash,role,is_active,party_id,permissions) VALUES($1,'Synthetic race clinician','synthetic-hash','admin',true,$2,'{\"canViewAllPatients\":true}') RETURNING id", [username,doctor.id]);
 const { rows: [source] } = await query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic race source') RETURNING id", [`S-${randomUUID()}`]);
 const { rows: [target] } = await query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic race target') RETURNING id", [`T-${randomUUID()}`]);
 const { rows: [visit] } = await query("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'Synthetic race visit',$2) RETURNING id", [source.id,doctor.id]);
 const draft = {patientId:source.id as number,visitId:visit.id as number,prescribingDoctorPartyId:doctor.id as number,prescribingDoctorName:'Untrusted label',diagnosis:'',notes:'',instructionsLang:'both' as const,
  items:[{name:'SyntheticRx',dose:'reviewed',form:'tablet',frequency:'reviewed',duration:'reviewed',instructions:'Synthetic saved instruction',instructionsEn:'',selection:{id:'manual' as const,amount:'1 tablet',confirmed:true}}]};
 return {source:source.id as number,target:target.id as number,visit:visit.id as number,draft,key:randomUUID(),session:{userId:user.id as number,username,role:'admin',expiresAt:Date.now()+60000,credentialVersion:sessionCredentialVersion('synthetic-hash')}};
}
type Race = Awaited<ReturnType<typeof setupIssuanceRace>>;
type Writer = 'merge' | 'delete' | 'relink';
const issue = async ({persist}:IssuanceContext) => NextResponse.json(await persist(),{status:201});
async function write(kind: Writer, race: Race) {
 if(kind==='merge') return db.mergeDuplicatePatient(race.source,race.target,{actor:race.session.username});
 if(kind==='delete') return db.deleteVisit(race.visit,{session:race.session,patientId:race.source});
 return db.linkVisitToPatient(race.visit,race.target);
}
async function waitForActualWriterLock(kind: Writer) {
 const table=kind==='merge'||kind==='delete'?'patients':'visits', deadline=Date.now()+5000;
 while(Date.now()<deadline) {
  const {rows:[row]}=await query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE $1) AS blocked",[`%FROM ${table}%FOR ${kind==='delete'?'NO KEY UPDATE':'UPDATE'}%`]);
  if(row.blocked) return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw new Error(`No actual ${kind} PostgreSQL lock wait observed`);
}
it.each<Writer>(['merge','delete','relink'])('issuance-first holds scope locks; %s waits then refuses committed history',async kind=>{
 const race=await setupIssuanceRace(),entered=gate(),release=gate();
 const issuance=issuePrescriptionTransaction(race,async context=>{const saved=await context.persist();entered.release();await release.promise;return NextResponse.json(saved,{status:201});});
 await Promise.race([entered.promise,issuance.then(response=>{throw new Error(`Issuance failed before persist gate: ${response.status}`);})]);
 const writer=write(kind,race); let observationError:unknown;
 try{await waitForActualWriterLock(kind);}catch(error){observationError=error;}finally{release.release();}
 const [issued,result]=await Promise.all([issuance,writer]); if(observationError)throw observationError;
 expect(issued.status).toBe(201); expect(result).toMatchObject({ok:false});
 if(kind==='merge')expect(result).toMatchObject({reason:'source_has_prescription_history'});
 if(kind==='delete')expect(result).toMatchObject({reason:'has_prescription_history'});
 const saved=await issued.json();
 expect((await query('SELECT patient_id,visit_id FROM prescriptions WHERE id=$1',[saved.id])).rows).toEqual([{patient_id:race.source,visit_id:race.visit}]);
 expect((await query('SELECT patient_id,visit_id,prescription_id FROM prescription_issuance_commands WHERE command_key=$1',[race.key])).rows).toEqual([{patient_id:race.source,visit_id:race.visit,prescription_id:saved.id}]);
 expect((await query('SELECT patient_id FROM visits WHERE id=$1',[race.visit])).rows).toEqual([{patient_id:race.source}]);
 expect((await query("SELECT count(*)::int AS n FROM audit_log WHERE action='prescription.create' AND actor=$1",[race.session.username])).rows[0].n).toBe(1);
});
it.each<Writer>(['merge','delete','relink'])('writer-first scope lock makes issuance fail NOWAIT; clean %s still succeeds after release',async kind=>{
 const race=await setupIssuanceRace(),blocker=await db.getPool().connect();
 try {
  await blocker.query('BEGIN');
  await blocker.query(`SELECT id FROM ${kind==='merge'?'patients':'visits'} WHERE id=$1 FOR UPDATE`,[kind==='merge'?race.source:race.visit]);
  const response=await issuePrescriptionTransaction(race,issue);
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({retrySameCommand:true});
  expect((await query('SELECT id FROM prescriptions WHERE patient_id=$1',[race.source])).rows).toEqual([]);
  expect((await query('SELECT command_key FROM prescription_issuance_commands WHERE command_key=$1',[race.key])).rows).toEqual([]);
  expect((await query("SELECT id FROM audit_log WHERE action='prescription.create' AND actor=$1",[race.session.username])).rows).toEqual([]);
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 expect(await write(kind,race)).toMatchObject({ok:true});
});

it('reset history fence waits for issuance then refuses without losing its receipt', async () => {
 const race=await setupIssuanceRace(),entered=gate(),release=gate();
 const issuance=issuePrescriptionTransaction(race,async context=>{const saved=await context.persist();entered.release();await release.promise;return NextResponse.json(saved,{status:201});});
 await Promise.race([entered.promise,issuance.then(response=>{throw new Error(`Issuance failed before reset gate: ${response.status}`);})]);
 const client=await db.getPool().connect();await client.query('BEGIN');
 const reset=assertNoPrescriptionIssuanceHistory(client).then(()=>null,error=>error);
 try {
  let waiting=false;
  for(let i=0;i<100;i++) {
   waiting=(await query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query='LOCK TABLE prescription_issuance_commands IN EXCLUSIVE MODE') AS waiting")).rows[0].waiting;
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(waiting).toBe(true);
 } finally {release.release();}
 try {
  expect((await issuance).status).toBe(201);
  expect(await reset).toBeInstanceOf(ProtectedPrescriptionHistoryError);
  expect((await query('SELECT prescription_id FROM prescription_issuance_commands WHERE command_key=$1',[race.key])).rows[0].prescription_id).toBeGreaterThan(0);
 } finally {await client.query('ROLLBACK');client.release();}
});
