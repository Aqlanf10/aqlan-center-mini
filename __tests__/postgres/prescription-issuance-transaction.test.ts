import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { sessionCredentialVersion } from '../../lib/auth';
const transport = vi.hoisted(() => ({ pool: null as unknown as Pool, commitLost: false, auditFails: false, retiredDoseVersion: null as string|null }));
// Transport/schema bootstrap are replaced; one explicit semantic hook simulates
// reference retirement. Real SQL save/audit/session, clinician and patient
// authority logic run against the owned PostgreSQL18 DB.
vi.mock('../../lib/db', async original => ({ ...await original<typeof import('../../lib/db')>(), ensureSchema: async () => {}, getPool: () => ({
 query: (sql: string, values?: unknown[]) => transport.pool.query(sql, values),
 connect: async () => {
  const client = await transport.pool.connect();
  return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
   if (transport.auditFails && sql.includes('INSERT INTO audit_log')) throw new Error('Synthetic unavailable audit');
   const result = await client.query(sql, values);
   if (sql === 'COMMIT' && transport.commitLost) { transport.commitLost = false; throw new Error('Synthetic lost COMMIT response'); }
   return result;
  } };
 },
}) }));
vi.mock('../../lib/medication-dose-provenance', async original => { const actual=await original<typeof import('../../lib/medication-dose-provenance')>(); return {...actual,medicationDoseProvenanceProblem:(...args:Parameters<typeof actual.medicationDoseProvenanceProblem>)=>transport.retiredDoseVersion && (args[0] as {referenceVersion?:string})?.referenceVersion===transport.retiredDoseVersion?'Synthetic reference version retired':actual.medicationDoseProvenanceProblem(...args)}; });
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
import { issuePrescriptionTransaction, recoverPrescriptionCommand, type IssuanceContext } from '../../lib/prescription-issuance';
import { backupSqlLines } from '../../lib/db';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>, concurrent: Pool, directory: string;
const ownedPools: Pool[] = [];
let key: string;
let baselineCounts = {rx:0,commands:0,audits:0};
const draft = { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5, prescribingDoctorName: 'Untrusted outer label', diagnosis: '', notes: '', instructionsLang: 'both' as const, items: [{ name: 'SyntheticRx', dose: '500mg', form: 'tablet', frequency: 'fixture', duration: 'fixture', instructions: 'محفوظ', instructionsEn: 'saved', selection: { id: 'manual' as const, amount: '1 tablet', confirmed: true } }] };
const session = () => ({ userId: 3, username: 'synthetic', role: 'doctor', expiresAt: Date.now() + 3_600_000, credentialVersion: sessionCredentialVersion('synthetic-password-hash') });
const issue = async ({ persist }: IssuanceContext) => NextResponse.json(await persist(), { status: 201 });
const rawCounts = async (pool: Pool = transport.pool) => (await pool.query('SELECT (SELECT count(*)::int FROM prescriptions) rx,(SELECT count(*)::int FROM prescription_issuance_commands) commands,(SELECT count(*)::int FROM audit_log WHERE action=\'prescription.create\') audits')).rows[0];
const counts = async (pool: Pool = transport.pool) => { const current = await rawCounts(pool); return {rx:current.rx-baselineCounts.rx,commands:current.commands-baselineCounts.commands,audits:current.audits-baselineCounts.audits}; };
const financial = async () => (await fixture.source.query('SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM journal_manual) journals')).rows[0];
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function waitForBlockedCommand() {
 const deadline = Date.now() + 5000;
 while (Date.now() < deadline) {
  const { rows: [row] } = await fixture.source.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='synthetic-rx-race' AND wait_event_type='Lock' AND query LIKE '%prescription_issuance_commands%') AS blocked");
  if (row.blocked) return;
  await new Promise(resolve => setTimeout(resolve, 20));
 }
 throw new Error('No actual PostgreSQL command lock wait observed');
}
beforeAll(async () => {
 vi.stubEnv('SESSION_SECRET', 'synthetic-issuance-test-only-secret-at-least-32-characters');
 fixture = await openBackupTimestampFixture(process.env); directory = await mkdtemp(join(tmpdir(), 'rx-issuance-pg18-'));
 await migrate(fixture.source, { apply: true, files: await loadMigrationFiles() });
 concurrent = new Pool({ connectionString: fixture.source.options.connectionString!, ssl: false, max: 6, application_name: 'synthetic-rx-race', statement_timeout: 15000 });
 ownedPools.push(concurrent); transport.pool = concurrent;
 await fixture.source.query(`INSERT INTO parties(id,name,kind) VALUES(5,'Original Doctor','doctor');
 INSERT INTO users(id,username,display_name,password_hash,role,is_active,party_id,permissions) VALUES(3,'synthetic','Synthetic','synthetic-password-hash','doctor',true,5,'{"canViewAllPatients":true}'),(4,'other-synthetic','Other','other-password-hash','doctor',true,5,'{"canViewAllPatients":true}');
 INSERT INTO patients(id,patient_number,full_name,primary_doctor_id) VALUES(7,'SYNTHETIC-RX-7','Synthetic patient',5);
 INSERT INTO visits(id,patient_id,patient_name,doctor_id,status) VALUES(9,7,'Synthetic patient',5,'finished');`);
});
afterAll(async () => { for (const pool of ownedPools) await pool.end(); await fixture?.close(); if (directory) await rm(directory,{recursive:true,force:true}); vi.unstubAllEnvs(); });
beforeEach(async () => {
 transport.pool = concurrent; transport.commitLost = false; transport.auditFails = false; transport.retiredDoseVersion = null;
 // Retain immutable receipt history even in fixtures; each test owns a new key.
 key = randomUUID(); baselineCounts = await rawCounts();
 await fixture.source.query(`UPDATE users SET password_hash='synthetic-password-hash',role='doctor',is_active=true,party_id=5 WHERE id=3;
 UPDATE parties SET name='Original Doctor',is_active=true WHERE id=5;`);
});
it('two physical connections concurrently commit exactly one Rx, receipt and audit without financial effects', async () => {
 const entered = gate(), release = gate(); const beforeMoney = await financial();
 const first = issuePrescriptionTransaction({session:session(),key,draft}, async context => { const saved = await context.persist(); entered.release(); await release.promise; return NextResponse.json(saved,{status:201}); });
 await Promise.race([entered.promise, first.then(response => { throw new Error(`First issuance ended before barrier: ${response.status}`); })]);
 const second = issuePrescriptionTransaction({session:session(),key,draft}, () => { throw new Error('Concurrent replay must not issue'); });
 let observationError: unknown;
 try { await waitForBlockedCommand(); } catch (error) { observationError = error; } finally { release.release(); }
 const [a,b] = await Promise.all([first,second]); if (observationError) throw observationError; expect(a.status).toBe(201); expect(b.status).toBe(201);
 expect((await a.json()).id).toBe((await b.json()).id); expect(await counts()).toEqual({rx:1,commands:1,audits:1}); expect(await financial()).toEqual(beforeMoney);
});
it.each(["password_hash='revoked'", "role='reception'", 'party_id=NULL', 'is_active=false'])('rechecks fresh authority after a real uniqueness wait: %s', async change => {
 const blocker = await concurrent.connect(); let pending: Promise<NextResponse> | undefined; let observationError: unknown;
 try {
  await blocker.query('BEGIN');
  await blocker.query('INSERT INTO prescription_issuance_commands(command_key,actor_user_id,actor_username,patient_id,visit_id,payload_sha256) VALUES($1,3,\'synthetic\',7,9,$2)',[key,'a'.repeat(64)]);
  pending = issuePrescriptionTransaction({session:session(),key,draft},issue);
  await waitForBlockedCommand(); await fixture.source.query(`UPDATE users SET ${change} WHERE id=3`);
 } catch (error) { observationError = error; } finally { await blocker.query('ROLLBACK'); blocker.release(); }
 const response = await pending; if (observationError) throw observationError;
 expect(response?.status).toBe(403); expect(await counts()).toEqual({rx:0,commands:0,audits:0});
});
it.each(['patients','visits'])('NOWAIT refuses concurrent %s update without orphan rows', async table => {
 const blocker = await concurrent.connect();
 try {
  await blocker.query('BEGIN'); await blocker.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[table==='patients'?7:9]);
  const response = await issuePrescriptionTransaction({session:session(),key,draft},issue);
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({retrySameCommand:true});
  expect(await counts()).toEqual({rx:0,commands:0,audits:0});
 } finally { await blocker.query('ROLLBACK'); blocker.release(); }
 expect((await issuePrescriptionTransaction({session:session(),key,draft},issue)).status).toBe(201);
});
it('payload and cross-actor key conflicts disclose no original identifier', async () => {
 expect((await issuePrescriptionTransaction({session:session(),key,draft},issue)).status).toBe(201);
 for (const input of [{session:session(),key,draft:{...draft,notes:'changed'}},{session:{...session(),userId:4,username:'other-synthetic',credentialVersion:sessionCredentialVersion('other-password-hash')},key,draft}]) {
  const response = await issuePrescriptionTransaction(input,issue); expect(response.status).toBe(409); expect(await response.json()).not.toHaveProperty('id');
 }
 expect(await counts()).toEqual({rx:1,commands:1,audits:1});
});
it('audit failure rolls back all three records; retry of same key succeeds once', async () => {
 transport.auditFails=true; expect((await issuePrescriptionTransaction({session:session(),key,draft},issue)).status).toBe(503);
 expect(await counts()).toEqual({rx:0,commands:0,audits:0}); transport.auditFails=false;
 expect((await issuePrescriptionTransaction({session:session(),key,draft},issue)).status).toBe(201); expect(await counts()).toEqual({rx:1,commands:1,audits:1});
});
it('lost COMMIT response resolves to saved Rx and later void replay stays void', async () => {
 transport.commitLost=true; expect((await issuePrescriptionTransaction({session:session(),key,draft},issue)).status).toBe(503);
 const first = await issuePrescriptionTransaction({session:session(),key,draft},issue); expect(first.status).toBe(201); const saved = await first.json();
 await fixture.source.query("UPDATE prescriptions SET status='void',void_reason='Synthetic correction' WHERE id=$1",[saved.id]);
 const replay = await issuePrescriptionTransaction({session:session(),key,draft},issue); expect(await replay.json()).toMatchObject({id:saved.id,status:'void',replayed:true});
 const recovery=await recoverPrescriptionCommand(session(),key,{patientId:7,visitId:9,prescribingDoctorPartyId:5}); expect(await recovery.json()).toMatchObject({id:saved.id,status:'void',state:'completed'});
 expect(await counts()).toEqual({rx:1,commands:1,audits:1});
});
it('official SQL and full archive restore keep Rx, audit, receipt and same-command replay', async () => {
 const response=await issuePrescriptionTransaction({session:session(),key,draft},issue); expect(response.status).toBe(201); const saved=await response.json();
 const client=await fixture.source.connect(); let sql=''; const blocks:Uint8Array[]=[];
 try { for await(const line of backupSqlLines(client)) sql+=line; for await(const block of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No synthetic documents expected');}})) blocks.push(block); } finally { client.release(); }
 const sqlPath=join(directory,`${randomUUID()}.sql`),archivePath=join(directory,`${randomUUID()}.tar.gz`);
 await writeFile(sqlPath,sql); await writeFile(archivePath,gzipSync(Buffer.concat(blocks)));
 await migrate(fixture.sqlTarget,{apply:true,files:await loadMigrationFiles()});
 const restored=await promisify(execFile)(process.execPath,['scripts/restore.mjs',sqlPath],{env:{...process.env,DATABASE_URL:fixture.sqlTarget.options.connectionString!,SKIP_SEED:'true'}}); expect(restored.stdout).toContain('تمت الاستعادة');
 const archive=await stagedRestore({archivePath,targetUrl:fixture.archiveTarget.options.connectionString!,stagingDir:join(directory,'documents')}); expect(archive.errors).toEqual([]); expect(archive.readyForCutover).toBe(true);
 for(const pool of [fixture.sqlTarget,fixture.archiveTarget]) {
  transport.pool=pool; const replay=await issuePrescriptionTransaction({session:session(),key,draft},()=>{throw new Error('Restored command must replay');});
  expect(replay.status).toBe(201); expect(await replay.json()).toMatchObject({id:saved.id,replayed:true,status:'active'}); expect(await counts(pool)).toEqual({rx:1,commands:1,audits:1});
  for(const table of ['prescriptions','prescription_issuance_commands','audit_log']) expect((await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows).toEqual((await fixture.source.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows);
 }
},180_000);

it.each(['doctor', 'admin'])('legacy %s cannot select another doctor or retain a command reservation; self issuance remains valid', async role => {
 await fixture.source.query("INSERT INTO parties(id,name,kind) VALUES(6,'Other synthetic doctor','doctor') ON CONFLICT(id) DO NOTHING");
 await fixture.source.query('UPDATE users SET role=$1 WHERE id=3',[role]);
 const beforeMoney = await financial();
 const response = await issuePrescriptionTransaction({session:{...session(),role},key,draft:{...draft,prescribingDoctorPartyId:6}},issue);
 expect(response.status).toBe(403); expect(await response.json()).toMatchObject({code:'canonical_prescription_owner_unavailable'});
 expect(await counts()).toEqual({rx:0,commands:0,audits:0}); expect(await financial()).toEqual(beforeMoney);
 expect((await issuePrescriptionTransaction({session:{...session(),role},key,draft},issue)).status).toBe(201);
 expect(await counts()).toEqual({rx:1,commands:1,audits:1}); expect(await financial()).toEqual(beforeMoney);
});
it('fresh relink denies cached replay and recovery without leaking the saved prescription ID', async () => {
 await issuePrescriptionTransaction({session:session(),key,draft},issue);
 await fixture.source.query("INSERT INTO parties(id,name,kind) VALUES(6,'Other synthetic doctor','doctor') ON CONFLICT(id) DO NOTHING");
 await fixture.source.query('UPDATE users SET party_id=6 WHERE id=3');
 const replay=await issuePrescriptionTransaction({session:session(),key,draft},issue);
 const recovery=await recoverPrescriptionCommand(session(),key,{patientId:7,visitId:9,prescribingDoctorPartyId:5});
 for(const response of [replay,recovery]){expect(response.status).toBe(403);expect(await response.json()).not.toHaveProperty('id');}
 expect(await counts()).toEqual({rx:1,commands:1,audits:1});
});

it('catalogue disable blocks new issuance, not replay/recovery of immutable saved prescription', async () => {
 const entry = {id:randomUUID(),revision:1,enabled:true,name:'SyntheticRx',arabicName:'',form:'tablet',strength:'500mg',population:'adult',amount:'1 tablet',frequency:'fixture',duration:'fixture',instructionsAr:'',instructionsEn:'',indication:'Synthetic test only',cautions:'',sourceUrl:''};
 const selected = {...draft,items:draft.items.map(item=>({...item,selection:{...item.selection,catalog:{id:entry.id,revision:1}}}))};
 const store = async (enabled:boolean,revision:number) => transport.pool.query("INSERT INTO settings(key,value) VALUES('clinical.medication_catalog',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify({schemaVersion:1,entries:[{...entry,enabled,revision}]})]);
 await store(true,1);
 const issued=await issuePrescriptionTransaction({session:session(),key,draft:selected},issue);expect(issued.status).toBe(201);const saved=await issued.json();
 await store(false,2);
 const replay=await issuePrescriptionTransaction({session:session(),key,draft:selected},issue);expect(replay.status).toBe(201);expect(await replay.json()).toMatchObject({id:saved.id,replayed:true});
 const refused=await issuePrescriptionTransaction({session:session(),key:randomUUID(),draft:selected},issue);expect(refused.status).toBe(409);expect(await refused.json()).toMatchObject({code:'medication_catalog_changed'});
 expect(await counts()).toEqual({rx:1,commands:1,audits:1});
 const recovery=await recoverPrescriptionCommand(session(),key,{patientId:7,visitId:9,prescribingDoctorPartyId:5});expect(recovery.status).toBe(200);
});


it.each(['amoxicillin','ibuprofen'] as const)('stores %s dose snapshot, rejects tampering atomically, and replays an authorized historical reference without new clinical validation', async ingredient => {
 const ibu=ingredient==='ibuprofen';
 const {DOSE_REFERENCE_VERSION}=await import('../../lib/medication-dose-profiles');
 const {createCalculatedDoseProvenance,calculatedDoseFields}=await import('../../lib/medication-dose-provenance');
 const {checkPrescriptionDraft}=await import('../../lib/prescription');
 const baseInput={profileId:'amoxicillin-child-aapd-q8',referenceVersion:DOSE_REFERENCE_VERSION,indication:'Synthetic reviewed indication',ageMonths:60,ageVerified:true,weightKg:20,currentWeightVerified:true,selectedDose:30,administrationsPer24h:3,scheduleKind:'fixed-interval' as const,intervalHours:8,durationDays:5,reviewPlan:'Review synthetic patient',product:{name:'Synthetic suspension',ingredientId:'amoxicillin' as const,formulation:'single-ingredient' as const,labelUrl:'https://synthetic.invalid/label',kind:'oral-liquid' as const,strengthMg:250,perMl:5,measurementIncrementMl:0.1,minimumAgeMonths:4,labelVerified:true},otherSameIngredientMg24h:0,specialPopulationOrInteraction:false,antibioticIndicationReviewed:true};
 const input=ibu?{...baseInput,profileId:'ibuprofen-child-sdcep',selectedDose:150,scheduleKind:'times-per-day' as const,product:{...baseInput.product,ingredientId:'ibuprofen' as const,strengthMg:100,minimumAgeMonths:6,minimumIntervalHours:6,maxAdministrationsPer24h:3}}:baseInput;
 const doseReview=createCalculatedDoseProvenance(input)!;const {amount,...fields}=calculatedDoseFields(doseReview)!;
 const selected={...draft,items:[{...fields,selection:{id:ingredient,amount,confirmed:true,doseReview}}]};
 expect(doseReview.version).toBe(ibu?2:1);
 const tampered=structuredClone(selected);if(tampered.items[0].selection.doseReview.mode!=='calculated')throw Error();tampered.items[0].selection.doseReview.result.mgPerDose=999;
 const bad=await issuePrescriptionTransaction({session:session(),key:randomUUID(),draft:tampered},issue);expect(bad.status).toBe(409);expect(await counts()).toEqual({rx:0,commands:0,audits:0});
 const first=await issuePrescriptionTransaction({session:session(),key,draft:selected},issue);expect(first.status).toBe(201);const saved=await first.json();
 const stored=(await transport.pool.query('SELECT items FROM prescriptions WHERE id=$1',[saved.id])).rows[0].items;
 expect(typeof stored==='string'?JSON.parse(stored):stored).toEqual(selected.items);
 // Simulate retiring the immutable version from NEW prescribing admission only.
 transport.retiredDoseVersion=DOSE_REFERENCE_VERSION;
 expect(checkPrescriptionDraft(selected).ok).toBe(true);
 const replay=await issuePrescriptionTransaction({session:session(),key,draft:selected},()=>{throw Error('Must replay before current reference admission');});expect(replay.status).toBe(201);expect(await replay.json()).toMatchObject({id:saved.id,replayed:true});
 const fresh=await issuePrescriptionTransaction({session:session(),key:randomUUID(),draft:selected},issue);expect(fresh.status).toBe(409);
 const changed=structuredClone(selected);changed.items[0].duration='6 days';expect((await issuePrescriptionTransaction({session:session(),key,draft:changed},issue)).status).toBe(409);
 expect(await counts()).toEqual({rx:1,commands:1,audits:1});
 await fixture.source.query("UPDATE users SET is_active=false WHERE id=3");expect((await issuePrescriptionTransaction({session:session(),key,draft:selected},issue)).status).toBe(403);
});
