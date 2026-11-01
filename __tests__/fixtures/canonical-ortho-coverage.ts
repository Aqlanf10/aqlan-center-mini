/** Synthetic commercial lineage only. No owner issuance or real financial history. */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { readFollowupCoverageSnapshotWith } from "../../lib/ortho-followup-coverage-db";
let sequence = 0;
export async function seedCanonicalCoverage(q: Pick<Pool, "query">, input: { patientId: number; actorId: number; doctorId: number; caseId?: number; save?: boolean }) {
  const n = ++sequence, patient = input.patientId;
  const ortho = input.caseId ?? (await q.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'SYN','completed') RETURNING id", [patient])).rows[0].id;
  const clinical = (await q.query("INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN private clinical title','both',$2,'SYN') RETURNING id", [patient, ortho])).rows[0].id;
  const plan = (await q.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,consent_at,consent_by) VALUES($1,'SYN private plan',250000,'YER',NOW(),'SYN') RETURNING id", [patient])).rows[0].id;
  const service = (await q.query("INSERT INTO services(name,category,price_minor) VALUES('SYN invoice service','ortho',250000) RETURNING id")).rows[0].id;
  const invoice = (await q.query("INSERT INTO invoices(patient_id,invoice_number,total_minor,base_currency) VALUES($1,$2,250000,'YER') RETURNING id", [patient, `SYN-COV-INVOICE-${n}`])).rows[0].id;
  const item = (await q.query(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count)
    VALUES($1,$2,$3,'SYN invoice service','ortho',$4,1,250000,'billed',$5,$5,'invoice',12) RETURNING id`, [plan, clinical, service, input.doctorId, invoice])).rows[0].id;
  await q.query(`INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,source_type,source_id,plan_item_id)
    VALUES($1,$2,$3,'SYN invoice service',1,250000,250000,'plan_item',$4::bigint,$4::int)`, [invoice, service, input.doctorId, item]);
  let snapshot: unknown;
  const observed = { query: async (sql: string, values?: unknown[]) => {
    const result = await q.query(sql, values);
    if (sql.startsWith("WITH candidates AS MATERIALIZED")) snapshot = result.rows[0]?.sources?.[0]?.snapshot;
    return result;
  } } as Pick<Pool, "query">;
  const source = (await readFollowupCoverageSnapshotWith(observed, patient, ortho)).sources[0];
  if (!source || !snapshot) throw new Error("Synthetic coverage lineage was not valid");
  let revision: string | null = null;
  if (input.save !== false) revision = (await q.query(`INSERT INTO ortho_followup_coverage_revisions(patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,1,'routine_adjustments','included',$7,$10::jsonb,'SYN سبب الاتفاق المحفوظ',$8,'SYN actor',$9,repeat('a',64)) RETURNING id::text`,
    [patient, ortho, clinical, plan, item, invoice, source.fingerprint, input.actorId, randomUUID(), JSON.stringify(snapshot)])).rows[0].id;
  return { patient, ortho, clinical, plan, service, invoice, item, revision, source };
}
