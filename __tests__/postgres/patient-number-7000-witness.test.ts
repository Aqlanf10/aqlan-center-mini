import { randomUUID, createHash } from 'node:crypto';
import { Client } from 'pg';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { stubPostgresEnv } from './_setup';
import { validatePostgresTestTarget } from './_safe-target';
import { PATIENT_NUMBER_SQL } from '../../lib/document-numbers';
import { RESET_SEQUENCES } from '../../lib/clinic-reset';
import { parseCsv } from '../../lib/patient-import';

// Synthetic owned databases only; verify the new-only patient-number floor.
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
const seed = async () => { await q("INSERT INTO patients(patient_number,full_name) VALUES('P-00042','SYNTHETIC HISTORICAL FILE')"); };
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

describe('new-only patient numbering: numeric 7000 is displayed P-07000', () => {
  it('fresh initialization leaves P-07000 pending without an external reseed', async () => {
    expect((await q('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0])
      .toEqual({last_value:'7000',is_called:false});
    expect((await db.createPatient(input('FRESH'))).patientNumber).toBe('P-07000');
  });
  it('the demo reset sequence plan does not reset the patient high-water counter', () => {
    expect(RESET_SEQUENCES).toEqual(['invoice_number_seq','receipt_number_seq','voucher_number_seq']);
  });
  it('a financial counter restart cannot rewind an already issued patient archive number', async () => {
    // Isolated fixture only. This exercises the reset sequence allowlist, not
    // the destructive clinic-data reset workflow or a physical backup restore.
    const issued = await db.createPatient(input('BEFORE COUNTER MAINTENANCE'));
    expect(issued.patientNumber).toBe('P-07000');
    for (const sequence of RESET_SEQUENCES) {
      await q(`ALTER SEQUENCE "${sequence}" RESTART WITH 1`);
    }
    await restart();
    expect((await db.getPatient(issued.id))?.patientNumber).toBe('P-07000');
    const next = await db.createPatient(input('AFTER COUNTER MAINTENANCE'));
    expect(next.patientNumber).toBe('P-07001');
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
  });

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
  it('keeps six-digit patient archive numbers intact in storage and search', async () => {
    // Canonical numbers must remain printable beyond the five-character padding floor.
    await q("SELECT setval('patient_number_seq',99999,true)");
    await restart();
    const first=await db.createPatient(input('SIX DIGIT BOUNDARY'));
    const second=await db.createPatient(input('SIX DIGIT NEXT'));
    expect([first.patientNumber,second.patientNumber]).toEqual(['P-100000','P-100001']);
    expect((await db.getPatient(first.id))?.patientNumber).toBe('P-100000');
    expect((await db.searchPatients('P-100000')).map(p=>p.patientNumber)).toContain('P-100000');
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
  });
  it('genuinely filed higher canonical number prevents collision', async () => {
    await q("INSERT INTO patients(patient_number,full_name) VALUES('P-900000','SYNTHETIC CANONICAL HIGH')");
    await restart();expect((await db.createPatient(input('AFTER HIGH'))).patientNumber).toBe('P-900001');
  });
  it('previously allocated high sequence is never reused even without a surviving patient row', async () => {
    await q("SELECT setval('patient_number_seq',900000,true)");await restart();
    expect((await db.createPatient(input('RETIRED SEQUENCE'))).patientNumber).toBe('P-900001');
  });
  it('never reuses a printed file number after deleting a clean synthetic duplicate', async () => {
    const issued=await db.createPatient(input('CLEAN DUPLICATE'));
    expect(issued.patientNumber).toBe('P-07000');
    const removed=await db.deletePatientCascade(issued.id, {
      actor:'synthetic-admin',actorRole:'admin',reason:'synthetic duplicate only',
    });
    expect(removed.ok).toBe(true);
    expect((await q('SELECT patient_number FROM patients WHERE id=$1',[issued.id])).rows).toHaveLength(0);
    await restart();
    const next=await db.createPatient(input('AFTER DELETION'));
    expect(next.patientNumber).toBe('P-07001');
    expect((await db.searchPatients('P-07000')).map(p=>p.patientNumber)).not.toContain('P-07000');
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
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
  it('reconciles a low restored counter without renumbering the historical file', async () => {
    await q("SELECT setval('patient_number_seq',1,true)");await restart();
    expect((await db.createPatient(input('LOW COUNTER'))).patientNumber).toBe('P-07000');
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
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
  it('concurrent ordinary, walk-in and booking file creation share a unique archive counter even on replay', async () => {
    const visit=await db.addVisit({patientName:'SYNTHETIC MIXED WALK IN',patientPhone:null,note:null});
    const request=await db.createBookingRequest({fullName:'SYNTHETIC MIXED BOOKING',phone:'999900002',reason:null,preferredDate:null,preferredPeriod:'any'},'synthetic-mixed-numbering');
    const booking={id:request.id,date:'2026-11-19',time:'12:00',durationMinutes:30};
    const [ordinary,walk,book]=await Promise.all([
      db.createPatient(input('MIXED ORDINARY')),
      db.openVisitPatientFile(visit.id),
      db.confirmBookingRequest(booking),
    ]);
    if(!walk.ok || !book)throw new Error('Synthetic mixed entry failed');
    const walkPatient=await db.getPatient(walk.patientId);
    const bookPatient=await db.getPatient(book.patientId);
    expect(walkPatient).not.toBeNull();expect(bookPatient).not.toBeNull();
    const numbers=[ordinary.patientNumber,walkPatient!.patientNumber,bookPatient!.patientNumber];
    expect(new Set(numbers).size).toBe(3);
    expect(numbers.every(n=>/^P-[0-9]{5,}$/.test(n))).toBe(true);
    expect(numbers).toContain('P-07000');
    for(const n of numbers)expect((await db.searchPatients(n)).map(p=>p.patientNumber)).toContain(n);

    // A lost response may be retried after the original write committed.
    const [walkReplay,bookReplay]=await Promise.all([
      db.openVisitPatientFile(visit.id),db.confirmBookingRequest(booking),
    ]);
    if(!walkReplay.ok)throw new Error('Synthetic walk-in replay failed');
    expect(walkReplay.patientId).toBe(walk.patientId);expect(walkReplay.created).toBe(false);
    expect(bookReplay).toBeNull();
    expect((await q('SELECT count(*)::int AS n FROM patients')).rows[0].n).toBe(4);
    await restart();
    const next=await db.createPatient(input('AFTER MIXED REPLAY'));
    const issuedHigh=Math.max(...numbers.map(n=>Number(n.slice(2))));
    expect(Number(next.patientNumber.slice(2))).toBeGreaterThan(issuedHigh);
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
  });
  it('simultaneous replay of the same walk-in and booking cannot create a second archive file', async () => {
    const visit=await db.addVisit({patientName:'SYNTHETIC SAME WALK IN',patientPhone:null,note:null});
    const request=await db.createBookingRequest({fullName:'SYNTHETIC SAME BOOKING',phone:'999900003',reason:null,preferredDate:null,preferredPeriod:'any'},'synthetic-same-numbering');
    const booking={id:request.id,date:'2026-11-19',time:'12:00',durationMinutes:30};
    const [walkA,walkB,bookA,bookB]=await Promise.all([
      db.openVisitPatientFile(visit.id),db.openVisitPatientFile(visit.id),
      db.confirmBookingRequest(booking),db.confirmBookingRequest(booking),
    ]);
    if(!walkA.ok || !walkB.ok)throw new Error('Synthetic concurrent walk-in failed');
    expect(walkA.patientId).toBe(walkB.patientId);
    expect([walkA.created,walkB.created].filter(Boolean)).toHaveLength(1);
    const booked=bookA ?? bookB;
    expect([bookA,bookB].filter(Boolean)).toHaveLength(1);
    if(!booked)throw new Error('Synthetic concurrent booking failed');
    expect(booked.patientId).not.toBe(walkA.patientId);
    const walkPatient=await db.getPatient(walkA.patientId);
    const bookPatient=await db.getPatient(booked.patientId);
    if(!walkPatient || !bookPatient)throw new Error('Synthetic archived patient missing');
    const numbers=[walkPatient.patientNumber,bookPatient.patientNumber];
    expect(new Set(numbers).size).toBe(2);
    expect(numbers.every(n=>/^P-[0-9]{5,}$/.test(n))).toBe(true);
    expect((await q('SELECT count(*)::int AS n FROM patients')).rows[0].n).toBe(3);
    await restart();
    const next=await db.createPatient(input('AFTER SAME REQUEST RACE'));
    expect(Number(next.patientNumber.slice(2))).toBeGreaterThan(Math.max(...numbers.map(n=>Number(n.slice(2)))));
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
  });
  it('concurrent CSV import and ordinary registration share the archive counter, not the external number', async () => {
    const csv='الاسم,الهاتف,رقم الملف\nSYNTHETIC CONCURRENT IMPORT,,900000';
    const [imported,ordinary]=await Promise.all([
      db.commitPatientImport({rows:parseCsv(csv),fileSha256:createHash('sha256').update(csv).digest('hex'),fileName:'synthetic-concurrent-numbering.csv',today:'2026-11-19',includePossibleDuplicates:false,actor:'synthetic-admin',actorRole:'admin'}),
      db.createPatient(input('CONCURRENT WITH IMPORT')),
    ]);
    if(!imported.ok)throw new Error(imported.reason);
    expect(imported.created).toHaveLength(1);
    const fromImport=imported.created[0];
    const numbers=[fromImport.patientNumber,ordinary.patientNumber];
    expect(new Set(numbers).size).toBe(2);
    expect(numbers).toContain('P-07000');
    expect(numbers.every(n=>/^P-[0-9]{5,}$/.test(n) && Number(n.slice(2))>=7000 && Number(n.slice(2))<900000)).toBe(true);
    expect((await db.getPatient(fromImport.id))?.note).toContain('رقم الملف في النظام القديم: 900000');
    for(const n of numbers)expect((await db.searchPatients(n)).map(p=>p.patientNumber)).toContain(n);
    expect((await q('SELECT count(*)::int AS n FROM patients')).rows[0].n).toBe(3);
    await restart();
    const next=await db.createPatient(input('AFTER CONCURRENT IMPORT'));
    expect(Number(next.patientNumber.slice(2))).toBeGreaterThan(Math.max(...numbers.map(n=>Number(n.slice(2)))));
    expect(Number(next.patientNumber.slice(2))).toBeLessThan(900000);
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
  });
  it('a fresh database pool preserves the issued high-water and historical archive identifiers', async () => {
    // Unlike restart() alone, this closes the old application pool and reconnects.
    // It is not a physical backup restore or a full process restart.
    const issued=await db.createPatient(input('BEFORE POOL RECONNECT'));
    expect(issued.patientNumber).toBe('P-07000');
    const before=(await q('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0];
    expect(before).toEqual({last_value:'7000',is_called:true});
    await db.resetPoolForTesting();
    await restart();
    expect((await q('SELECT last_value::text,is_called FROM patient_number_seq')).rows[0]).toEqual(before);
    expect((await db.getPatient(issued.id))?.patientNumber).toBe(issued.patientNumber);
    expect((await db.searchPatients(issued.patientNumber)).map(p=>p.patientNumber)).toContain(issued.patientNumber);
    expect((await db.createPatient(input('AFTER POOL RECONNECT'))).patientNumber).toBe('P-07001');
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
  });
  it('database uniqueness rejects an explicit duplicate archive number without changing the issued file', async () => {
    // Synthetic database only: verify the persistence boundary even if a writer
    // bypasses createPatient and attempts to insert an already issued number.
    const issued=await db.createPatient(input('ORIGINAL UNIQUE NUMBER'));
    expect(issued.patientNumber).toBe('P-07000');
    await expect(q('INSERT INTO patients(patient_number,full_name) VALUES($1,$2)',
      [issued.patientNumber,'SYNTHETIC CONFLICTING ARCHIVE'])).rejects.toMatchObject({code:'23505'});
    const rows=(await q('SELECT id,patient_number FROM patients WHERE patient_number=$1',[issued.patientNumber])).rows;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].id)).toBe(String(issued.id));
    await restart();
    expect((await db.getPatient(issued.id))?.patientNumber).toBe('P-07000');
    expect((await db.createPatient(input('AFTER DUPLICATE CONFLICT'))).patientNumber).toBe('P-07001');
    expect((await q("SELECT patient_number FROM patients WHERE full_name='SYNTHETIC HISTORICAL FILE'")).rows[0].patient_number).toBe('P-00042');
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
