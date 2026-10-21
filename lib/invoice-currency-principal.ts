/** Read-only union. Legacy rows retain their exact ID/time and receipt meaning.
 * to_jsonb permits a pre-U0 database to keep serving old readers unchanged;
 * new-kind rows still require readCurrencyEvidenceDispatch validation. */
export const CURRENCY_PRINCIPAL_RELATION = `(SELECT id,correction_id,patient_id,source_currency,target_currency,source_invoice_ids,created_at,
  'legacy_v1'::text AS evidence_kind FROM invoice_settlement_reclassifications
  UNION ALL SELECT c.id,c.id,c.patient_id,c.original_currency,c.currency,ARRAY[c.original_invoice_id],c.created_at,
  'unpaid_root_v1'::text FROM invoice_corrections c WHERE to_jsonb(c)->>'currency_evidence_kind'='unpaid_root_v1')`;
