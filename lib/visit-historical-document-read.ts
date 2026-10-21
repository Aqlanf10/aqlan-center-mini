import type { DbClient, DbPool } from "./db";
import { historicalDocumentReferences } from "./treatment-financial-context";

/** Validate only the explicitly referenced document, using #371's canonical validator.
 * Internal document amounts are validation inputs only, never visit totals or output. */
export async function validVisitHistoricalDocument(db: DbClient | DbPool, patientId: number, documentId: number): Promise<boolean> {
  const { rows: [snapshot] } = await db.query<Parameters<typeof historicalDocumentReferences>[0]>(`
    SELECT d.patient_id AS "patientId",
      (SELECT jsonb_agg(jsonb_build_object('id',t.id,'patientId',t.patient_id,'currency',t.base_currency))
        FROM treatment_plans t WHERE t.id IN (SELECT i.plan_id FROM plan_items i JOIN legacy_treatment_agreements la
          ON la.plan_item_id=i.id WHERE la.document_id=d.id)) AS plans,
      (SELECT jsonb_agg(jsonb_build_object('planItemId',i.id,'patientId',t.patient_id,'planId',i.plan_id,'clinicalCaseId',i.case_id))
        FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id
        WHERE i.id IN(SELECT plan_item_id FROM legacy_treatment_agreements WHERE document_id=d.id)
          AND (i.case_id IS NULL OR EXISTS(SELECT 1 FROM clinical_cases cc WHERE cc.id=i.case_id AND cc.patient_id=t.patient_id))) AS items,
      (SELECT jsonb_agg(jsonb_build_object('id',la.id,'patientId',la.patient_id,'planItemId',la.plan_item_id,
        'clinicalCaseId',la.case_id,'documentId',la.document_id,'documentLine',la.document_line,'currency',la.currency,
        'agreedMinor',la.agreed_minor,'previouslyPaidMinor',la.previously_paid_minor,'remainingAtRegistrationMinor',la.remaining_minor,
        'historicalAsOf',la.historical_as_of::text,'openingHistoryId',la.opening_history_id,'openingEffect',la.opening_effect,'status',la.status))
        FROM legacy_treatment_agreements la WHERE la.document_id=d.id) AS "legacyAgreements",
      jsonb_build_array(jsonb_build_object('id',d.id,'patientId',d.patient_id,'currency',d.currency,'lineCount',d.line_count,
        'revision',(SELECT jsonb_build_object('id',r.id,'version',r.version,'totalMinor',r.total_minor,'discountMinor',r.discount_minor,
          'previouslyPaidMinor',r.previously_paid_minor,'remainingMinor',r.remaining_minor,'historicalAsOf',r.historical_as_of::text,'lines',r.lines)
          FROM legacy_treatment_document_revisions r WHERE r.document_id=d.id ORDER BY version DESC LIMIT 1))) AS "historicalDocuments"
    FROM legacy_treatment_documents d WHERE d.id=$1 AND d.patient_id=$2`, [documentId, patientId]);
  if (!snapshot || !Array.isArray(snapshot.plans) || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.legacyAgreements)) return false;
  try { historicalDocumentReferences(snapshot); return true; } catch { return false; }
}
