import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const transport = vi.hoisted(() => ({ session: vi.fn() }));
// Keep the real DB and patient-access implementations together. The current DB
// imports patient-access; a partial importOriginal DB mock captured the unmocked
// DB through that cycle and accidentally tested a different pool.
vi.stubEnv('USE_LOCAL_DB', 'true');
vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('RAILWAY_PROJECT_ID', '');
vi.mock('../lib/session', async original => ({ ...await original<typeof import('../lib/session')>(), requireSession: transport.session }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
import { sessionCredentialVersion } from '../lib/auth';
import * as db from '../lib/db';
import { POST } from '../app/api/prescriptions/route';
let patientId: number, visitId: number, doctorId: number;
beforeAll(async () => {
 vi.stubEnv('SESSION_SECRET', 'synthetic-test-only-secret-more-than-32-characters');
 await db.ensureSchema();
 const query = db.getPool().query.bind(db.getPool());
 doctorId = (await query("INSERT INTO parties(name,kind) VALUES('Synthetic Doctor','doctor') RETURNING id")).rows[0].id;
 const username = `synthetic-rx-${randomUUID()}`;
 const userId = (await query("INSERT INTO users(username,display_name,password_hash,role,party_id,permissions) VALUES($1,'Synthetic','synthetic-password-hash','doctor',$2,$3) RETURNING id",[username,doctorId,JSON.stringify({canViewAllPatients:true})])).rows[0].id;
 patientId = (await query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'Synthetic Rx patient',$2) RETURNING id",[randomUUID(),doctorId])).rows[0].id;
 visitId = (await query("INSERT INTO visits(patient_name,patient_id,doctor_id) VALUES('Synthetic Rx patient',$1,$2) RETURNING id",[patientId,doctorId])).rows[0].id;
 transport.session.mockImplementation(async () => ({userId,username,role:'doctor',expiresAt:Date.now()+60000,credentialVersion:sessionCredentialVersion('synthetic-password-hash')}));
},60000);
afterAll(async () => { await db.resetPoolForTesting(); vi.unstubAllEnvs(); });
it('two identical HTTP issuance commands resolve to one Rx and one atomic audit', async () => {
 const body = { commandKey:randomUUID(),patientId,visitId,prescribingDoctorPartyId:doctorId,diagnosis:'',notes:'',instructionsLang:'both',items:[{name:'SyntheticRx',dose:'fixture strength',form:'tablet',frequency:'fixture',duration:'fixture',instructions:'محفوظ',instructionsEn:'saved',selection:{id:'manual',amount:'fixture amount',confirmed:true}}] };
 const request = () => new Request('http://localhost/api/prescriptions',{method:'POST',body:JSON.stringify(body)});
 const a=await POST(request()),b=await POST(request());
 expect(a.status,await a.clone().text()).toBe(201);expect(b.status,await b.clone().text()).toBe(201);
 const first=await a.json(),second=await b.json();expect(second.id).toBe(first.id);expect(second.replayed).toBe(true);
 expect((await db.getPool().query('SELECT count(*)::int n FROM prescriptions WHERE patient_id=$1',[patientId])).rows[0]).toEqual({n:1});
 expect((await db.getPool().query("SELECT count(*)::int n FROM audit_log WHERE action='prescription.create' AND entity_id=$1",[String(first.id)])).rows[0]).toEqual({n:1});
});

it.each([null, [], true, 'synthetic', 7])('rejects non-object JSON %j without issuing', async body => {
 const before=(await db.getPool().query('SELECT count(*)::int n FROM prescription_issuance_commands')).rows;
 const response=await POST(new Request('http://localhost/api/prescriptions',{method:'POST',body:JSON.stringify(body)}));
 expect(response.status).toBe(400);
 expect((await db.getPool().query('SELECT count(*)::int n FROM prescription_issuance_commands')).rows).toEqual(before);
});
