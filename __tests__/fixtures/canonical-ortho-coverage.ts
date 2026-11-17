/** Synthetic commercial lineage only. No owner issuance or real financial history. */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { readFollowupCoverageSnapshotWith } from "../../lib/ortho-followup-coverage-db";
import { withCoverageFixtureDiagnostics } from "./coverage-fixture-diagnostic";
import { observeCoverageSeedFailure } from "./coverage-seed-stage-diagnostic";
let sequence = 0;
export async function seedCanonicalCoverage(q: Pick<Pool, "query">, input: { patientId: number; actorId: number; doctorId: number; caseId?: number; save?: boolean; createdAt?: string }) {
  return withCoverageFixtureDiagnostics(() => seedCanonicalCoverageInner(q, input));
}

async function seedCanonicalCoverageInner(q: Pick<Pool, "query">, input: { patientId: number; actorId: number; doctorId: number; caseId?: number; save?: boolean; createdAt?: string }) {
  const n = ++sequence, patient = input.patientId;
  let ortho: number;
  try { ortho = input.caseId ?? (await q.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'SYN','completed') RETURNING id", [patient])).rows[0].id; }
  catch (error) { observeCoverageSeedFailure("case"); throw error; }
  let clinical: number;
  try { clinical = (await q.query("INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN private clinical title','both',$2,'SYN') RETURNING id", [patient, ortho])).rows[0].id; }
  catch (error) { observeCoverageSeedFailure("clinical"); throw error; }
  let plan: number;
  try { plan = (await q.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,consent_at,consent_by) VALUES($1,'SYN private plan',250000,'YER',NOW(),'SYN') RETURNING id", [patient])).rows[0].id; }
  catch (error) { observeCoverageSeedFailure("plan"); throw error; }
  let service: number;
  try { service = (await q.query("INSERT INTO services(name,category,price_minor) VALUES('SYN invoice service','ortho',250000) RETURNING id")).rows[0].id; }
  catch (error) { observeCoverageSeedFailure("service"); throw error; }
  let invoice: number;
  try { invoice = (await q.query("INSERT INTO invoices(patient_id,invoice_number,total_minor,base_currency) VALUES($1,$2,250000,'YER') RETURNING id", [patient, `SYN-COV-INVOICE-${n}`])).rows[0].id; }
  catch (error) { observeCoverageSeedFailure("invoice"); throw error; }
  let item: number;
  try { item = (await q.query(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count)
    VALUES($1,$2,$3,'SYN invoice service','ortho',$4,1,250000,'billed',$5,$5,'invoice',12) RETURNING id`, [plan, clinical, service, input.doctorId, invoice])).rows[0].id; }
  catch (error) { observeCoverageSeedFailure("plan_item"); throw error; }
  try { await q.query(`INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,source_type,source_id,plan_item_id)
    VALUES($1,$2,$3,'SYN invoice service',1,250000,250000,'plan_item',$4::bigint,$4::int)`, [invoice, service, input.doctorId, item]); }
  catch (error) { observeCoverageSeedFailure("invoice_item"); throw error; }
  let snapshot: unknown;
  const observed = { query: async (sql: string, values?: unknown[]) => {
    const result = await q.query(sql, values);
    if (sql.startsWith("WITH candidates AS MATERIALIZED")) snapshot = result.rows[0]?.sources?.[0]?.snapshot;
    return result;
  } } as Pick<Pool, "query">;
  let source: Awaited<ReturnType<typeof readFollowupCoverageSnapshotWith>>["sources"][number];
  try {
    const found = (await readFollowupCoverageSnapshotWith(observed, patient, ortho)).sources[0];
    if (!found || !snapshot) throw new Error("Synthetic coverage lineage was not valid");
    source = found;
  } catch (error) { observeCoverageSeedFailure("source"); throw error; }
  let revision: string | null = null;
  if (input.save !== false) {
    try { revision = (await q.query(`INSERT INTO ortho_followup_coverage_revisions(patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint,created_at)
    VALUES($1,$2,$3,$4,$5,$6,1,'routine_adjustments','included',$7,$10::jsonb,'SYN سبب الاتفاق المحفوظ',$8,'SYN actor',$9,repeat('a',64),COALESCE($11::timestamptz,NOW())) RETURNING id::text`,
      [patient, ortho, clinical, plan, item, invoice, source.fingerprint, input.actorId, randomUUID(), JSON.stringify(snapshot), input.createdAt ?? null])).rows[0].id; }
    catch (error) { observeCoverageSeedFailure("revision"); throw error; }
  }
  return { patient, ortho, clinical, plan, service, invoice, item, revision, source };
}
