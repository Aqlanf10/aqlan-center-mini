import type { Pool } from "pg";
import { seedCanonicalClinicalPlan } from "./canonical-clinical-plans";

export async function seedCanonicalPatientCases(q: Pick<Pool, "query">, patientId: number, doctorId?: number) {
  const saved = await seedCanonicalClinicalPlan(q, patientId, doctorId);
  const caseId = Number((await q.query(`INSERT INTO clinical_cases(patient_id,specialty,title,site,problem,responsible_party_id,status,created_by)
    VALUES($1,'endodontics','SYN root case','26','SYN recorded problem',$2,'active','SYN clinician') RETURNING id`, [patientId, doctorId ?? null])).rows[0].id);
  await q.query("UPDATE plan_items SET case_id=$1,priority=3 WHERE id=$2", [caseId, saved.item]);
  const prerequisite = Number((await q.query("INSERT INTO plan_items(plan_id,service_name,status) VALUES($1,'SYN prerequisite','done') RETURNING id", [saved.plan])).rows[0].id);
  await q.query("INSERT INTO plan_item_dependencies(item_id,requires_item_id,requirement,note,created_by) VALUES($1,$2,'completed','SYN dependency note','SYN clinician')", [saved.item, prerequisite]);
  const problemId = Number((await q.query("INSERT INTO patient_problems(patient_id,label,site,specialty,case_id,noted_by) VALUES($1,'SYN case problem','26','endodontics',$2,'SYN clinician') RETURNING id", [patientId, caseId])).rows[0].id);
  return { ...saved, caseId, prerequisite, problemId };
}
