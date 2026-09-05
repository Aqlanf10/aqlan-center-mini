import { beforeAll, describe, expect, it, vi } from 'vitest';
import { arriveAppointment, ClinicalPlanConflict, createPatient, createPlanV2, createService, ensureSchema,
  getClinicalVisit, getInventoryItemDetail, getPool, inventoryAlerts, listPatientPlannedVisits,
  recordPlanConsent, schedulePlannedVisit, setVisitProcedures, signClinicalVisit,
  startVisitFromPlannedVisit } from '../lib/db';
import { checkSlot, type Appointment } from '../lib/schedule';
import { batchRemaining } from '../lib/inventory';

beforeAll(async () => {
  vi.stubEnv('USE_LOCAL_DB', 'true');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('RAILWAY_PROJECT_ID', '');
  await ensureSchema();
}, 30000);
let counter = 0;
async function patient() {
  return createPatient({ fullName: `Clinical regression ${++counter}`, phone: null, altPhone: null,
    gender: 'male', birthYear: 1990, address: null, medicalAlert: null, note: null });
}
async function plan(rule: 'on_start' | 'on_completion' | 'per_session', count = 2) {
  const p = await patient();
  const service = await createService({ name: `Regression service ${++counter}`, category: 'rct', priceMinor: 10000 });
  const result = await createPlanV2({ patientId: p.id, title: 'Regression', specialty: 'general',
    primaryDoctorId: null, billingMode: 'per_procedure', baseCurrency: 'YER', startDate: '2026-09-07',
    note: null, createdBy: 'test', items: [{ serviceId: service.id, serviceName: service.name,
      category: 'rct', toothCode: 11, surfaces: null, quantity: 1, unitPriceMinor: 10000,
      billingRule: rule, sessionCount: count, note: null }], installments: [] });
  if (!result.ok) throw new Error(result.message);
  await recordPlanConsent({ planId: result.planId, actor: 'test', note: 'synthetic' });
  const item = (await getPool().query<{id: number}>(`SELECT id FROM plan_items WHERE plan_id=$1`, [result.planId])).rows[0];
  const procedure = { serviceId: service.id, toothCode: 11, surfaces: null, quantity: 1,
    unitPriceMinor: 999999, doctorId: null, note: null, planItemId: item.id };
  return { p, service, planId: result.planId, item, procedure };
}
async function visit(patientId: number) {
  return (await getPool().query<{id: number}>(`INSERT INTO visits(patient_name,patient_id) VALUES ('synthetic',$1) RETURNING id`, [patientId])).rows[0].id;
}
const sign = (visitId: number) => signClinicalVisit({ visitId, baseCurrency: 'YER', signedBy: 'test' });

