import {
  PLAN_ITEM_FINANCIAL_REVIEW_SQL, PLAN_ITEM_INVOICE_LINEAGE_SQL, PLAN_ITEM_LEGACY_LINEAGE_SQL,
  PLAN_ITEM_LEGACY_CONTEXT_SQL, PLAN_ITEM_LEGACY_COVERED_SQL, PLAN_ITEM_PREBILLED_SQL, type DbClient,
} from "./db";
import { legacyCoverageStateFromContext } from "./legacy-treatment-coverage";
import { readOrthoFinancialReference, type OrthoFinancialSource, type OrthoFinancialReference } from "./ortho-financial-reference";

/** Caller owns a read-only snapshot. No bootstrap, writer, money totals or payment reads. */
export async function readCaseFinancialReference(db: DbClient, patientId: number, orthoCaseId: number): Promise<OrthoFinancialReference> {
  if (![patientId, orthoCaseId].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid case identity");
  const { rows: cases } = await db.query<{ id: number }>(
    "SELECT id FROM clinical_cases WHERE patient_id = $1 AND ortho_case_id = $2 ORDER BY id", [patientId, orthoCaseId]);
  const { rows: items } = await db.query<{
    id: number; plan_id: number; case_id: number; plan_status: string; billed_invoice_id: number | null;
    invoice_lineage: boolean; legacy_lineage: boolean; financial_review: boolean; prebilled: boolean;
    legacy_covered: boolean; legacy_context: unknown; invoice_ids: number[];
    invoice_identity_conflict: boolean;
    agreements: { id: number; status: string }[];
  }>(`SELECT i.id, i.plan_id, i.case_id, t.status AS plan_status, i.billed_invoice_id,
       ${PLAN_ITEM_INVOICE_LINEAGE_SQL} AS invoice_lineage, ${PLAN_ITEM_LEGACY_LINEAGE_SQL} AS legacy_lineage,
       ${PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS financial_review, ${PLAN_ITEM_PREBILLED_SQL} AS prebilled,
       ${PLAN_ITEM_LEGACY_COVERED_SQL} AS legacy_covered, ${PLAN_ITEM_LEGACY_CONTEXT_SQL} AS legacy_context,
       EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id
         WHERE inv.patient_id = t.patient_id AND (ii.plan_item_id = i.id OR (ii.source_type = 'plan_item' AND ii.source_id = i.id))
           AND ii.source_type = 'plan_item' AND ii.plan_item_id IS NOT NULL AND ii.source_id IS DISTINCT FROM ii.plan_item_id) AS invoice_identity_conflict,
       ARRAY(SELECT inv.id FROM invoices inv WHERE inv.patient_id = t.patient_id
         AND (inv.id = i.billed_invoice_id OR inv.id = i.origin_invoice_id OR EXISTS (
           SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = inv.id
             AND (ii.plan_item_id = i.id OR (ii.source_type = 'plan_item' AND ii.source_id = i.id))))
         ORDER BY inv.id) AS invoice_ids,
       ARRAY(SELECT jsonb_build_object('id', la.id, 'status', la.status) FROM legacy_treatment_agreements la
         WHERE la.patient_id = t.patient_id AND la.plan_item_id = i.id ORDER BY la.id) AS agreements
     FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
     JOIN clinical_cases cc ON cc.id = i.case_id AND cc.patient_id = t.patient_id
     WHERE t.patient_id = $1 AND cc.ortho_case_id = $2 AND i.category = 'ortho'
     ORDER BY i.id`, [patientId, orthoCaseId]);
  const sources: OrthoFinancialSource[] = [];
  let review = false;
  for (const item of items) {
    const currentPlan = item.plan_status !== "cancelled";
    const invoiceCurrent = currentPlan && item.prebilled && !item.financial_review && !item.invoice_identity_conflict;
    const legacyCurrent = currentPlan && item.legacy_covered && !item.financial_review
      && legacyCoverageStateFromContext(item.legacy_context).kind === "verified";
    for (const invoiceId of item.invoice_ids) sources.push({ kind: "invoice", sourceId: invoiceId,
      planId: item.plan_id, planItemId: item.id, clinicalCaseId: item.case_id,
      current: invoiceCurrent && invoiceId === item.billed_invoice_id });
    for (const agreement of item.agreements) sources.push({ kind: "historical_agreement", sourceId: agreement.id,
      planId: item.plan_id, planItemId: item.id, clinicalCaseId: item.case_id,
      current: legacyCurrent && agreement.status === "live" });
    if (item.invoice_lineage || item.legacy_lineage) {
      review ||= item.financial_review || item.invoice_identity_conflict || !currentPlan || item.invoice_lineage && item.legacy_lineage
        || !sources.some((source) => source.planItemId === item.id && source.current);
    }
  }
  const { rows: [schedule] } = await db.query<{ recorded: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM debt_repayment_arrangements a JOIN LATERAL (
      SELECT status, terms FROM debt_repayment_revisions WHERE arrangement_id = a.id ORDER BY version DESC LIMIT 1
    ) r ON TRUE WHERE a.patient_id = $1 AND r.status = 'active' AND r.terms->>'mode' = 'installments'
      AND (a.invoice_id = ANY($2::int[]) OR a.opening_currency IN (
        SELECT la.currency FROM legacy_treatment_agreements la JOIN plan_items i ON i.id = la.plan_item_id
        JOIN treatment_plans t ON t.id = i.plan_id JOIN clinical_cases cc ON cc.id = i.case_id
        WHERE la.patient_id = $1 AND t.patient_id = $1 AND cc.patient_id = $1 AND cc.ortho_case_id = $3
          AND la.status = 'live' AND la.case_id = cc.id AND i.category = 'ortho' AND la.id = ANY($4::int[])
          AND ((la.document_id IS NULL AND la.opening_history_id IS NOT NULL AND la.remaining_minor > 0)
            OR EXISTS (SELECT 1 FROM legacy_treatment_documents d JOIN LATERAL (
              SELECT remaining_minor, opening_history_id FROM legacy_treatment_document_revisions
              WHERE document_id = d.id ORDER BY version DESC LIMIT 1
            ) lr ON TRUE WHERE d.id = la.document_id AND d.patient_id = $1 AND d.currency = la.currency
              AND lr.remaining_minor > 0 AND EXISTS (SELECT 1 FROM legacy_treatment_document_revisions provenance
                WHERE provenance.document_id = d.id AND provenance.opening_history_id IS NOT NULL)))
      ))) AS recorded`, [patientId, sources.filter((source) => source.kind === "invoice" && source.current).map((source) => source.sourceId), orthoCaseId,
    sources.filter((source) => source.kind === "historical_agreement" && source.current).map((source) => source.sourceId)]);
  return readOrthoFinancialReference({ state: review ? "review" : sources.length ? "linked" : "missing",
    clinicalCaseIds: cases.map((row) => row.id), sources, hasRecordedSchedule: schedule?.recorded === true });
}
