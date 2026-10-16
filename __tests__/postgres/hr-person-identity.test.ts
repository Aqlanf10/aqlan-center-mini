import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { sessionCredentialVersion,type SessionPayload } from '../../lib/auth';
import { readHrIdentityPreview } from '../../lib/hr-identity-read';
import { applyHrPersonIdentityPlan,reviewHrPersonIdentity } from '../../lib/hr-person-identity';
import { staffIdentityForUser } from '../../lib/hr-person-identity-approval';
import { readPersonIdentitySchema } from '../../lib/hr-person-identity-schema-state';
import type { PersonIdentityDecision } from '../../lib/hr-person-identity-plan';
import { identityDatabaseState } from '../helpers/hr-identity-state';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>,db: typeof import('../../lib/db'),hr: typeof import('../../lib/hr'),work: typeof import('../../lib/hr-contracts-attendance');
let reviewer: SessionPayload,serial=0;
const saved={url:process.env.DATABASE_URL,seed:process.env.SKIP_SEED,max:process.env.DB_POOL_MAX,secret:process.env.SESSION_SECRET};
const sql=readFileSync(new URL('../../docs/proposals/hr-person-identity.sql',import.meta.url),'utf8');
beforeAll(async()=>{
  fixture=await openBackupTimestampFixture({...process.env});process.env.DATABASE_URL=fixture.source.options.connectionString!;
  process.env.SKIP_SEED='false';process.env.DB_POOL_MAX='4';process.env.SESSION_SECRET='synthetic-person-identity-review-0123456789';
  db=await import('../../lib/db');hr=await import('../../lib/hr');work=await import('../../lib/hr-contracts-attendance');
  await db.resetPoolForTesting();await db.ensureSchema();reviewer=await account('admin');
  expect(await readPersonIdentitySchema(fixture.source)).toBeNull();
  const before=await identityDatabaseState(fixture.source);await readHrIdentityPreview(fixture.source,reviewer);
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
  await fixture.source.query(sql);
});
afterAll(async()=>{
  try{await db?.resetPoolForTesting();await fixture?.close();}
  finally{process.env.DATABASE_URL=saved.url;process.env.SKIP_SEED=saved.seed;process.env.DB_POOL_MAX=saved.max;process.env.SESSION_SECRET=saved.secret;}
});
async function account(role:SessionPayload['role'],partyId:number|null=null,active=true){
  const username=`identity-account-${++serial}`;
  const {rows:[a]}=await fixture.source.query(`INSERT INTO users(username,display_name,password_hash,role,party_id,is_active,permissions,commission_config)
    VALUES($1,'Identical synthetic display','synthetic-hash',$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING id`,
  [username,role,partyId,active,JSON.stringify({canViewFinance:false}),JSON.stringify({defaultPercent:37})]);
  return {userId:a.id,username,role,expiresAt:Date.now()+4*3600_000,credentialVersion:sessionCredentialVersion('synthetic-hash')} satisfies SessionPayload;
}
async function person(existing=true){
  const partyId=(await fixture.source.query("INSERT INTO parties(name,kind) VALUES('Synthetic identity doctor','doctor') RETURNING id")).rows[0].id;
  const a=await account('admin',partyId),b=await account('admin');
  const staffId=existing?(await fixture.source.query(`INSERT INTO hr_staff(full_name,user_id,created_by,work_status,contract_kind,hire_date)
    VALUES('Synthetic documented worker',$1,'synthetic','active','commission','2026-01-01') RETURNING id`,[a.userId])).rows[0].id:null;
  return {a,b,partyId,staffId};
}
const decision=(p:Awaited<ReturnType<typeof person>>,patch:Partial<PersonIdentityDecision>={}):PersonIdentityDecision=>({key:'one',staffId:p.staffId,
  expectedRevision:p.staffId===null?null:0,fullName:p.staffId===null?'Synthetic person only':null,userIds:[p.a.userId,p.b.userId],partyId:p.partyId,
  confirmedSamePerson:true,reason:'Confirmed by synthetic review',sourceRef:'synthetic-proof-1',closeAccountLinkIds:[],closePartyLinkId:null,...patch});
