/**
 * Existing visit references, classified by action. This is an ownership footprint,
 * not another patient model and not a retention-policy change.
 *
 * A committed footprint prevents moving recorded history. Race closure also needs
 * a canonical writer that locks/rechecks the visit: deferred entries below remain
 * PARTIAL. In particular, an FK alone does not validate patient identity.
 */
export const VISIT_RECORD_REFERENCES = [
  { table: "tooth_conditions", from: "tooth_conditions r", mismatch: "r.patient_id IS DISTINCT FROM $2::int", relinkFence: "visit", deletion: "detach" },
  { table: "perio_exams", from: "perio_exams r LEFT JOIN clinical_cases c ON c.id = r.case_id", mismatch: "r.case_id IS NOT NULL AND c.patient_id IS DISTINCT FROM $2::int", relinkFence: "visit", deletion: "restrict_clinical" },
  { table: "endo_visits", from: "endo_visits r JOIN endo_treatments t ON t.id = r.treatment_id", mismatch: "t.patient_id IS DISTINCT FROM $2::int", relinkFence: "visit", deletion: "restrict_clinical" },
  { table: "ortho_adjustments", from: "ortho_adjustments r JOIN ortho_cases c ON c.id = r.case_id", mismatch: "c.patient_id IS DISTINCT FROM $2::int", relinkFence: "visit", deletion: "detach" },
  { table: "patient_documents", from: "patient_documents r", mismatch: "r.patient_id IS DISTINCT FROM $2::int", relinkFence: "visit", deletion: "detach" },
  { table: "visit_procedures", from: "visit_procedures r LEFT JOIN plan_items i ON i.id = r.plan_item_id LEFT JOIN treatment_plans p ON p.id = i.plan_id", mismatch: "r.plan_item_id IS NOT NULL AND p.patient_id IS DISTINCT FROM $2::int", relinkFence: "atomic_route_only", deletion: "cascade" },
  { table: "prescriptions", from: "prescriptions r", mismatch: "r.patient_id IS DISTINCT FROM $2::int", relinkFence: "visit", deletion: "detach" },
  { table: "patient_vitals", from: "patient_vitals r", mismatch: "r.patient_id IS DISTINCT FROM $2::int", relinkFence: "visit", deletion: "detach" },
  { table: "patient_diagnoses", from: "patient_diagnoses r", mismatch: "r.patient_id IS DISTINCT FROM $2::int", relinkFence: "deferred", deletion: "restrict_clinical" },
  { table: "lab_orders", from: "lab_orders r", mismatch: "r.patient_id IS DISTINCT FROM $2::int", relinkFence: "deferred", deletion: "detach" },
  // Initial walk-in material movements may intentionally have no independent owner.
  { table: "inventory_movements", from: "inventory_movements r", mismatch: "r.patient_id IS NOT NULL AND r.patient_id IS DISTINCT FROM $2::int", relinkFence: "deferred", deletion: "restrict_financial" },
  { table: "plan_items", from: "plan_items r JOIN treatment_plans p ON p.id = r.plan_id", mismatch: "p.patient_id IS DISTINCT FROM $2::int", relinkFence: "deferred", deletion: "detach" },
  { table: "treatment_sessions", from: "treatment_sessions r JOIN plan_items i ON i.id = r.plan_item_id JOIN treatment_plans p ON p.id = i.plan_id", mismatch: "p.patient_id IS DISTINCT FROM $2::int", relinkFence: "deferred", deletion: "detach" },
  { table: "planned_visits", from: "planned_visits r LEFT JOIN treatment_plans p ON p.id = r.plan_id", mismatch: "r.patient_id IS DISTINCT FROM $2::int OR (r.plan_id IS NOT NULL AND p.patient_id IS DISTINCT FROM $2::int)", relinkFence: "deferred", deletion: "restrict_workflow" },
] as const;

export const VISIT_OWNER_CONTEXTS = [
  { column: "appointment_id", table: "appointments" },
  { column: "planned_visit_id", table: "planned_visits" },
  { column: "case_id", table: "clinical_cases" },
  { column: "invoice_id", table: "invoices" },
] as const;

export interface VisitRelinkFootprint {
  has_records: boolean;
  incompatible_owner: boolean;
  intrinsic_clinical: boolean;
  has_context: boolean;
  incompatible_context: boolean;
}

const any = (expressions: readonly string[]) => expressions.length ? expressions.join(" OR ") : "FALSE";

