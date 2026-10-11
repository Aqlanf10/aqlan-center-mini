import { ensureSchema, getPool, type DbClient } from "./db";
import type { ClinicalNavigationContext, TreatmentSubTab } from "./patient-navigation";

export type ClinicalContextResolution =
  | { ok: true; context: ClinicalNavigationContext; specialty: string | null; sub: TreatmentSubTab }
  | { ok: false; reason: "not_found" | "context_mismatch" | "ambiguous_visit" };

/** Exact recorded edges only. A navigation read must never link/create or choose latest work. */
export async function resolveClinicalNavigationContext(patientId: number, requested: ClinicalNavigationContext): Promise<ClinicalContextResolution> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await readContext(client, patientId, requested);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function readContext(db: DbClient, patientId: number, requested: ClinicalNavigationContext): Promise<ClinicalContextResolution> {
  const mismatch = { ok: false, reason: "context_mismatch" } as const;
  const missing = { ok: false, reason: "not_found" } as const;
  if (requested.patientId !== undefined && requested.patientId !== patientId) return mismatch;
  const context: ClinicalNavigationContext = { ...requested, patientId };
  let specialty: string | null = null;
  const { rows: patients } = await db.query("SELECT id FROM patients WHERE id = $1", [patientId]);
  if (!patients.length) return missing;
  if (context.planItemId !== undefined) {
    const { rows: [item] } = await db.query<{ plan_id: number; case_id: number | null }>(
      `SELECT i.plan_id, i.case_id FROM plan_items i JOIN treatment_plans p ON p.id = i.plan_id
        WHERE i.id = $1 AND p.patient_id = $2`, [context.planItemId, patientId]);
    if (!item) return missing;
    if ((context.planId !== undefined && context.planId !== item.plan_id)
      || (context.clinicalCaseId !== undefined && context.clinicalCaseId !== item.case_id)) return mismatch;
    context.planId = item.plan_id;
    if (item.case_id !== null) context.clinicalCaseId = item.case_id;
    else if (context.orthoCaseId !== undefined || context.endoTreatmentId !== undefined) return mismatch;
  }
  if (context.planId !== undefined) {
    const { rows } = await db.query("SELECT id FROM treatment_plans WHERE id = $1 AND patient_id = $2", [context.planId, patientId]);
    if (!rows.length) return missing;
    // A plan-only reference does not prove which of its potentially many cases is intended.
    if (context.planItemId === undefined && context.clinicalCaseId !== undefined) {
      const { rows: linked } = await db.query("SELECT id FROM plan_items WHERE plan_id = $1 AND case_id = $2 LIMIT 1", [context.planId, context.clinicalCaseId]);
      if (!linked.length) return mismatch;
    }
  }
  if (context.endoTreatmentId !== undefined) {
    const { rows: [episode] } = await db.query<{ case_id: number }>(
      "SELECT case_id FROM endo_treatments WHERE id = $1 AND patient_id = $2", [context.endoTreatmentId, patientId]);
    if (!episode) return missing;
    if (context.clinicalCaseId !== undefined && context.clinicalCaseId !== episode.case_id) return mismatch;
    if (context.orthoCaseId !== undefined) return mismatch;
    context.clinicalCaseId = episode.case_id;
  }
  if (context.visitId !== undefined) {
    const { rows: visits } = await db.query("SELECT id FROM visits WHERE id = $1 AND patient_id = $2", [context.visitId, patientId]);
    if (!visits.length) return missing;
    if (context.planId !== undefined) {
      // Patient membership or even a shared case is not execution of this plan.
      const { rows: linked } = await db.query(`SELECT 1 FROM plan_items i
        JOIN treatment_plans p ON p.id = i.plan_id WHERE p.patient_id = $2 AND p.id = $3 AND (
          i.visit_id = $1
          OR EXISTS (SELECT 1 FROM visit_procedures vp WHERE vp.visit_id = $1 AND vp.plan_item_id = i.id)
          OR EXISTS (SELECT 1 FROM treatment_sessions ts WHERE ts.visit_id = $1 AND ts.plan_item_id = i.id)) LIMIT 1`,
        [context.visitId, patientId, context.planId]);
      if (!linked.length) return mismatch;
    }
    const { rows: adjustments } = await db.query<{ case_id: number }>(
      `SELECT DISTINCT a.case_id FROM ortho_adjustments a JOIN ortho_cases c ON c.id = a.case_id
        WHERE a.visit_id = $1 AND c.patient_id = $2`, [context.visitId, patientId]);
    if (context.orthoCaseId !== undefined && !adjustments.some((row) => row.case_id === context.orthoCaseId)) return mismatch;
    if (context.planId === undefined && context.orthoCaseId === undefined && context.clinicalCaseId === undefined && context.endoTreatmentId === undefined && context.planItemId === undefined) {
      if (adjustments.length > 1) return { ok: false, reason: "ambiguous_visit" };
      if (adjustments.length === 1) context.orthoCaseId = adjustments[0].case_id;
    }
    if (context.planItemId !== undefined) {
      const { rows } = await db.query(`SELECT 1 FROM visit_procedures WHERE visit_id = $1 AND plan_item_id = $2
        UNION ALL SELECT 1 FROM treatment_sessions WHERE visit_id = $1 AND plan_item_id = $2
        UNION ALL SELECT 1 FROM plan_items WHERE visit_id = $1 AND id = $2 LIMIT 1`, [context.visitId, context.planItemId]);
      if (!rows.length) return mismatch;
    }
    if (context.endoTreatmentId !== undefined) {
      const { rows } = await db.query("SELECT id FROM endo_visits WHERE visit_id = $1 AND treatment_id = $2", [context.visitId, context.endoTreatmentId]);
      if (!rows.length) return mismatch;
    }
    if (context.clinicalCaseId !== undefined) {
      const { rows } = await db.query(`SELECT 1 FROM clinical_cases c WHERE c.id = $3 AND c.patient_id = $2 AND (
        EXISTS (SELECT 1 FROM ortho_adjustments a WHERE a.case_id = c.ortho_case_id AND a.visit_id = $1)
        OR EXISTS (SELECT 1 FROM endo_treatments t JOIN endo_visits ev ON ev.treatment_id = t.id WHERE t.case_id = c.id AND t.patient_id = $2 AND ev.visit_id = $1)
        OR EXISTS (SELECT 1 FROM plan_items i JOIN treatment_plans p ON p.id = i.plan_id WHERE i.case_id = c.id AND p.patient_id = $2 AND (
          i.visit_id = $1 OR EXISTS (SELECT 1 FROM visit_procedures vp WHERE vp.plan_item_id = i.id AND vp.visit_id = $1)
          OR EXISTS (SELECT 1 FROM treatment_sessions ts WHERE ts.plan_item_id = i.id AND ts.visit_id = $1))))`, [context.visitId, patientId, context.clinicalCaseId]);
      if (!rows.length) return mismatch;
    }
  }
  if (context.orthoCaseId !== undefined) {
    const { rows: [ortho] } = await db.query<{ id: number; clinical_case_id: number | null }>(
      `SELECT o.id, c.id AS clinical_case_id FROM ortho_cases o
        LEFT JOIN clinical_cases c ON c.ortho_case_id = o.id AND c.patient_id = o.patient_id
        WHERE o.id = $1 AND o.patient_id = $2`, [context.orthoCaseId, patientId]);
    if (!ortho) return missing;
    if (context.clinicalCaseId !== undefined && context.clinicalCaseId !== ortho.clinical_case_id) return mismatch;
    if (ortho.clinical_case_id !== null) context.clinicalCaseId = ortho.clinical_case_id;
    specialty = "orthodontics";
  }
  if (context.clinicalCaseId !== undefined) {
    const { rows: [clinical] } = await db.query<{ specialty: string; ortho_case_id: number | null }>(
      "SELECT specialty, ortho_case_id FROM clinical_cases WHERE id = $1 AND patient_id = $2", [context.clinicalCaseId, patientId]);
    if (!clinical) return missing;
    specialty = clinical.specialty;
    if (context.endoTreatmentId !== undefined && clinical.specialty !== "endodontics") return mismatch;
    if (clinical.ortho_case_id !== null) {
      if (clinical.specialty !== "orthodontics" || (context.orthoCaseId !== undefined && context.orthoCaseId !== clinical.ortho_case_id)) return mismatch;
      const { rows } = await db.query("SELECT id FROM ortho_cases WHERE id = $1 AND patient_id = $2", [clinical.ortho_case_id, patientId]);
      if (!rows.length) return mismatch;
      context.orthoCaseId = clinical.ortho_case_id;
    } else if (context.orthoCaseId !== undefined) return mismatch;
  }
  // Recheck a plan resolved before an episode/bridge supplied the exact clinical case.
  if (context.planId !== undefined && context.clinicalCaseId !== undefined && context.planItemId === undefined) {
    const { rows } = await db.query("SELECT id FROM plan_items WHERE plan_id = $1 AND case_id = $2 LIMIT 1", [context.planId, context.clinicalCaseId]);
    if (!rows.length) return mismatch;
  }
  if (context.pillar !== undefined && specialty !== null && specialty !== "orthodontics") return mismatch;
  return { ok: true, context, specialty,
    sub: context.orthoCaseId !== undefined ? "ortho" : specialty === "endodontics" ? "endo" : "cases" };
}
