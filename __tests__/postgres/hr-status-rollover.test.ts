import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import type { DbClient, DbPool } from '../../lib/db';
import { recordHrHistory } from '../../lib/hr-temporal-write';
import { hrTemporalAuthority } from '../../lib/hr-temporal-authority';
import { parseHrHistoryCommand } from '../../lib/hr-temporal-request';
import { readOperationalEmployment } from '../../lib/hr-operational-employment';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>, runtime: typeof import('../../lib/db');
let hr: typeof import('../../lib/hr'), pay: typeof import('../../lib/hr-payroll'), actor: SessionPayload, native: DbPool;
const original = process.env.DATABASE_URL;
let clock = '2026-10-31T20:59:59.999Z', sequence = 0;
// Test-only SQL adapter: real PostgreSQL and application calls, controlled instant; no production clock switch.
function wrap(client: DbClient): DbClient {
  return { release: () => client.release(), query: async <T>(sql: string, args?: unknown[]) => {
    const fixed = sql.replaceAll('clock_timestamp()', `'${clock}'::timestamptz`);
    return client.query<T>(fixed, args);
  } };
}
beforeAll(async () => {
  process.env.SESSION_SECRET = 'rollover-synthetic-session-secret-0123456789';
  fixture = await openBackupTimestampFixture({ ...process.env }); process.env.DATABASE_URL = fixture.source.options.connectionString!;
  runtime = await import('../../lib/db'); await runtime.resetPoolForTesting(); await runtime.ensureSchema(); native = runtime.getPool();
  // Runtime installs the schema but creates no undocumented employment history.
  expect((await readOperationalEmployment(native, [])).timeline(999)).toEqual({ revision: 0, facts: [] });
  const user = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('rollover-admin','Synthetic manager','synthetic-hash','admin') RETURNING id")).rows[0];
  actor = { userId: user.id, username: 'rollover-admin', role: 'admin', expiresAt: Date.now()+3600000, credentialVersion: sessionCredentialVersion('synthetic-hash') };
  const controlled: DbPool = { connect: async () => wrap(await native.connect()), query: native.query.bind(native) };
  vi.spyOn(runtime, 'getPool').mockReturnValue(controlled); hr = await import('../../lib/hr'); pay = await import('../../lib/hr-payroll');
});
afterAll(async () => { vi.restoreAllMocks(); try { await runtime?.resetPoolForTesting(); } finally { process.env.DATABASE_URL=original; await fixture?.close(); } });
async function staff(status = 'active', currency = 'YER') {
  return Number((await fixture.source.query(`INSERT INTO hr_staff(full_name,created_by,work_status,hire_date,contract_kind,salary_amount_minor,salary_currency,salary_period,salary_effective_on)
    VALUES($1,'test',$2,'2020-01-01','salary',10000,$3,'monthly','2020-01-01') RETURNING id`, [`Synthetic rollover ${++sequence}`,status,currency])).rows[0].id);
}
const fact = (id: string, from: string, to: string | null, status: string) => ({ id, kind: 'known', from, to, value: { status } });
async function record(id: number, facts: ReturnType<typeof fact>[], revision=0, supersedeIds: string[]=[]) {
  return recordHrHistory(native, hrTemporalAuthority(actor), parseHrHistoryCommand({ requestId:`rollover-history-request-${id}-${++sequence}`, expectedUsername:actor.username, expectedRevision:revision, reason:'Synthetic effective decision',supersedeIds,append:facts }, 'employment', id));
}
const task = (id: number | null, requestId = `rollover-task-${++sequence}`) => ({ title: 'Synthetic assignment', description: '',isPrivate:false,priority:'normal' as const,dueAt:null,plannedFor:null,assigneeStaffId:id,clientRequestId:requestId });
async function financial() { return (await fixture.source.query(`SELECT jsonb_build_object(
  'runs',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM hr_payroll_runs t),
  'items',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM hr_payroll_items t),
  'payables',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM payables t),
  'expenses',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM expenses t)) AS snapshot`)).rows[0].snapshot; }
