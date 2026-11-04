import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openInventoryPurchaseFixture } from './_inventory-purchase-fixture';
import { ProtectedAppointmentPurposeHistoryError, PURCHASE_RESET_FENCE, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from '../../lib/clinic-reset';
import { APPOINTMENT_PURPOSE_MIGRATION, validateAppointmentPurposeMigration } from '../../lib/appointment-purpose-migration-guard';
import { insertAppointmentPurposeProvenance } from '../../lib/appointment-purpose';
import type { DbClient } from '../../lib/db';

let fixture:Awaited<ReturnType<typeof openInventoryPurchaseFixture>>;
let serial=0;
const q=(sql:string,args:unknown[]=[])=>fixture.pool.query(sql,args);
beforeEach(async()=>{fixture=await openInventoryPurchaseFixture();});
afterEach(async()=>{await fixture?.close();});
async function patient() {
  const {rows:[row]}=await q(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'Synthetic provenance patient') RETURNING id`,[`SYN-PURPOSE-${++serial}`]);
  return row.id as number;
}
async function classified() {
  const own=await patient(), other=await patient();
  const {rows:[plan]}=await q(`INSERT INTO treatment_plans(patient_id,title,total_minor,status)
    VALUES($1,'Synthetic source plan',100,'active') RETURNING id`,[own]);
  const {rows:[foreignPlan]}=await q(`INSERT INTO treatment_plans(patient_id,title,total_minor,status)
    VALUES($1,'Synthetic foreign plan',100,'active') RETURNING id`,[other]);
  const {rows:[appointment]}=await q(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time)
    VALUES($1,CURRENT_DATE+30,'10:00') RETURNING id`,[own]);
  const {rows:[planned]}=await q(`INSERT INTO planned_visits(patient_id,plan_id,sequence,title,status,appointment_id)
    VALUES($1,$2,1,'Synthetic planned visit','scheduled',$3) RETURNING id`,[own,plan.id,appointment.id]);
  await q('UPDATE appointments SET planned_visit_id=$2 WHERE id=$1',[appointment.id,planned.id]);
  return {own,other,plan:plan.id as number,foreignPlan:foreignPlan.id as number,
    appointment:appointment.id as number,planned:planned.id as number};
}