describe('clinical release regressions', () => {
  it('rejects another patient plan and mismatched service/tooth without saving procedures', async () => {
    const a = await plan('on_start');
    const b = await patient();
    const id = await visit(b.id);
    await expect(setVisitProcedures({ visitId: id, procedures: [a.procedure] })).rejects.toBeInstanceOf(ClinicalPlanConflict);
    expect((await getClinicalVisit(id))?.procedures).toHaveLength(0);
    const own = await visit(a.p.id);
    await expect(setVisitProcedures({ visitId: own, procedures: [{ ...a.procedure, toothCode: 12 }] })).rejects.toBeInstanceOf(ClinicalPlanConflict);
    const otherService = await createService({name:'Other regression service', category:'rct', priceMinor:1});
    await expect(setVisitProcedures({ visitId: own, procedures: [{ ...a.procedure, serviceId: otherService.id }] })).rejects.toBeInstanceOf(ClinicalPlanConflict);
    // Revalidate at signature even if an old or imported invalid link already exists.
    await getPool().query(`INSERT INTO visit_procedures(visit_id,service_id,tooth_code,quantity,unit_price_minor,plan_item_id)
      VALUES ($1,$2,11,1,10000,$3)`, [id,a.service.id,a.item.id]);
    await expect(sign(id)).rejects.toBeInstanceOf(ClinicalPlanConflict);
    expect((await getPool().query(`SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1`,[b.id])).rows[0].n).toBe(0);
    expect((await getPool().query(`SELECT count(*)::int AS n FROM treatment_sessions WHERE plan_item_id=$1 AND status='done'`,[a.item.id])).rows[0].n).toBe(0);
  });

  it.each(['on_start','on_completion','per_session'] as const)('reprices previously saved visits under %s', async rule => {
    const a = await plan(rule);
    const first = await visit(a.p.id); const second = await visit(a.p.id);
    await setVisitProcedures({ visitId: first, procedures: [a.procedure] });
    await setVisitProcedures({ visitId: second, procedures: [a.procedure] });
    const one = await sign(first); const two = await sign(second);
    expect(one.reason).toBeNull(); expect(two.reason).toBeNull();
    expect(one.duesMinor + two.duesMinor).toBe(10000);
    expect([one.duesMinor,two.duesMinor]).toEqual(rule === 'on_start' ? [10000,0] : rule === 'on_completion' ? [0,10000] : [5000,5000]);
    const invoices = (await getPool().query(`SELECT sum(total_minor)::int AS n FROM invoices WHERE patient_id=$1`,[a.p.id])).rows[0];
    expect(invoices.n).toBe(10000);
  });

  it('keeps plan links on arrival, prevents duplicate visits, and suggests only the next session', async () => {
    const a = await plan('per_session',4);
    const [pv] = await listPatientPlannedVisits(a.p.id);
    const booked = await schedulePlannedVisit({ plannedVisitId: pv.id,date:'2026-09-07',time:'09:00',chairs:10 });
    if (!booked.ok) throw new Error(booked.reason);
    expect(await arriveAppointment(booked.appointmentId)).toBe(true);
    const current = (await getPool().query(`SELECT id,planned_visit_id FROM visits WHERE appointment_id=$1`,[booked.appointmentId])).rows[0];
    expect(current.planned_visit_id).toBe(pv.id);
    expect((await getClinicalVisit(current.id))?.plannedVisit?.id).toBe(pv.id);
    expect(await startVisitFromPlannedVisit({plannedVisitId:pv.id,actor:'test'})).toEqual({alreadyActive:true,visitId:current.id});
    expect(await arriveAppointment(booked.appointmentId)).toBe(false);
    await setVisitProcedures({visitId:current.id,procedures:[a.procedure]});
    const completed = await sign(current.id);
    expect(completed.nextPlannedVisit?.durationMinutes).toBe(30);
    const sessions = (await getPool().query(`SELECT sequence FROM treatment_sessions WHERE planned_visit_id=$1`,[completed.nextPlannedVisit?.id])).rows;
    expect(sessions.map(r=>r.sequence)).toEqual([2]);
    expect((await getPool().query(`SELECT status FROM planned_visits WHERE id=$1`,[pv.id])).rows[0].status).toBe('completed');
    expect((await getPool().query(`SELECT status FROM appointments WHERE id=$1`,[booked.appointmentId])).rows[0].status).toBe('done');
  });

  it('retains expiration alerts after more than 200 movements', async () => {
    const {rows:[item]} = await getPool().query(`INSERT INTO inventory_items(name,category,unit,min_level,created_by) VALUES ('Regression batch','other','unit',0,'test') RETURNING id`);
    await getPool().query(`INSERT INTO inventory_movements(item_id,kind,qty,expiry_date,created_by,created_at) VALUES ($1,'in',1000,'2026-01-01','test','2025-01-01')`,[item.id]);
    await getPool().query(`INSERT INTO inventory_movements(item_id,kind,qty,created_by,created_at) SELECT $1,'out',1,'test','2025-01-02'::timestamptz + n*INTERVAL '1 minute' FROM generate_series(1,200) n`,[item.id]);
    const detail=await getInventoryItemDetail(item.id);
    expect(detail?.movements).toHaveLength(200);
    expect(detail?.item.balance).toBe(800);
    expect(detail?.batches.batches[0].remaining).toBe(800);
    expect((await inventoryAlerts('2026-09-07')).expired.find(b=>b.itemId===item.id)?.remaining).toBe(800);
  });
});

describe('capacity and batch chronology', () => {
  it('accepts a free chair across consecutive appointments but rejects genuine simultaneous overload', () => {
    const a: Appointment = {id:1,patientId:1,patientName:'test',patientPhone:null,scheduledDate:'2026-09-07',scheduledTime:'09:00',durationMinutes:30,status:'booked',note:null};
    const b={...a,id:2,scheduledTime:'09:30'};
    expect(checkSlot([a,b],a.scheduledDate,'09:00',60,2).allowed).toBe(true);
    expect(checkSlot([a,{...b,scheduledTime:'09:15'}],a.scheduledDate,'09:00',60,2).allowed).toBe(false);
  });
  it('does not consume a future batch for an earlier withdrawal', () => {
    const result=batchRemaining([
      {id:1,kind:'in',qty:10,createdAt:'2026-01-01',expiryDate:'2026-12-31'},
      {id:2,kind:'out',qty:10,createdAt:'2026-01-02',expiryDate:null},
      {id:3,kind:'in',qty:10,createdAt:'2026-02-01',expiryDate:'2026-03-01'},
    ]);
    expect(result.batches.find(b=>b.id===1)?.remaining).toBe(0);
    expect(result.batches.find(b=>b.id===3)?.remaining).toBe(10);
  });
});
