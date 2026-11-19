import { randomUUID, createHash } from 'node:crypto';
import { Client } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { stubPostgresEnv } from './_setup';
import { validatePostgresTestTarget } from './_safe-target';
import { PATIENT_NUMBER_SQL } from '../../lib/document-numbers';
import { parseCsv } from '../../lib/patient-import';

// Synthetic owned databases only; exact-main characterization, not a migration or fix.
// Validate BEFORE stubPostgresEnv changes runtime markers. Use the same exact
// database/loopback/query-parameter policy as the required PostgreSQL CI gate.
// TEST_DATABASE_URL is mandatory: never fall back to an ambient application DB.
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const original = validatePostgresTestTarget(process.env).testUrl.toString();
stubPostgresEnv();
let name: string;
let createdDatabase = false;
let db: typeof import('../../lib/db');
async function admin(sql: string) { const c = new Client({connectionString: original, ssl:false}); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }
const input = (label: string) => ({fullName:`SYNTHETIC NUMBERING ${label}`,phone:null,altPhone:null,gender:'unknown' as const,birthYear:null,address:null,medicalAlert:null,note:null});
const q = (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
const restart = async () => { db.schemaReadyReset(); await db.ensureSchema(); };
const seed = async () => { await q("INSERT INTO patients(patient_number,full_name) VALUES('P-00042','SYNTHETIC HISTORICAL FILE')"); await q("SELECT setval('patient_number_seq',6999,true)"); };
beforeEach(async () => {
  createdDatabase=false;
  name=`aqlan_number_witness_${randomUUID().replaceAll('-','')}`;
  await admin(`CREATE DATABASE "${name}"`);
  createdDatabase=true;
  const url=new URL(original);url.pathname=`/${name}`;
  process.env.DATABASE_URL=url.toString();process.env.TEST_DATABASE_URL=url.toString();
  db=await import('../../lib/db');await db.ensureSchema();await seed();
});
afterEach(async () => {
  await db?.resetPoolForTesting();
  if (!/^aqlan_number_witness_[a-f0-9]{32}$/.test(name)) throw new Error('Not an owned fixture');
  if (createdDatabase) await admin(`DROP DATABASE "${name}" WITH (FORCE)`);
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=originalDatabaseUrl;
  if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL=originalTestDatabaseUrl;
});

describe('exact-main numbering: numeric 7000 is displayed P-07000', () => {
  it('ordinary creation after startup yields P-07000 then P-07001 and keeps the historical file', async () => {
    await restart();
    const a=await db.createPatient(input('A'));const b=await db.createPatient(input('B'));
    expect([a.patientNumber,b.patientNumber]).toEqual(['P-07000','P-07001']);
    expect((await db.getPatient(a.id))?.patientNumber).toBe('P-07000');
    expect((await db.searchPatients('P-07000')).map(p=>p.patientNumber)).toContain('P-07000');
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
  });
  it('import legacy external number 900000 is note metadata, never the new canonical number', async () => {
    const csv='الاسم,الهاتف,رقم الملف\nSYNTHETIC IMPORT NUMBER,,900000';
    const result=await db.commitPatientImport({rows:parseCsv(csv),fileSha256:createHash('sha256').update(csv).digest('hex'),fileName:'synthetic-numbering.csv',today:'2026-11-19',includePossibleDuplicates:false,actor:'synthetic-admin',actorRole:'admin'});
    expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.reason);
    expect(result.created).toHaveLength(1);expect(result.created[0].patientNumber).toBe('P-07000');
    expect((await db.getPatient(result.created[0].id))?.note).toContain('رقم الملف في النظام القديم: 900000');
    await restart();expect((await db.createPatient(input('AFTER IMPORT'))).patientNumber).toBe('P-07001');
  });
  it('high unrelated note, phone, national-ID and internal primary key do not affect startup max', async () => {
    await q("UPDATE patients SET id=900000,phone='999900000',national_id='SYNTHETIC-ID-900000',note='external legacy reference 900000' WHERE patient_number='P-00042'");
    await restart();expect((await db.createPatient(input('HIGH METADATA'))).patientNumber).toBe('P-07000');
  });
  it('genuinely filed higher canonical number prevents collision', async () => {
    await q("INSERT INTO patients(patient_number,full_name) VALUES('P-900000','SYNTHETIC CANONICAL HIGH')");
    await restart();expect((await db.createPatient(input('AFTER HIGH'))).patientNumber).toBe('P-900001');
  });
  it('previously allocated high sequence is never reused even without a surviving patient row', async () => {
    await q("SELECT setval('patient_number_seq',900000,true)");await restart();
    expect((await db.createPatient(input('RETIRED SEQUENCE'))).patientNumber).toBe('P-900001');
  });
  it('shared allocator consumes a value even if its transaction rolls back', async () => {
    const c=await db.getPool().connect();try {await c.query('BEGIN');expect((await c.query(`SELECT ${PATIENT_NUMBER_SQL} AS number`)).rows[0].number).toBe('P-07000');await c.query('ROLLBACK');}finally{c.release();}
    await restart();expect((await db.createPatient(input('AFTER ROLLBACK'))).patientNumber).toBe('P-07001');
  });
  it('characterizes actual noncanonical patient_number separately: historical digit extraction raises startup max', async () => {
    await q("INSERT INTO patients(patient_number,full_name) VALUES('LEGACY-900000','SYNTHETIC NONCANONICAL ACTUAL FILE')");
    await restart();expect((await db.createPatient(input('AFTER NONCANONICAL'))).patientNumber).toBe('P-900001');
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC NONCANONICAL ACTUAL FILE'")).rows[0].patient_number).toBe('LEGACY-900000');
  });
  it('characterizes untouched low counter: main has no automatic 7000 policy', async () => {
    await q("SELECT setval('patient_number_seq',1,true)");await restart();
    expect((await db.createPatient(input('LOW COUNTER'))).patientNumber).toBe('P-00043');
  });
  it('walk-in file opening consumes exactly one shared number on repeated opening', async () => {
    await restart();
    const visit=await db.addVisit({patientName:'SYNTHETIC WALK IN',patientPhone:null,note:null});
    const a=await db.openVisitPatientFile(visit.id);const b=await db.openVisitPatientFile(visit.id);
    expect(a.ok && b.ok).toBe(true);if(!a.ok || !b.ok)throw new Error('Synthetic walk-in opening failed');
    expect(a.patientId).toBe(b.patientId);expect(a.created).toBe(true);expect(b.created).toBe(false);
    expect((await db.getPatient(a.patientId))?.patientNumber).toBe('P-07000');
    expect((await db.createPatient(input('AFTER WALK IN'))).patientNumber).toBe('P-07001');
  });
  it('booking confirmation uses the same allocator once, without exercising a public HTTP endpoint', async () => {
    await restart();
    const request=await db.createBookingRequest({fullName:'SYNTHETIC BOOKING',phone:'999900001',reason:null,preferredDate:null,preferredPeriod:'any'},'synthetic-numbering-source');
    const a=await db.confirmBookingRequest({id:request.id,date:'2026-11-19',time:'12:00',durationMinutes:30});
    expect(a).not.toBeNull();expect((await db.getPatient(a!.patientId))?.patientNumber).toBe('P-07000');
    expect(await db.confirmBookingRequest({id:request.id,date:'2026-11-19',time:'12:00',durationMinutes:30})).toBeNull();
    expect((await db.createPatient(input('AFTER BOOKING'))).patientNumber).toBe('P-07001');
  });
  it('equal and occupied unconsumed number is marked consumed, not allocated again', async () => {
    await q("INSERT INTO patients(patient_number,full_name) VALUES('P-07000','SYNTHETIC OCCUPIED TARGET')");
    await q("SELECT setval('patient_number_seq',7000,false)");await restart();
    expect((await q('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0]).toEqual({last_value:'7000',is_called:true});
    expect((await db.createPatient(input('AFTER OCCUPIED EQUAL'))).patientNumber).toBe('P-07001');
  });
  it('concurrent ordinary allocations and startup retain unique numbers and never reset the next value', async () => {
    const created=await Promise.all([restart(),...Array.from({length:12},(_,i)=>db.createPatient(input(`CONCURRENT ${i}`)))]);
    const numbers=created.slice(1).map(p=>(p as Awaited<ReturnType<typeof db.createPatient>>).patientNumber).sort();
    expect(numbers).toEqual(Array.from({length:12},(_,i)=>`P-${String(7000+i).padStart(5,'0')}`));
    expect((await db.createPatient(input('AFTER CONCURRENT'))).patientNumber).toBe('P-07012');
  });
  it('warm-runtime INSERTs interleave with startup without duplicate allocation', async () => {
    // Direct canonical INSERT models another process with its own already-ready schema cache.
    const pending=Array.from({length:12},(_,i)=>q(`INSERT INTO patients(patient_number,full_name) VALUES(${PATIENT_NUMBER_SQL},$1) RETURNING patient_number`,[`SYNTHETIC WARM ${i}`]));
    const cold=restart();
    const results=await Promise.all(pending);await cold;
    expect(results.map(r=>r.rows[0].patient_number).sort()).toEqual(Array.from({length:12},(_,i)=>`P-${String(7000+i).padStart(5,'0')}`));
    expect((await db.createPatient(input('AFTER WARM'))).patientNumber).toBe('P-07012');
  });
  it('startup waits for a committed occupied target before reconciling the counter', async () => {
    const c=await db.getPool().connect();
    try {
      await q("SELECT setval('patient_number_seq',7000,false)");
      await c.query('BEGIN');await c.query("INSERT INTO patients(patient_number,full_name) VALUES('P-07000','SYNTHETIC CONCURRENT OCCUPIED')");
      let finished=false;const pending=restart().then(()=>{finished=true;});
      await new Promise(resolve=>setTimeout(resolve,80));expect(finished).toBe(false);
      await c.query('COMMIT');await pending;
      expect((await db.createPatient(input('AFTER COMMITTED OCCUPIED'))).patientNumber).toBe('P-07001');
    } finally { await c.query('ROLLBACK');c.release(); }
  });
  it('explicit next-value 7000 with is_called=false must remain 7000 across startup', async () => {
    await q("SELECT setval('patient_number_seq',7000,false)");
    const before=(await q('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0];
    await restart();
    const first=(await q('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0];
    await restart();
    const second=(await q('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0];
    console.log('SYNTHETIC SEQUENCE STATES',JSON.stringify({before,first,second}));
    expect(second).toEqual(first); // a second startup itself must not further advance
    expect((await db.createPatient(input('UNCALLED TARGET'))).patientNumber).toBe('P-07000');
  });
});
