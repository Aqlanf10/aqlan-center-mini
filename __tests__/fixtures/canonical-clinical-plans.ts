import type { Pool } from "pg";

/** Synthetic native clinical facts, with conspicuous financial values that must not escape. */
export async function seedCanonicalClinicalPlan(q: Pick<Pool, "query">, patientId: number, doctorId?: number) {
  const plan = (await q.query(`INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,note,consent_at,consent_by,consent_note,start_date,created_at)
    VALUES($1,'SYN clinical treatment plan',9900123,'YER','SYN saved clinical note','2024-03-02T10:00:00Z','SYN recorder','SYN recorded consent','2024-03-01','2024-03-01T10:00:00Z') RETURNING id`, [patientId])).rows[0].id;
  const item = (await q.query(`INSERT INTO plan_items(plan_id,service_name,category,tooth_code,surfaces,quantity,unit_price_minor,note,doctor_id,session_count,planned_visit_number,sessions_completed)
    VALUES($1,'SYN recorded service','SYN saved category',26,'MO',2,9900123,'SYN item note',$2,3,2,99) RETURNING id`, [plan, doctorId ?? null])).rows[0].id;
  await q.query("INSERT INTO treatment_sessions(plan_item_id,sequence,status) VALUES($1,1,'done'),($1,2,'planned')", [item]);
  await q.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2024-04-01',9900123)", [plan]);
  return { plan: Number(plan), item: Number(item) };
}