it('rolls list/detail/filter/directory/report and task admission at clinic midnight, then reactivates without touching profile or identity', async () => {
  const id=await staff();
  await record(id,[fact('a','2026-01-01','2026-11-01','active'),fact('s','2026-11-01','2026-11-02','suspended'),fact('r','2026-11-02',null,'active')]);
  clock='2026-10-31T20:59:59.999Z';
  const before=await pay.getHrReportSummary();
  expect((await hr.listStaffDirectory()).some(s=>s.id===id)).toBe(true);
  const input=task(id), created=await hr.createTask(input,actor); expect(created.ok).toBe(true);
  clock='2026-10-31T21:00:00.000Z';
  expect((await hr.getStaffDetail(id))?.staff).toMatchObject({workStatus:'active',operationalEmployment:{status:'suspended',asOfDay:'2026-11-01'}});
  expect((await hr.listStaff({includePayTerms:true,status:'active'})).some(s=>s.id===id)).toBe(false);
  expect((await hr.listStaffDirectory()).some(s=>s.id===id)).toBe(false);
  const after=await pay.getHrReportSummary(); expect(after.staffSummary.activeStaff).toBe(before.staffSummary.activeStaff-1);
  expect(await hr.createTask(task(id),actor)).toMatchObject({ok:false,status:400});
  expect(await hr.createTask(input,actor)).toEqual(created); // Original receipt survives changed eligibility.
  const unassigned=await hr.createTask(task(null),actor); if(!unassigned.ok) throw new Error(unassigned.error);
  expect(await hr.updateTask(unassigned.value.id,{assigneeStaffId:id},actor)).toMatchObject({ok:false,status:400});
  clock='2026-11-01T21:00:00.000Z';
  expect((await hr.listStaffDirectory()).some(s=>s.id===id)).toBe(true);
  expect(await hr.updateTask(unassigned.value.id,{assigneeStaffId:id},actor)).toMatchObject({ok:true});
  expect((await fixture.source.query('SELECT work_status FROM hr_staff WHERE id=$1',[id])).rows[0].work_status).toBe('active');
  expect((await fixture.source.query('SELECT role,is_active FROM users WHERE id=$1',[actor.userId])).rows[0]).toEqual({role:'admin',is_active:true});
});
it('future-only first history and a gap never fall back to active', async()=>{
  const id=await staff();clock='2026-10-31T21:00:00.000Z';
  await record(id,[fact('future','2026-11-02',null,'active')]);
  expect((await hr.getStaffDetail(id))?.staff.operationalEmployment?.status).toBe('unknown');
  expect((await hr.listStaffDirectory()).some(s=>s.id===id)).toBe(false);
  expect(await hr.createTask(task(id),actor)).toMatchObject({ok:false,status:400});
});
it('first history writer and task admission serialize on the real staff lock', async()=>{
  const id=await staff(), hold=await native.connect(); await hold.query('BEGIN');
  try {
    await hold.query('SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE',[id]);
    let reached!:()=>void; const ready=new Promise<void>(r=>{reached=r;});
    const intercepted: DbPool={query:native.query.bind(native),connect:async()=>{
      const client=await native.connect();return{release:()=>client.release(),query:async<T>(sql:string,args?:unknown[])=>{
        if(sql==='SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE') reached();return client.query<T>(sql,args);
      }};
    }};
    const input=parseHrHistoryCommand({requestId:`wait-first-history-${id}`,expectedUsername:actor.username,expectedRevision:0,reason:'Synthetic first history',supersedeIds:[],append:[fact('end','2026-01-01',null,'ended')]},'employment',id);
    const writer=recordHrHistory(intercepted,hrTemporalAuthority(actor),input);await ready;
    // Wait until PostgreSQL confirms the writer is queued, not merely until the promise started.
    await expect.poll(async()=>Number((await fixture.source.query("SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE'")).rows[0].n)).toBeGreaterThan(0);
    const assignment=hr.createTask(task(id),actor);await hold.query('COMMIT');await writer;
    expect(await assignment).toMatchObject({ok:false,status:400});
  } finally {await hold.query('ROLLBACK');hold.release();}
});
it.each(['create','reassign'])('samples the clinic date after a real %s lock wait instead of transaction start',async mode=>{
  const id=await staff();await record(id,[fact('a','2026-01-01','2026-11-01','active'),fact('s','2026-11-01',null,'suspended')]);
  const unassigned=await hr.createTask(task(null),actor); if(!unassigned.ok) throw new Error(unassigned.error);
  const hold=await native.connect();await hold.query('BEGIN');clock='2026-10-31T20:59:59Z';
  try{
    await hold.query('SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE',[id]);
    const waiting=mode==='create'?hr.createTask(task(id),actor):hr.updateTask(unassigned.value.id,{assigneeStaffId:id},actor);
    await expect.poll(async()=>Number((await fixture.source.query("SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id, full_name, user_id, work_status FROM hr_staff%'")).rows[0].n)).toBeGreaterThan(0);
    clock='2026-10-31T21:00:00Z';await hold.query('COMMIT');expect(await waiting).toMatchObject({ok:false,status:400});
  }finally{await hold.query('ROLLBACK');hold.release();}
});
it('a later correction is observed and an old replay cannot restore operational state',async()=>{
  const id=await staff();await record(id,[fact('active','2026-01-01',null,'active')]);
  await record(id,[fact('ended','2026-01-01',null,'ended')],1,['active']);
  expect((await hr.getStaffDetail(id))?.staff.operationalEmployment).toMatchObject({status:'ended',revision:2});
  expect(await hr.updateStaff(id,{workStatus:'ended',reason:'Legacy bypass'},actor)).toMatchObject({ok:false,status:409});
});
it('does not silently skip an unknown historical period using an old end date, and keeps currencies independent',async()=>{
  const id=await staff('ended','SAR');
  await fixture.source.query("UPDATE hr_staff SET hire_date='2010-01-01',salary_effective_on='2010-01-01',end_date='2017-12-31' WHERE id=$1",[id]);
  await record(id,[fact('future','2030-01-01',null,'active')]);
  const period=await pay.getOrCreatePayrollPeriod('2018-10',actor), before=await financial();
  await expect(pay.calculatePayrollRun(period.id,'SAR',actor)).rejects.toMatchObject({code:'employment_history_required'});
  expect(await financial()).toEqual(before);
  const usd=await pay.calculatePayrollRun(period.id,'USD',actor);expect(usd.totalNetDueMinor).toBe(0);
});

