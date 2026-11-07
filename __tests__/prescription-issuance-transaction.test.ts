import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { NextResponse } from 'next/server';
const fixture = vi.hoisted(() => ({ query: vi.fn(), ensureSchema: vi.fn(), commitLost: false, auditFails: false, logs: [] as string[] }));
vi.mock('../lib/db', async original => ({ ...await original<typeof import('../lib/db')>(), ensureSchema: fixture.ensureSchema, getPool: () => ({ query: fixture.query, connect: async () => ({ query: fixture.query, release: () => {} }) }) }));
import { issuePrescriptionTransaction, recoverPrescriptionCommand, type IssuanceContext } from '../lib/prescription-issuance';
import { PRESCRIPTION_ISSUANCE_SQL } from '../lib/prescription-issuance-schema';
import { sessionCredentialVersion } from '../lib/auth';
let db: PGlite;
const key = '11111111-1111-4111-8111-111111111111';
const draft = { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5, prescribingDoctorName: 'Untrusted outer label', diagnosis: '', notes: '', instructionsLang: 'both' as const, items: [{ name: 'SyntheticRx', dose: '500mg', form: 'tablet', frequency: 'fixture', duration: 'fixture', instructions: 'محفوظ', instructionsEn: 'saved', selection: { id: 'manual' as const, amount: '1 tablet', confirmed: true } }] };
const session = () => ({ userId: 3, username: 'synthetic', role: 'doctor' as const, expiresAt: Date.now() + 60000, credentialVersion: sessionCredentialVersion('synthetic-password-hash') });
const issue = async ({ persist }: IssuanceContext) => NextResponse.json(await persist(), { status: 201 });
beforeEach(async () => {
 fixture.ensureSchema.mockReset().mockResolvedValue(undefined);
 vi.stubEnv('SESSION_SECRET', 'synthetic-test-only-secret-more-than-32-characters'); db = new PGlite();
 await db.exec(`CREATE TABLE users(id INT PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INT,permissions TEXT);
 CREATE TABLE parties(id INT PRIMARY KEY,kind TEXT,is_active BOOLEAN,name TEXT);
 CREATE TABLE patients(id INT PRIMARY KEY,medical_alert TEXT,primary_doctor_id INT);
 CREATE TABLE visits(id INT PRIMARY KEY,patient_id INT,doctor_id INT);
 CREATE TABLE treatment_plans(id INT,patient_id INT,primary_doctor_id INT,status TEXT);
 CREATE TABLE planned_visits(id INT,patient_id INT,doctor_id INT);
 CREATE TABLE appointments(id INT,patient_id INT,doctor_id INT);
 CREATE TABLE patient_referrals(id INT,patient_id INT,kind TEXT,to_party_id INT,workflow_state TEXT);
 CREATE TABLE prescriptions(id SERIAL PRIMARY KEY,patient_id INT,visit_id INT,diagnosis TEXT,notes TEXT,instructions_lang TEXT,items JSONB,status TEXT DEFAULT 'active',void_reason TEXT,voided_by TEXT,voided_at TIMESTAMPTZ,created_by TEXT,doctor_party_id INT,prescribing_doctor_name TEXT,prescribing_doctor_party_id INT,created_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE audit_log(id SERIAL PRIMARY KEY,action TEXT,entity TEXT,entity_id TEXT,summary TEXT,details JSONB,actor TEXT,actor_role TEXT,source_ip TEXT,user_agent TEXT);
 ${PRESCRIPTION_ISSUANCE_SQL}`);
 fixture.query.mockImplementation(async (sql: string, values?: unknown[]) => {
  fixture.logs.push(sql);
  if (fixture.auditFails && sql.includes('INSERT INTO audit_log')) throw new Error('Synthetic audit unavailable');
  const result = await db.query(sql, values);
  if (sql === 'COMMIT' && fixture.commitLost) { fixture.commitLost = false; throw new Error('Synthetic lost commit reply'); }
  return result;
 });
}, 30000);
afterEach(async () => { await db?.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
 fixture.commitLost = false; fixture.auditFails = false; fixture.logs = [];
 await db.exec(`INSERT INTO users VALUES(3,'synthetic','Synthetic','synthetic-password-hash','doctor',true,5,'{"canViewAllPatients":true}');
 INSERT INTO parties VALUES(5,'doctor',true,'Original Doctor'); INSERT INTO patients VALUES(7,NULL,5); INSERT INTO visits VALUES(9,7,5);`);
});
const counts = async () => (await db.query<{ rx: number; commands: number; audits: number }>('SELECT (SELECT count(*)::int FROM prescriptions) rx,(SELECT count(*)::int FROM prescription_issuance_commands) commands,(SELECT count(*)::int FROM audit_log) audits')).rows[0];
it('commits Rx, receipt and audit together; replay returns same immutable snapshot after registry name change', async () => {
 const first = await issuePrescriptionTransaction({ session: session(), key, draft }, issue); expect(first.status).toBe(201); const saved = await first.json();
 await db.query("UPDATE parties SET name='Changed Doctor' WHERE id=5");
 const second = await issuePrescriptionTransaction({ session: session(), key, draft }, () => { throw new Error('Replay must skip issuance safety callback'); });
 expect(second.status).toBe(201); expect(await second.json()).toMatchObject({ id: saved.id, replayed: true, status: 'active' });
 expect(await counts()).toEqual({ rx: 1, commands: 1, audits: 1 });
 expect((await db.query('SELECT prescribing_doctor_name FROM prescriptions')).rows[0]).toEqual({ prescribing_doctor_name: 'Original Doctor' });
 const reserve = fixture.logs.findIndex(sql => sql.includes('INSERT INTO prescription_issuance_commands'));
 expect(fixture.logs.findIndex(sql => sql.includes('FROM users'))).toBeGreaterThan(reserve);
});
it('resolves uncertain COMMIT with same command, no duplicate or receipt deletion', async () => {
 fixture.commitLost = true; expect((await issuePrescriptionTransaction({ session: session(), key, draft }, issue)).status).toBe(503);
 expect((await issuePrescriptionTransaction({ session: session(), key, draft }, issue)).status).toBe(201);
 expect(await counts()).toEqual({ rx: 1, commands: 1, audits: 1 }); expect(fixture.logs.some(sql => /DELETE FROM prescription_issuance_commands/.test(sql))).toBe(false);
});
it('rolls back the entire issuance when audit insertion fails', async () => {
 fixture.auditFails = true; expect((await issuePrescriptionTransaction({ session: session(), key, draft }, issue)).status).toBe(503);
 expect(await counts()).toEqual({ rx: 0, commands: 0, audits: 0 });
});
it('rolls back warning preview reservation without consuming the command', async () => {
 expect((await issuePrescriptionTransaction({ session: session(), key, draft }, async () => NextResponse.json({ requiresAcknowledgement: true }))).status).toBe(200);
 expect(await counts()).toEqual({ rx: 0, commands: 0, audits: 0 });
 expect((await issuePrescriptionTransaction({ session: session(), key, draft }, issue)).status).toBe(201);
});
it.each(['is_active=false', "password_hash='changed'", "role='reception'", 'party_id=NULL'])('rejects fresh authority revocation before replay: %s', async change => {
 await issuePrescriptionTransaction({ session: session(), key, draft }, issue); await db.query(`UPDATE users SET ${change} WHERE id=3`);
 expect((await issuePrescriptionTransaction({ session: session(), key, draft }, issue)).status).toBe(403);
 expect(await counts()).toEqual({ rx: 1, commands: 1, audits: 1 });
});
it('refuses payload conflict without leaking stored IDs and returns current void state on authorized recovery', async () => {
 await issuePrescriptionTransaction({ session: session(), key, draft }, issue);
 const conflict = await issuePrescriptionTransaction({ session: session(), key, draft: { ...draft, notes: 'Changed' } }, issue); expect(conflict.status).toBe(409); expect(await conflict.json()).not.toHaveProperty('id');
 await db.query("UPDATE prescriptions SET status='void' WHERE patient_id=7");
 const response = await recoverPrescriptionCommand(session(), key, { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5 });
 expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'completed', status: 'void' });
});
it('treats absent recovery receipt as unknown and never issues', async () => {
 const response = await recoverPrescriptionCommand(session(), key, { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5 });
 expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ state: 'unknown' }); expect(await counts()).toEqual({ rx: 0, commands: 0, audits: 0 });
});