/** Run only in a NEW statement after acquiring the visit lock. No child locks:
 * Endo deliberately locks treatment before visit, so locking it here would invert
 * that order. Hidden documents/voided prescriptions/empty headers still count.
 */
export const VISIT_RELINK_FOOTPRINT_SQL = `SELECT
  (${any(VISIT_RECORD_REFERENCES.map(r => `EXISTS (SELECT 1 FROM ${r.table} WHERE visit_id = $1)`))}) AS has_records,
  (${any(VISIT_RECORD_REFERENCES.map(r => `EXISTS (SELECT 1 FROM ${r.from} WHERE r.visit_id = $1 AND (${r.mismatch}))`))}) AS incompatible_owner,
  (${any(["chief_complaint", "examination", "diagnosis", "treatment_done", "next_plan", "addendum"]
    .map(column => `NULLIF(btrim(COALESCE(v.${column}, '')), '') IS NOT NULL`))}) AS intrinsic_clinical,
  (${any(VISIT_OWNER_CONTEXTS.map(c => `v.${c.column} IS NOT NULL`))}) AS has_context,
  (${any(VISIT_OWNER_CONTEXTS.map(c => `EXISTS (SELECT 1 FROM ${c.table} p WHERE p.id = v.${c.column} AND p.patient_id IS DISTINCT FROM $2::int)`))}) AS incompatible_context
  FROM visits v WHERE v.id = $1`;

export type VisitRelinkFootprintRefusal = "has_clinical_history" | "has_linked_workflow" | "incompatible_owner";

export function visitRelinkFootprintRefusal(
  currentPatientId: number | null, targetPatientId: number, footprint: VisitRelinkFootprint,
): VisitRelinkFootprintRefusal | null {
  // Refreshing an unsigned current owner does not transfer anything.
  if (currentPatientId === targetPatientId) return null;
  if (currentPatientId === null) {
    // Filing a walk-in may retain its intrinsic notes/free procedures/materials,
    // but every independently patient-owned reference must agree with the target.
    return footprint.incompatible_owner || footprint.incompatible_context ? "incompatible_owner" : null;
  }
  if (footprint.has_context) return "has_linked_workflow";
  if (footprint.has_records || footprint.intrinsic_clinical) return "has_clinical_history";
  return null;
}

export const VISIT_RELINK_MESSAGE: Record<VisitRelinkFootprintRefusal, string> = {
  has_clinical_history: "الزيارة مرتبطة بتوثيق أو سجل محفوظ — لا يمكن نقلها إلى ملف آخر.",
  has_linked_workflow: "الزيارة مرتبطة بموعد أو خطة أو حالة أو فاتورة — لا يمكن نقلها إلى ملف آخر.",
  incompatible_owner: "الزيارة مرتبطة بسجلات لا توافق ملف المريض المحدد — لا يمكن تغيير ارتباطها.",
};

export interface VisitDeleteFootprint {
  clinical: boolean;
  workflow: boolean;
  financial: boolean;
}
export type VisitDeleteFootprintRefusal = "has_clinical_history" | "has_linked_workflow" | "has_financial_history";

// Only protections already enforced by existing FK/append-only rules. Chart,
// vitals, documents and other explicitly permitted detach policies are unchanged.
export const VISIT_DELETE_FOOTPRINT_SQL = `SELECT ${(["clinical", "workflow", "financial"] as const).map(kind =>
  `(${any(VISIT_RECORD_REFERENCES.filter(r => r.deletion === `restrict_${kind}`)
    .map(r => `EXISTS (SELECT 1 FROM ${r.table} WHERE visit_id = $1)`))}) AS ${kind}`,
).join(", ")}`;

export function visitDeleteFootprintRefusal(footprint: VisitDeleteFootprint): VisitDeleteFootprintRefusal | null {
  if (footprint.clinical) return "has_clinical_history";
  if (footprint.workflow) return "has_linked_workflow";
  if (footprint.financial) return "has_financial_history";
  return null;
}

export const VISIT_DELETE_MESSAGE: Record<VisitDeleteFootprintRefusal, string> = {
  has_clinical_history: "الزيارة مرتبطة بسجل سريري محفوظ يمنع حذفها.",
  has_linked_workflow: "الزيارة مرتبطة بزيارة مخطّطة — لا يمكن حذف ارتباط محفوظ بخطة العلاج.",
  has_financial_history: "الزيارة مرتبطة بحركات مخزون محفوظة — لا يمكن حذف أثرها التاريخي.",
};