it('payroll compares the target period and rolls back recalculation/approval when new history makes it unresolved',async()=>{
  // Keep this case isolated from earlier synthetic staff, without rewriting immutable history.
  const id=await staff('active','USD'), period=await pay.getOrCreatePayrollPeriod('2019-10',actor);
  await fixture.source.query("UPDATE hr_staff SET hire_date='2010-01-01',salary_effective_on='2010-01-01' WHERE id=$1",[id]);
  await record(id,[fact('active','2019-10-01','2019-11-01','active'),fact('suspended','2019-11-01',null,'suspended')]);
  clock='2026-11-15T00:00:00Z';
  const run=await pay.calculatePayrollRun(period.id,'USD',actor);
  const before=await financial();expect(run.totalNetDueMinor).toBe(10000);
  await record(id,[fact('partial-active','2019-10-01','2019-10-15','active'),fact('partial-pause','2019-10-15',null,'suspended')],1,['active','suspended']);
  await expect(pay.calculatePayrollRun(period.id,'USD',actor)).rejects.toMatchObject({code:'employment_history_required'});
  expect(await financial()).toEqual(before);
  await expect(pay.approvePayrollRun(run.id,actor)).rejects.toMatchObject({code:'employment_history_required'});
  expect(await financial()).toEqual(before);
});