async function apply(p:Awaited<ReturnType<typeof person>>,patch:Partial<PersonIdentityDecision>={}){
  const plan=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p,patch)]);
  expect(plan.steps.every(s=>s.action!=='conflict'),JSON.stringify(plan.steps)).toBe(true);
  return applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId:`synthetic-request-${++serial}`,plan});
}
async function protectedState(){
  const state=await identityDatabaseState(fixture.source);
  const allowed=['hr_staff','hr_identity_import_runs','hr_identity_events','hr_staff_account_links','hr_staff_party_links','audit_log'];
  return Object.fromEntries(Object.entries(state).filter(([key])=>!allowed.some(t=>key===`table:${t}`||key===`sequence:${t}_id_seq`)));
}
it('applies two accounts and a party while preserving every unrelated row and sequence, including all currencies',async()=>{
  const p=await person();
  for(const currency of ['YER','SAR','USD'])await fixture.source.query(`INSERT INTO payables(party_id,category,description,amount_minor,currency,exchange_rate,base_amount_minor,created_by)
    VALUES($1,'commission','Synthetic preserved due',12345,$2,1,12345,'synthetic')`,[p.partyId,currency]);
  const profile=(await fixture.source.query('SELECT to_jsonb(s)-\'identity_revision\'-\'updated_at\' AS row FROM hr_staff s WHERE id=$1',[p.staffId])).rows[0].row;
  const before=await protectedState(),receipt=await apply(p);
  expect(receipt.people[0]).toMatchObject({staffId:p.staffId,revision:1,action:'confirm'});
  expect(await protectedState()).toEqual(before);
  expect((await fixture.source.query('SELECT to_jsonb(s)-\'identity_revision\'-\'updated_at\' AS row FROM hr_staff s WHERE id=$1',[p.staffId])).rows[0].row).toEqual(profile);
  expect((await fixture.source.query('SELECT user_id FROM hr_staff_account_links WHERE staff_id=$1 ORDER BY user_id',[p.staffId])).rows.map(r=>r.user_id)).toEqual([p.a.userId,p.b.userId]);
  expect(await staffIdentityForUser(fixture.source,p.b.userId)).toBe(p.staffId);
  expect(await hr.staffIdForUser(p.b.userId)).toBeNull(); // identity is not authority
  expect(await hr.staffIdForUser(p.a.userId)).toBe(p.staffId);
  expect(await hr.setStaffUserLink(p.staffId!,null,'Synthetic legacy edit',reviewer)).toMatchObject({ok:false,status:409});
  const preview=await readHrIdentityPreview(fixture.source,reviewer);
  expect(preview.candidates.find(c=>c.key===`staff:${p.staffId}`)?.userIds).toEqual([p.a.userId,p.b.userId]);
});
it('new identity has no invented terms, contract, dates, account access, balance or payroll item',async()=>{
  const p=await person(false);await fixture.source.query('UPDATE users SET is_active=FALSE WHERE id=$1',[p.b.userId]);
  const before=await protectedState(),receipt=await apply(p),staffId=receipt.people[0].staffId;
  expect(await protectedState()).toEqual(before);
  const row=(await fixture.source.query('SELECT * FROM hr_staff WHERE id=$1',[staffId])).rows[0];
  expect(row).toMatchObject({work_status:'unconfirmed',contract_kind:'unspecified',salary_amount_minor:null,salary_currency:null,
    salary_period:null,salary_effective_on:null,hire_date:null,end_date:null,user_id:null,identity_revision:1});
  expect((await hr.listStaffDirectory()).some(s=>s.id===staffId)).toBe(false);
  await expect(work.recordAttendance({staffId,attendanceDate:'2026-08-01',checkIn:'2026-08-01T08:00:00Z'},reviewer)).rejects.toMatchObject({status:409});
  await expect(work.adjustLeaveBalance({staffId,leaveTypeCode:'annual',year:2026,allocatedDays:10},reviewer)).rejects.toMatchObject({status:409});
  await expect(work.createSchedule({staffId,name:'Invalid inferred schedule',scheduleType:'morning',effectiveFrom:'2026-01-01',workingDays:[0],shiftStartTime:'08:00',shiftEndTime:'16:00'},reviewer)).rejects.toMatchObject({status:409});
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_contracts WHERE staff_id=$1',[staffId])).rows[0].n).toBe(0);
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_payroll_items WHERE staff_id=$1',[staffId])).rows[0].n).toBe(0);
  const payroll=await import('../../lib/hr-payroll'),period=await payroll.getOrCreatePayrollPeriod('2026-12',reviewer);
  for(const currency of ['YER','SAR','USD'] as const)await payroll.calculatePayrollRun(period.id,currency,reviewer);
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_payroll_items WHERE staff_id=$1',[staffId])).rows[0].n).toBe(0);
});
it('replays the same request before stale checking, rejects key/content reuse and another request for an applied plan',async()=>{
  const p=await person(),plan=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p)]),requestId=`replay-request-${++serial}`;
  const receipt=await applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId,plan}),after=await identityDatabaseState(fixture.source);
  expect(await applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId,plan})).toEqual(receipt);
  expect(await identityDatabaseState(fixture.source)).toEqual(after);
  await expect(applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId:`another-${++serial}`,plan})).rejects.toMatchObject({status:409});
  const replacement=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p,{expectedRevision:1,reason:'Changed proof'})]);
  await expect(applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId,plan:replacement})).rejects.toMatchObject({status:409});
  await expect(applyHrPersonIdentityPlan(db.getPool(),{...reviewer,credentialVersion:'revoked'},{requestId,plan})).rejects.toMatchObject({status:401});
  expect(await identityDatabaseState(fixture.source)).toEqual(after);
});
it('rejects stale sources and both conflicting decisions before allocating rows or sequence values',async()=>{
  const p=await person(),plan=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p)]);
  await fixture.source.query('UPDATE users SET is_active=FALSE WHERE id=$1',[p.b.userId]);
  const before=await identityDatabaseState(fixture.source);
  await expect(applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId:`stale-${++serial}`,plan})).rejects.toMatchObject({status:409});
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
  for(const reverse of [false,true]){
    const pair=[decision(p),decision(p,{key:'two',staffId:null,expectedRevision:null,fullName:'Conflicting synthetic choice',userIds:[p.a.userId]})];
    const conflict=await reviewHrPersonIdentity(db.getPool(),reviewer,reverse?[...pair].reverse():pair);
    expect(conflict.steps.every(s=>s.conflicts.includes('duplicate_selection'))).toBe(true);
    await expect(applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId:`conflict-${++serial}`,plan:conflict})).rejects.toMatchObject({status:409});
  }
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
});
it('concurrent identical requests produce one receipt and one revision',async()=>{
  const p=await person(),plan=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p)]),input={requestId:`concurrent-${++serial}`,plan};
  const [a,b]=await Promise.all([applyHrPersonIdentityPlan(db.getPool(),reviewer,input),applyHrPersonIdentityPlan(db.getPool(),reviewer,input)]);
  expect(a).toEqual(b);expect((await fixture.source.query('SELECT identity_revision FROM hr_staff WHERE id=$1',[p.staffId])).rows[0].identity_revision).toBe(1);
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_identity_import_runs WHERE plan_digest=$1',[plan.planDigest])).rows[0].n).toBe(1);
});
it('competing plans for the same unlinked accounts create one person, never a phantom second identity',async()=>{
  const p=await person(false),first=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p)]);
  const second=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p,{fullName:'Different explicit label'})]);
  const outcomes=await Promise.allSettled([
    applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId:`race-first-${++serial}`,plan:first}),
    applyHrPersonIdentityPlan(db.getPool(),reviewer,{requestId:`race-second-${++serial}`,plan:second}),
  ]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(outcomes.find(r=>r.status==='rejected')).toMatchObject({status:'rejected',reason:{status:409}});
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_staff_account_links WHERE user_id=$1 AND closed_at IS NULL',[p.a.userId])).rows[0].n).toBe(1);
});
it('session expiry while waiting for an identity lock refuses the entire command',async()=>{
  const p=await person(),plan=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p)]),before=await identityDatabaseState(fixture.source);
  const blocker=await fixture.source.connect(),expiring={...reviewer,expiresAt:Date.now()+600};
  let outcome:Promise<unknown>|undefined;
  try{
    await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('hr-person-identity-v1',0))");
    const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    outcome=applyHrPersonIdentityPlan(db.getPool(),expiring,{requestId:`expiry-${++serial}`,plan}).then(()=>({ok:true}),error=>({ok:false,error}));
    let blocked=false;for(let i=0;i<100;i++){
      blocked=(await blocker.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;
      if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(blocked).toBe(true);await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiring.expiresAt-Date.now())+30));
    await blocker.query('COMMIT');expect(await outcome).toMatchObject({ok:false,error:{status:401}});
  }finally{await blocker.query('ROLLBACK');blocker.release();await outcome;}
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
});
it('an injected mid-transaction failure rolls back profile, links, receipt, events and audit together',async()=>{
  const p=await person(),plan=await reviewHrPersonIdentity(db.getPool(),reviewer,[decision(p)]);
  const before=await protectedState(),profile=(await fixture.source.query('SELECT * FROM hr_staff WHERE id=$1',[p.staffId])).rows[0];
  const pool={connect:async()=>{const c=await db.getPool().connect();return {release:()=>c.release(),query:async(sql:string,values?:unknown[])=>{
    if(sql.startsWith('INSERT INTO hr_staff_party_links'))throw new Error('synthetic injected failure');return c.query(sql,values);
  }};}} as ReturnType<typeof db.getPool>;
  await expect(applyHrPersonIdentityPlan(pool,reviewer,{requestId:`rollback-${++serial}`,plan})).rejects.toThrow('synthetic injected failure');
  expect(await protectedState()).toEqual(before);expect((await fixture.source.query('SELECT * FROM hr_staff WHERE id=$1',[p.staffId])).rows[0]).toEqual(profile);
  for(const table of ['hr_staff_account_links','hr_staff_party_links','hr_identity_events'])expect((await fixture.source.query(`SELECT count(*)::int AS n FROM ${table} WHERE staff_id=$1`,[p.staffId])).rows[0].n).toBe(0);
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_identity_import_runs WHERE plan_digest=$1',[plan.planDigest])).rows[0].n).toBe(0);
});
it('leave and attendance reject the beneficiary second account; another reviewer can approve once',async()=>{
  const p=await person();await apply(p);
  await work.adjustLeaveBalance({staffId:p.staffId!,leaveTypeCode:'annual',year:2026,allocatedDays:10},reviewer);
  const leave=await work.createLeaveRequest({staffId:p.staffId!,leaveTypeCode:'annual',startDate:'2026-09-10',endDate:'2026-09-10',daysCount:1,reason:'Synthetic leave'},p.a);
  const row=(await fixture.source.query('SELECT requester_user_id,identity_evidence FROM hr_leave_requests WHERE id=$1',[leave.id])).rows[0];
  expect(row.requester_user_id).toBe(p.a.userId);expect(row.identity_evidence.subjectStaffId).toBe(p.staffId);
  const before=await identityDatabaseState(fixture.source);
  await expect(work.decideLeaveRequest(leave.id,'approved','Self via second account',p.b)).rejects.toMatchObject({status:403});
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
  const approved=await work.decideLeaveRequest(leave.id,'approved','Independent approval',reviewer);expect(approved.status).toBe('approved');
  const after=await identityDatabaseState(fixture.source);await work.decideLeaveRequest(leave.id,'approved','Replay',reviewer);expect(await identityDatabaseState(fixture.source)).toEqual(after);
  const attendance=await work.recordAttendance({staffId:p.staffId!,attendanceDate:'2026-09-11',checkIn:'2026-09-11T08:00:00Z',checkOut:'2026-09-11T16:00:00Z'},reviewer);
  const correction=await work.requestAttendanceCorrection({attendanceRecordId:attendance.id,fieldCorrected:'check_in',newCheckIn:'2026-09-11T09:00:00Z',reason:'Synthetic correction'},p.a);
  await expect(work.decideAttendanceCorrection(correction.id,'approved','Self via second account',p.b)).rejects.toMatchObject({status:403});
  expect((await work.decideAttendanceCorrection(correction.id,'approved','Independent approval',reviewer)).status).toBe('approved');
});
it('closing a requester second-account link preserves historical self-approval denial for another beneficiary',async()=>{
  const p=await person(),other=await person();await apply(p);
  const attendance=await work.recordAttendance({staffId:other.staffId!,attendanceDate:'2026-09-12',checkIn:'2026-09-12T08:00:00Z',checkOut:'2026-09-12T16:00:00Z'},reviewer);
  const correction=await work.requestAttendanceCorrection({attendanceRecordId:attendance.id,fieldCorrected:'check_in',newCheckIn:'2026-09-12T09:00:00Z',reason:'Request for another worker'},p.a);
  const link=(await fixture.source.query('SELECT id::text FROM hr_staff_account_links WHERE user_id=$1 AND closed_at IS NULL',[p.b.userId])).rows[0];
  await apply(p,{expectedRevision:1,userIds:[p.a.userId],closeAccountLinkIds:[link.id]});
  expect(await staffIdentityForUser(fixture.source,p.b.userId)).toBeNull();
  const before=await identityDatabaseState(fixture.source);
  await expect(work.decideAttendanceCorrection(correction.id,'approved','Closed link bypass attempt',p.b)).rejects.toMatchObject({status:403});
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
  expect((await fixture.source.query('SELECT closed_at,closed_event_id FROM hr_staff_account_links WHERE id=$1',[link.id])).rows[0].closed_event_id).not.toBeNull();
});
it('history and legacy access cannot be rewritten or deleted, even by direct SQL',async()=>{
  const p=await person(),receipt=await apply(p);
  await expect(fixture.source.query('UPDATE hr_staff SET user_id=NULL WHERE id=$1',[p.staffId])).rejects.toThrow(/legacy access/);
  await expect(fixture.source.query('DELETE FROM hr_staff_account_links WHERE staff_id=$1',[p.staffId])).rejects.toThrow(/cannot be deleted/);
  await expect(fixture.source.query('DELETE FROM hr_identity_events WHERE staff_id=$1',[p.staffId])).rejects.toThrow(/append-only/);
  await expect(fixture.source.query('UPDATE hr_identity_import_runs SET response=\'{}\' WHERE id=$1',[receipt.runId])).rejects.toThrow(/append-only/);
  await expect(fixture.source.query('INSERT INTO hr_staff_account_links(staff_id,user_id,opened_event_id) SELECT staff_id,user_id,opened_event_id FROM hr_staff_account_links WHERE staff_id=$1 LIMIT 1',[p.staffId])).rejects.toMatchObject({code:'23505'});
});
it('a missing uniqueness guard fails closed rather than accepting a new schema fingerprint',async()=>{
  await fixture.source.query('DROP INDEX hr_staff_account_links_current_user');
  try{await expect(readHrIdentityPreview(fixture.source,reviewer)).rejects.toMatchObject({status:503});}
  finally{await fixture.source.query('CREATE UNIQUE INDEX hr_staff_account_links_current_user ON hr_staff_account_links(user_id) WHERE closed_at IS NULL');}
});
it('partial schema fails closed instead of falling back or bootstrapping',async()=>{
  await fixture.source.query('ALTER TABLE hr_staff_party_links RENAME TO synthetic_hidden_identity_links');
  try{await expect(readHrIdentityPreview(fixture.source,reviewer)).rejects.toMatchObject({status:503});}
  finally{await fixture.source.query('ALTER TABLE synthetic_hidden_identity_links RENAME TO hr_staff_party_links');}
});
