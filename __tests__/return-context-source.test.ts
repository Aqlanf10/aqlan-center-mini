import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createPatient, createPlanV2, createService, ensureSchema, getClinicalVisit, getPool, resetPoolForTesting } from '../lib/db';

beforeAll(async () => {
  vi.stubEnv('USE_LOCAL_DB', 'true'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('RAILWAY_PROJECT_ID', '');
  await ensureSchema();
}, 30000);
afterAll(async () => { await resetPoolForTesting(); });
let sequence = 0;
const patient = () => createPatient({fullName: `Synthetic return context ${++sequence}`, phone:null, altPhone:null,
  gender:'male', birthYear:1990, address:null, medicalAlert:null, note:null});
async function visit(patientId:number, arrived:string, signed:string|null, diagnosis:string|null) {
  return (await getPool().query(`INSERT INTO visits(patient_name, patient_id, arrived_at, signed_at, diagnosis)
    VALUES ('Synthetic', $1, $2::timestamptz, $3::timestamptz, $4) RETURNING id`, [patientId,arrived,signed,diagnosis])).rows[0].id as number;
}
it('uses preceding encounter chronology, not latest signature or future encounter', async () => {
  const p = await patient();
  await visit(p.id,'2026-09-01T08:00Z','2026-09-04T08:00Z','Older encounter signed late');
  const preceding = await visit(p.id,'2026-09-02T08:00Z','2026-09-02T09:00Z','Preceding encounter');
  const current = await visit(p.id,'2026-09-03T08:00Z',null,null);
  await visit(p.id,'2026-09-05T08:00Z','2026-09-05T09:00Z','Future encounter');
  const loaded = await getClinicalVisit(current);
  expect(loaded?.previousVisit?.id).toBe(preceding);
  expect(loaded?.latestDiagnosis?.text).toBe('Preceding encounter');
});
it('does not classify initial encounter as return because a later encounter was signed', async () => {
  const p = await patient();
  const current = await visit(p.id,'2026-09-01T08:00Z',null,null);
  await visit(p.id,'2026-09-02T08:00Z','2026-09-02T09:00Z','Later');
  expect(await getClinicalVisit(current)).toMatchObject({previousVisit:null, latestDiagnosis:null});
});
it('uses ID as a stable same-instant encounter tie-breaker', async () => {
  const p = await patient();
  const before = await visit(p.id,'2026-09-01T08:00Z','2026-09-03T08:00Z','Before');
  const current = await visit(p.id,'2026-09-01T08:00Z',null,null);
  await visit(p.id,'2026-09-01T08:00Z','2026-09-04T08:00Z','After');
  expect((await getClinicalVisit(current))?.previousVisit?.id).toBe(before);
});
it('uses each unfinished item provider and leaves conflicting or unresolved work explicit', async () => {
  const p = await patient();
  const doctors = (await getPool().query(`INSERT INTO parties(kind,name) VALUES ('doctor','Synthetic A'), ('doctor','Synthetic B') RETURNING id`)).rows;
  const service = await createService({name:'Synthetic context service',category:'rct',priceMinor:1000});
  const created = await createPlanV2({patientId:p.id,title:'Synthetic',specialty:null,primaryDoctorId:doctors[0].id,
    billingMode:'per_procedure',baseCurrency:'YER',startDate:'2026-09-01',note:null,createdBy:'test',installments:[],
    items:[1,2].map(tooth => ({serviceId:service.id,serviceName:service.name,category:'rct',toothCode:10+tooth,
      surfaces:null,quantity:1,unitPriceMinor:1000,billingRule:'per_session',sessionCount:2,note:null}))});
  if (!created.ok) throw new Error(created.message);
  const current = await visit(p.id,'2026-09-02T08:00Z',null,null);
  await getPool().query(`UPDATE plan_items SET doctor_id=$2 WHERE plan_id=$1`,[created.planId,doctors[1].id]);
  expect((await getClinicalVisit(current))?.suggestions.doctorId).toBe(doctors[1].id);
  await getPool().query(`UPDATE plan_items SET doctor_id=$2 WHERE plan_id=$1 AND tooth_code=11`,[created.planId,doctors[0].id]);
  expect((await getClinicalVisit(current))?.suggestions.doctorId).toBeNull();
  await getPool().query(`UPDATE parties SET is_active=false WHERE id=$1`,[doctors[1].id]);
  expect((await getClinicalVisit(current))?.suggestions.doctorId).toBeNull();
});
