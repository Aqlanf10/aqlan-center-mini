import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
const transport = vi.hoisted(() => ({ query: vi.fn(), session: vi.fn() }));
vi.mock('../lib/db', async original => {
 const actual = await original<typeof import('../lib/db')>();
 const client = { query: transport.query, release: () => {} };
 return { ...actual, ensureSchema: async () => {}, getPool: () => ({ query: transport.query, connect: async () => client }),
  findUserByUsername: (username: string, connection?: import('../lib/db').DbClient) => actual.findUserByUsername(username, connection ?? client),
  savePrescription: (draft: import('../lib/prescription').PrescriptionDraft, actor: string, doctorId: number, connection?: import('../lib/db').DbClient) => actual.savePrescription(draft, actor, doctorId, connection ?? client),
  getParty: async () => ({ id: 5, name: 'Synthetic Doctor', kind: 'doctor', isActive: true }),
  getClinicalVisit: async () => ({ id: 9, patientId: 7 }), getPatient: async () => ({ id: 7, medicalAlert: null }),
 };
});
vi.mock('../lib/session', async original => ({ ...await original<typeof import('../lib/session')>(), requireSession: transport.session }));
import { sessionCredentialVersion } from '../lib/auth';
import { PRESCRIPTION_ISSUANCE_SQL } from '../lib/prescription-issuance-schema';
// Optional, read-only historical source module supports a real fail-before
// demonstration without modifying the baseline worktree or any live service.
const { POST } = await import(process.env.RX_POST_BASELINE_MODULE ?? '../app/api/prescriptions/route');
let db: PGlite;
beforeAll(async () => {
 vi.stubEnv('SESSION_SECRET', 'synthetic-test-only-secret-more-than-32-characters'); db = new PGlite();
 await db.exec(`CREATE TABLE users(id INT PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INT,permissions TEXT);
 CREATE TABLE parties(id INT PRIMARY KEY,kind TEXT,is_active BOOLEAN,name TEXT);
 CREATE TABLE patients(id INT PRIMARY KEY,medical_alert TEXT,primary_doctor_id INT);
 CREATE TABLE visits(id INT PRIMARY KEY,patient_id INT,doctor_id INT);
 CREATE TABLE prescriptions(id SERIAL PRIMARY KEY,patient_id INT,visit_id INT,diagnosis TEXT,notes TEXT,instructions_lang TEXT,items JSONB,status TEXT DEFAULT 'active',void_reason TEXT,voided_by TEXT,voided_at TIMESTAMPTZ,created_by TEXT,doctor_party_id INT,prescribing_doctor_name TEXT,prescribing_doctor_party_id INT,created_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE audit_log(id SERIAL PRIMARY KEY,action TEXT,entity TEXT,entity_id TEXT,summary TEXT,details JSONB,actor TEXT,actor_role TEXT,source_ip TEXT,user_agent TEXT);
 ${PRESCRIPTION_ISSUANCE_SQL}
 INSERT INTO users VALUES(3,'synthetic','Synthetic','synthetic-password-hash','doctor',true,5,'{"canViewAllPatients":true}');
 INSERT INTO parties VALUES(5,'doctor',true,'Synthetic Doctor'); INSERT INTO patients VALUES(7,NULL,5); INSERT INTO visits VALUES(9,7,5);`);
 transport.query.mockImplementation((sql: string, values?: unknown[]) => db.query(sql, values));
 transport.session.mockImplementation(async () => ({ userId: 3, username: 'synthetic', role: 'doctor', expiresAt: Date.now() + 60000, credentialVersion: sessionCredentialVersion('synthetic-password-hash') }));
},30000);
afterAll(async () => { await db?.close(); vi.unstubAllEnvs(); });
it('two identical HTTP issuance commands resolve to one Rx and one atomic audit', async () => {
 const body = { commandKey: '11111111-1111-4111-8111-111111111111', patientId: 7, visitId: 9, prescribingDoctorPartyId: 5, diagnosis: '', notes: '', instructionsLang: 'both', items: [{ name: 'SyntheticRx', dose: '500mg', form: 'tablet', frequency: 'fixture', duration: 'fixture', instructions: 'محفوظ', instructionsEn: 'saved', selection: { id: 'manual', amount: '1 tablet', confirmed: true } }] };
 const request = () => new Request('http://localhost/api/prescriptions', { method: 'POST', body: JSON.stringify(body) });
 const a = await POST(request()), b = await POST(request()); expect(a.status).toBe(201); expect(b.status).toBe(201);
 const first = await a.json(), second = await b.json(); expect(second.id).toBe(first.id);
 expect((await db.query('SELECT count(*)::int n FROM prescriptions')).rows[0]).toEqual({ n: 1 });
 expect((await db.query('SELECT count(*)::int n FROM audit_log')).rows[0]).toEqual({ n: 1 });
});