it('PG18 registered 0095 is exact; a helper-issued row blocks reset at the table lock and protects history',async()=>{
  expect(RESET_KEEP_TABLES).toContain('appointment_purpose_provenance');
  expect(RESET_WIPE_TABLES).not.toContain('appointment_purpose_provenance');
  const {rows:registry}=await q("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version='0095'");
  expect(registry).toMatchObject([{version:'0095',name:APPOINTMENT_PURPOSE_MIGRATION.name,
    checksum:APPOINTMENT_PURPOSE_MIGRATION.checksum,adopted:false}]);
  const client=await fixture.pool.connect();
  try {await validateAppointmentPurposeMigration(client,[APPOINTMENT_PURPOSE_MIGRATION],registry);} finally {client.release();}
  const f=await classified();
  await expect(q(`INSERT INTO appointment_purpose_provenance
    (appointment_id,patient_id,purpose,source_plan_id,source_planned_visit_id,recorded_by)
    VALUES($1,$2,'follow_up',$3,$4,'synthetic')`,[f.appointment,f.own,f.foreignPlan,f.planned])).rejects.toThrow();
  const writer=await fixture.pool.connect();
  const backup=vi.fn(async()=>({ok:true as const,backupId:'must-not-run'}));
  let resetting:Promise<unknown>|null=null;
  try {await writer.query('BEGIN');await insertAppointmentPurposeProvenance(writer,{appointmentId:f.appointment,
    purpose:'follow_up',sourcePlanId:f.plan,sourcePlannedVisitId:f.planned,recordedBy:'synthetic'});
    const writerPid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    resetting=fixture.db.resetClinicData({actor:'synthetic',actorRole:'admin'},backup)
      .then(()=>null,(error:unknown)=>error);
    const deadline=Date.now()+15_000;
    let blockedResetPid:number|null=null;
    while(Date.now()<deadline){
      const {rows:[waiter]}=await q(`SELECT a.pid FROM pg_stat_activity a
        JOIN pg_locks l ON l.pid=a.pid
        WHERE a.datname=current_database() AND a.wait_event_type='Lock'
          AND a.query LIKE 'LOCK TABLE appointment_purpose_provenance IN EXCLUSIVE MODE%'
          AND l.locktype='relation' AND l.relation='appointment_purpose_provenance'::regclass
          AND NOT l.granted AND l.mode='ExclusiveLock'
          AND $1=ANY(pg_blocking_pids(a.pid))`,[writerPid]);
      if(waiter){blockedResetPid=waiter.pid;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await writer.query('COMMIT');
    expect(blockedResetPid).toEqual(expect.any(Number));
    expect(await resetting).toBeInstanceOf(ProtectedAppointmentPurposeHistoryError);
    expect(backup).not.toHaveBeenCalled();
  }
  finally {
    await writer.query('ROLLBACK').catch(()=>{});
    writer.release();
    if(resetting) await resetting; // Never close the owned fixture with a pending reset.
  }
  await expect(q('UPDATE appointment_purpose_provenance SET purpose=\'delivery\' WHERE appointment_id=$1',[f.appointment])).rejects.toThrow('immutable');
  await expect(q('TRUNCATE appointment_purpose_provenance')).rejects.toThrow('immutable');
  await expect(q('UPDATE treatment_plans SET patient_id=$2 WHERE id=$1',[f.plan,f.other])).rejects.toThrow();
  await expect(q('DELETE FROM planned_visits WHERE id=$1',[f.planned])).rejects.toThrow();
  expect(await fixture.db.deleteAppointment(f.appointment,{actor:'synthetic'})).toMatchObject({ok:false,reason:'classified_history'});
  expect(await fixture.db.deletePatientCascade(f.own,{actor:'synthetic'})).toMatchObject({ok:false,reason:'has_clinical_history'});
  expect(await fixture.db.mergeDuplicatePatient(f.own,f.other,{actor:'synthetic'})).toMatchObject({ok:false,reason:'source_has_classified_history'});
  const blank=await patient();
  expect(await fixture.db.mergeDuplicatePatient(blank,f.own,{actor:'synthetic'})).toMatchObject({ok:true});
  expect((await q('SELECT purpose,source_plan_id FROM appointment_purpose_provenance WHERE appointment_id=$1',[f.appointment])).rows)
    .toMatchObject([{purpose:'follow_up',source_plan_id:f.plan}]);
},120000);

it('reset-first holds the purpose issuer fence through backup and refuses stale pre-reset origins without a lock cycle',async()=>{
  const f=await classified();
  let enteredBackup!:()=>void,releaseBackup=()=>{};
  let resetPid:number|null=null;
  const inBackup=new Promise<void>(resolve=>{enteredBackup=resolve;});
  const holdBackup=new Promise<void>(resolve=>{releaseBackup=resolve;});
  const backup=vi.fn(async(backupClient:DbClient)=>{
    const {rows:holders}=await backupClient.query<{pid:number}>(`SELECT l.pid FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.datname=current_database() AND l.locktype='advisory'
        AND l.mode='ExclusiveLock' AND l.granted AND l.objsubid=1
        AND l.classid::text::bigint=((hashtextextended($1,0)>>32)&4294967295)
        AND l.objid::text::bigint=(hashtextextended($1,0)&4294967295)`,[PURCHASE_RESET_FENCE]);
    expect(holders).toHaveLength(1);
    resetPid=holders[0].pid;
    enteredBackup();await holdBackup;return {ok:true as const,backupId:'synthetic-backup'};
  });
  const resetting=fixture.db.resetClinicData({actor:'synthetic',actorRole:'admin'},backup)
    .then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
  let writer:DbClient|null=null;
  let waiting:Promise<{ok:true}|{ok:false;error:unknown}>|null=null;
  try {
    await Promise.race([inBackup,resetting.then(()=>{throw new Error('Reset left before the synthetic backup barrier');})]);
    // Reset owns the EXCLUSIVE issuer fence and empty table lock.
    writer=await fixture.pool.connect();
    await writer.query('BEGIN');
    const writerPid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    waiting=writer.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[PURCHASE_RESET_FENCE])
      .then(()=>({ok:true as const}),error=>({ok:false as const,error}));
    const deadline=Date.now()+15_000;
    let blockerPid:number|null=null;
    while(Date.now()<deadline){
      const {rows:[state]}=await q(`SELECT a.wait_event_type,pg_blocking_pids($1::int) AS blockers,
          EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=$1 AND l.locktype='advisory' AND NOT l.granted) AS advisory_wait
        FROM pg_stat_activity a WHERE a.pid=$1`,[writerPid]);
      if(resetPid!==null && state?.wait_event_type==='Lock' && state.advisory_wait && state.blockers?.includes(resetPid)){
        blockerPid=resetPid;break;
      }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(resetPid).toEqual(expect.any(Number));
    expect(blockerPid).toBe(resetPid);
    releaseBackup();
    const resetOutcome=await resetting;
    expect(resetOutcome).toMatchObject({ok:true,value:{ok:true}});
    expect(await waiting).toEqual({ok:true});
    await expect(insertAppointmentPurposeProvenance(writer,{appointmentId:f.appointment,
      purpose:'follow_up',sourcePlanId:f.plan,sourcePlannedVisitId:f.planned,recordedBy:'stale-writer'}))
      .rejects.toThrow('APPOINTMENT_PURPOSE_ORIGIN_STALE');
    await writer.query('ROLLBACK');
    expect((await q('SELECT count(*)::int AS n FROM appointment_purpose_provenance')).rows[0].n).toBe(0);
  } finally {
    releaseBackup();
    await resetting;
    if(waiting) await waiting;
    if(writer){await writer.query('ROLLBACK').catch(()=>{});writer.release();}
  }
},120000);
