import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openInventoryPurchaseFixture } from './_inventory-purchase-fixture';
import { purchaseTestSession } from './_inventory-purchase-session';
import type { SessionPayload } from '../../lib/auth';
import type { DirectAppointmentIntent } from '../../lib/appointment-purpose-command';

// Native PG18 fixture only. Request headers are synthetic; account/credential,
// permission, advisory locks, service reads and all writes use real PostgreSQL.
vi.mock('next/headers',()=>({headers:async()=>new Headers(),cookies:async()=>({get:()=>undefined})}));
let fixture:Awaited<ReturnType<typeof openInventoryPurchaseFixture>>;
let session:SessionPayload;
let serial=0;
const q=(sql:string,args:unknown[]=[])=>fixture.pool.query(sql,args);
const command=async(patientId:number,extra:Partial<DirectAppointmentIntent>={})=>({
  patientId,date:`2030-02-${String(++serial).padStart(2,'0')}`,
  time:'10:00',durationMinutes:30,appointmentPurpose:'consultation' as const,
  ...extra,commandId:randomUUID(),
});
const actor=(signed=session)=>({username:signed.username,role:signed.role,channel:'ui' as const,session:signed});
async function patient() {
  const {rows:[row]}=await q(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'Synthetic direct command patient') RETURNING id`,[`SYN-DIRECT-${++serial}`]);
  return row.id as number;
}
async function totals(commandId:string) {
  const {rows:[row]}=await q(`SELECT
    (SELECT count(*)::int FROM appointment_purpose_provenance WHERE command_id=$1::uuid) AS receipts,
    (SELECT count(*)::int FROM appointments a JOIN appointment_purpose_provenance p ON p.appointment_id=a.id
      WHERE p.command_id=$1::uuid) AS appointments,
    (SELECT count(*)::int FROM audit_log l JOIN appointment_purpose_provenance p
      ON l.entity='appointment' AND l.entity_id=p.appointment_id::text
      WHERE p.command_id=$1::uuid AND l.action='appointment.purpose_recorded') AS audits`,[commandId]);
  return row as {receipts:number;appointments:number;audits:number};
}
/** Independent effect count: a broken writer must not hide an orphan appointment
 * or audit line merely because its receipt insert rolled back. Each request has
 * a distinct patient/date, so no previous test can contaminate this count. */
async function effects(request:{patientId:number;date:string}) {
  const {rows:[row]}=await q(`SELECT
    (SELECT count(*)::int FROM appointments WHERE patient_id=$1 AND scheduled_date=$2::date) AS appointments,
    (SELECT count(*)::int FROM audit_log l JOIN appointments a
      ON l.entity='appointment' AND l.entity_id=a.id::text
      WHERE a.patient_id=$1 AND a.scheduled_date=$2::date
        AND l.action='appointment.purpose_recorded') AS purpose_audits`,[request.patientId,request.date]);
  return row as {appointments:number;purpose_audits:number};
}

beforeAll(async()=>{
  fixture=await openInventoryPurchaseFixture();
  session=await purchaseTestSession('synthetic-direct-reception','reception');
});
afterAll(async()=>{await fixture?.close();});

it('concurrent same-UUID requests and explicit recovery return one completed appointment/audit',async()=>{
  const {bookDirectPurposeAppointment,recoverDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const request=await command(await patient());
  const [first,second]=await Promise.all([
    bookDirectPurposeAppointment(request,actor()),bookDirectPurposeAppointment(request,actor()),
  ]);
  expect(first.ok && second.ok).toBe(true);
  if(!first.ok || !second.ok) return;
  expect([first.replayed,second.replayed].sort()).toEqual([false,true]);
  const id=first.replayed?first.appointmentId:first.appointment.id;
  expect(second.replayed?second.appointmentId:second.appointment.id).toBe(id);
  expect(await totals(request.commandId)).toEqual({receipts:1,appointments:1,audits:1});
  expect(await effects(request)).toEqual({appointments:1,purpose_audits:1});
  expect(await recoverDirectPurposeAppointment(request.commandId,session))
    .toMatchObject({kind:'found',appointmentId:id,status:'booked'});
  await q(`UPDATE appointments SET status='cancelled' WHERE id=$1`,[id]);
  const again=await bookDirectPurposeAppointment(request,actor());
  expect(again).toMatchObject({ok:true,replayed:true,appointmentId:id,status:'cancelled'});
  expect(await totals(request.commandId)).toEqual({receipts:1,appointments:1,audits:1});
  expect(await effects(request)).toEqual({appointments:1,purpose_audits:1});
},120_000);

it('same UUID with changed body or actor is a generic 409 and cannot create another row',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const request=await command(await patient());
  expect((await bookDirectPurposeAppointment(request,actor())).ok).toBe(true);
  const changed=await bookDirectPurposeAppointment({...request,time:'10:30'},actor());
  expect(changed).toMatchObject({ok:false,status:409});
  const other=await purchaseTestSession('synthetic-direct-other','reception');
  const stolen=await bookDirectPurposeAppointment(request,actor(other));
  expect(stolen).toMatchObject({ok:false,status:409});
  expect(await totals(request.commandId)).toEqual({receipts:1,appointments:1,audits:1});
  expect(await effects(request)).toEqual({appointments:1,purpose_audits:1});
},120_000);

it('replay returns the completed receipt after service default and activity changed',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const {rows:[service]}=await q(`INSERT INTO appointment_services
    (code,name_ar,default_duration_minutes,requires_provider,requires_chair)
    VALUES($1,'Synthetic direct service',30,false,true) RETURNING id`,[`SYN-DIRECT-SERVICE-${++serial}`]);
  const request=await command(await patient(),{serviceId:service.id,durationMinutes:null});
  const created=await bookDirectPurposeAppointment(request,actor());
  expect(created).toMatchObject({ok:true,replayed:false});
  await q(`UPDATE appointment_services SET default_duration_minutes=120,is_active=false WHERE id=$1`,[service.id]);
  const replay=await bookDirectPurposeAppointment(request,actor());
  expect(replay).toMatchObject({ok:true,replayed:true});
  expect(await totals(request.commandId)).toEqual({receipts:1,appointments:1,audits:1});
  expect(await effects(request)).toEqual({appointments:1,purpose_audits:1});
},120_000);

it('service deactivation while waiting for the day lock defeats NEW creation, not a stale preflight',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const {rows:[service]}=await q(`INSERT INTO appointment_services
    (code,name_ar,default_duration_minutes,requires_provider,requires_chair)
    VALUES($1,'Synthetic changing service',30,false,true) RETURNING id`,[`SYN-DIRECT-CHANGING-${++serial}`]);
  const request=await command(await patient(),{serviceId:service.id,durationMinutes:null});
  const blocker=await fixture.pool.connect();
  let pending:Promise<Awaited<ReturnType<typeof bookDirectPurposeAppointment>>>|null=null;
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))`,[request.date]);
    const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=bookDirectPurposeAppointment(request,actor());
    const deadline=Date.now()+15_000;
    let waitingPid:number|null=null;
    while(Date.now()<deadline) {
      const {rows:[row]}=await q(`SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname=current_database() AND a.wait_event_type='Lock'
          AND a.query LIKE 'SELECT pg_advisory_xact_lock(hashtext(''appointments-day:%'
          AND $1=ANY(pg_blocking_pids(a.pid))`,[blockerPid]);
      if(row){waitingPid=row.pid;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(waitingPid).toEqual(expect.any(Number));
    await q(`UPDATE appointment_services SET is_active=false WHERE id=$1`,[service.id]);
    await blocker.query('COMMIT');
    expect(await pending).toMatchObject({ok:false,status:400});
    expect(await totals(request.commandId)).toEqual({receipts:0,appointments:0,audits:0});
    expect(await effects(request)).toEqual({appointments:0,purpose_audits:0});
  } finally {
    await blocker.query('ROLLBACK').catch(()=>{});
    blocker.release();
    if(pending) await pending.catch(()=>{});
  }
},120_000);