it('recovery performs no schema initialization, including when the receipt table is unavailable', async () => {
 const admitted = session();
 expect((await recoverPrescriptionCommand(admitted, key, { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5 })).status).toBe(202);
 expect(fixture.ensureSchema).not.toHaveBeenCalled();
 await db.query('ALTER TABLE prescription_issuance_commands RENAME TO synthetic_unavailable_commands');
 fixture.logs = [];
 expect((await recoverPrescriptionCommand(admitted, key, { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5 })).status).toBe(503);
 expect(fixture.ensureSchema).not.toHaveBeenCalled(); expect(fixture.logs.some(sql => /^(CREATE|ALTER|INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
});
it('denies replay after actual patient-scope witnesses and broad access are revoked', async () => {
 await issuePrescriptionTransaction({ session: session(), key, draft }, issue);
 await db.exec("UPDATE users SET permissions='{}'; UPDATE patients SET primary_doctor_id=NULL; UPDATE visits SET doctor_id=NULL;");
 const response = await issuePrescriptionTransaction({ session: session(), key, draft }, issue); expect(response.status).toBe(403); expect(await counts()).toEqual({ rx: 1, commands: 1, audits: 1 });
});

it.each(['doctor', 'admin'] as const)('refuses another doctor for legacy %s despite all-patient access, without reserving or writing', async role => {
 await db.exec("INSERT INTO parties VALUES(6,'doctor',true,'Selected Other Doctor');");
 await db.query('UPDATE users SET role=$1 WHERE id=3', [role]);
 const response = await issuePrescriptionTransaction({ session: { ...session(), role }, key, draft: { ...draft, prescribingDoctorPartyId: 6 } }, issue);
 expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'canonical_prescription_owner_unavailable' });
 expect(await counts()).toEqual({ rx: 0, commands: 0, audits: 0 });
 expect((await issuePrescriptionTransaction({ session: { ...session(), role }, key, draft }, issue)).status).toBe(201);
 expect(await counts()).toEqual({ rx: 1, commands: 1, audits: 1 });
});
it('denies cached replay and recovery after relinking to another doctor without exposing the saved ID', async () => {
 await issuePrescriptionTransaction({ session: session(), key, draft }, issue);
 await db.exec("INSERT INTO parties VALUES(6,'doctor',true,'Relinked Doctor'); UPDATE users SET party_id=6 WHERE id=3;");
 const replay = await issuePrescriptionTransaction({ session: session(), key, draft }, issue);
 const recovery = await recoverPrescriptionCommand(session(), key, { patientId: 7, visitId: 9, prescribingDoctorPartyId: 5 });
 for (const response of [replay, recovery]) { expect(response.status).toBe(403); expect(await response.json()).not.toHaveProperty('id'); }
 expect(await counts()).toEqual({ rx: 1, commands: 1, audits: 1 });
});

it.each(['INSERT INTO prescriptions', 'INSERT INTO audit_log', 'UPDATE prescription_issuance_commands'])('rolls back when session expires during awaited %s', async boundary => {
 const admitted=session();
 const originalQuery=fixture.query.getMockImplementation()!;
 const clock=vi.spyOn(Date,'now');
 fixture.query.mockImplementation(async (sql:string,values?:unknown[])=>{
  const result=await originalQuery(sql,values);
  if(sql.includes(boundary))clock.mockReturnValue(admitted.expiresAt);
  return result;
 });
 try {
  const response=await issuePrescriptionTransaction({session:admitted,key,draft},issue);
  expect(response.status).toBe(403);
  expect(await counts()).toEqual({rx:0,commands:0,audits:0});
  expect(fixture.logs).not.toContain('COMMIT');
  expect(fixture.logs).toContain('ROLLBACK');
 }finally{clock.mockRestore();}
});