it('a direct classified source patient cannot be merged away, while merge into it remains allowed',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const source=await patient(),target=await patient();
  const request=await command(source);
  expect((await bookDirectPurposeAppointment(request,actor())).ok).toBe(true);
  expect(await fixture.db.mergeDuplicatePatient(source,target,{actor:'synthetic-direct-reception'}))
    .toMatchObject({ok:false,reason:'source_has_classified_history'});
  const another=await patient();
  expect(await fixture.db.mergeDuplicatePatient(another,source,{actor:'synthetic-direct-reception'}))
    .toMatchObject({ok:true});
  expect(await totals(request.commandId)).toEqual({receipts:1,appointments:1,audits:1});
  expect(await effects(request)).toEqual({appointments:1,purpose_audits:1});
},120_000);

it('permission/re-role changed while the command UUID is blocked is revalidated after the wait',async()=>{
  const {bookDirectPurposeAppointment,lockDirectPurposeCommand}=await import('../../lib/book-direct-purpose');
  const request=await command(await patient());
  const blocker=await fixture.pool.connect();
  let pending:Promise<Awaited<ReturnType<typeof bookDirectPurposeAppointment>>>|null=null;
  try {
    await blocker.query('BEGIN');
    await lockDirectPurposeCommand(blocker,request.commandId);
    const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=bookDirectPurposeAppointment(request,actor());
    const deadline=Date.now()+15_000;
    let waitingPid:number|null=null;
    while(Date.now()<deadline) {
      const {rows:[row]}=await q(`SELECT a.pid,pg_blocking_pids(a.pid) AS blockers
        FROM pg_stat_activity a WHERE a.datname=current_database()
          AND a.wait_event_type='Lock' AND a.query LIKE 'SELECT pg_advisory_xact_lock(hashtext(''appointment-purpose-direct'')%'
          AND $1=ANY(pg_blocking_pids(a.pid))`,[blockerPid]);
      if(row){waitingPid=row.pid;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(waitingPid).toEqual(expect.any(Number));
    await q(`UPDATE users SET role='cashier' WHERE id=$1`,[session.userId]);
    await blocker.query('COMMIT');
    expect(await pending).toMatchObject({ok:false,status:401});
    expect(await totals(request.commandId)).toEqual({receipts:0,appointments:0,audits:0});
    expect(await effects(request)).toEqual({appointments:0,purpose_audits:0});
  } finally {
    await blocker.query('ROLLBACK').catch(()=>{});
    blocker.release();
    if(pending) await pending.catch(()=>{});
    await q(`UPDATE users SET role='reception' WHERE id=$1`,[session.userId]);
  }
},120_000);

it('audit failure rolls back appointment and receipt; same UUID can be retried only after rollback',async()=>{
  const {bookDirectPurposeAppointment,recoverDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const request=await command(await patient());
  await q(`CREATE FUNCTION synthetic_reject_purpose_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='appointment.purpose_recorded' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
    RETURN NEW; END $$`);
  await q(`CREATE TRIGGER synthetic_reject_purpose_audit BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION synthetic_reject_purpose_audit()`);
  try {
    await expect(bookDirectPurposeAppointment(request,actor())).rejects.toThrow('synthetic audit failure');
    expect(await totals(request.commandId)).toEqual({receipts:0,appointments:0,audits:0});
    expect(await effects(request)).toEqual({appointments:0,purpose_audits:0});
    expect(await recoverDirectPurposeAppointment(request.commandId,session)).toEqual({kind:'not_found'});
  } finally {
    await q('DROP TRIGGER synthetic_reject_purpose_audit ON audit_log');
    await q('DROP FUNCTION synthetic_reject_purpose_audit()');
  }
  expect((await bookDirectPurposeAppointment(request,actor())).ok).toBe(true);
  expect(await totals(request.commandId)).toEqual({receipts:1,appointments:1,audits:1});
  expect(await effects(request)).toEqual({appointments:1,purpose_audits:1});
},120_000);
