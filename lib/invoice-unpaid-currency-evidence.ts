import type { DbClient } from './db';
import { isCurrency, type Currency } from './money';
import { ReclassificationProofError } from './invoice-currency-reclassification';

export interface UnpaidCurrencyTransition {
  kind: 'unpaid_root_v1'; correctionId: number; patientId: number;
  sourceInvoiceId: number; targetInvoiceId: number; sourceCurrency: Currency; targetCurrency: Currency;
  sourceTotalMinor: number; sourceDiscountMinor: number; targetTotalMinor: number; targetDiscountMinor: number;
  /** Database action/issuance time, retaining all six fractional digits. */
  effectiveAt: string; sourceCreatedAt: string;
  amountMode: 'preserve-numerals' | 'reviewed-target-amounts';
}
const safe = (value: string): number => {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new ReclassificationProofError();
  return amount;
};

/** Candidate reader wired through additive evidence dispatch. Call in the shared
 * consistent snapshot. A zero-event document still has to pass every check.
 * Target status may evolve (receipt or same-currency correction); its original
 * issued facts and the receipt-free sealed root may not. No receipt allocation
 * or foreign-to-foreign historical FX conversion is inferred here. */
export async function readUnpaidCurrencyTransitions(
  client: Pick<DbClient, 'query'>, patientIds: readonly number[],
): Promise<UnpaidCurrencyTransition[]> {
  if (!patientIds.length) return [];
  if (patientIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new ReclassificationProofError();
  // Full outer joins catch orphan claims/documents as well as missing evidence.
  // A legacy correction is selected only when a new claim/document improperly
  // touches it, so unchanged v1 proof arithmetic remains in its own reader.
  const { rows } = await client.query<{
    correction_id: number; patient_id: number; source_id: number; target_id: number;
    source_currency: string; target_currency: string; source_total: string; source_discount: string;
    target_total: string; target_discount: string; effective_at: string; source_created_at: string;
    amount_mode: string; valid: boolean | null;
  }>(`SELECT c.id AS correction_id,c.patient_id,k.source_id,k.target_id,
      k.source_snapshot->>'base_currency' AS source_currency,k.target_currency,
      k.source_snapshot->>'total_minor' AS source_total,k.source_snapshot->>'discount_minor' AS source_discount,
      k.target_snapshot->>'total_minor' AS target_total,k.target_snapshot->>'discount_minor' AS target_discount,
      to_char(k.action_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_at,
      to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_created_at,
      k.intent->>'mode' AS amount_mode,
      (c.id IS NOT NULL AND k.source_id IS NOT NULL AND d.correction_id IS NOT NULL
       AND c.currency_evidence_kind='unpaid_root_v1' AND d.correction_id=c.id
       AND d.source_id=k.source_id AND d.target_id=k.target_id
       AND c.original_invoice_id=k.source_id AND c.corrected_invoice_id=k.target_id
       AND c.patient_id=i.patient_id AND n.patient_id=i.patient_id
       AND c.original_currency=i.base_currency AND c.currency=n.base_currency
       AND i.base_currency<>n.base_currency AND n.base_currency=k.target_currency
       AND c.created_by=k.created_by AND c.reason=k.reason AND c.created_at=k.action_at
       AND i.status='cancelled' AND n.status IN ('open','paid','cancelled')
       AND (i.note IS NULL OR i.note !~* '(replac|correct|تصحيح|بديل)')
       AND k.source_snapshot->>'status'='open' AND k.target_snapshot->>'status'='open'
       AND (to_jsonb(i)-ARRAY['status','created_at'])=(k.source_snapshot-ARRAY['status','created_at'])
       AND i.created_at=(k.source_snapshot->>'created_at')::timestamptz
       AND (to_jsonb(n)-ARRAY['status','created_at'])=(k.target_snapshot-ARRAY['status','created_at'])
       AND n.created_at=(k.target_snapshot->>'created_at')::timestamptz
       AND n.created_at=k.action_at AND d.target_snapshot=k.target_snapshot AND d.target_items=k.target_items
       AND k.item_snapshot=(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM invoice_items x WHERE x.invoice_id=k.source_id)
       AND k.target_items=(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM invoice_items x WHERE x.invoice_id=k.target_id)
       AND jsonb_typeof(k.intent)='object' AND k.intent-ARRAY['mode','lines','discountMinor']='{}'::jsonb
       AND jsonb_typeof(k.intent->'mode')='string' AND jsonb_typeof(k.intent->'discountMinor')='string'
       AND jsonb_typeof(k.intent->'lines')='array'
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(k.intent->'lines') e
         WHERE jsonb_typeof(e) IS DISTINCT FROM 'object' OR e-ARRAY['itemId','unitPriceMinor']<>'{}'::jsonb
           OR jsonb_typeof(e->'itemId') IS DISTINCT FROM 'number' OR jsonb_typeof(e->'unitPriceMinor') IS DISTINCT FROM 'string')
       AND jsonb_array_length(k.item_snapshot)>0
       AND jsonb_array_length(k.item_snapshot)=jsonb_array_length(k.target_items)
       AND jsonb_array_length(k.item_snapshot)=jsonb_array_length(k.intent->'lines')
       AND jsonb_array_length(k.item_snapshot)=(SELECT count(*) FROM invoice_correction_lines x WHERE x.correction_id=c.id)
       AND k.item_pairs=(SELECT jsonb_agg(jsonb_build_object('original',original_item_id,'corrected',corrected_item_id) ORDER BY original_item_id DESC)
         FROM invoice_correction_lines WHERE correction_id=c.id)
       AND NOT EXISTS(SELECT 1 FROM invoice_correction_lines x WHERE x.correction_id=c.id AND x.original_item_id IS NULL)
       AND (SELECT array_agg(original_item_id ORDER BY original_item_id) FROM invoice_correction_lines WHERE correction_id=c.id)
         =(SELECT array_agg(id ORDER BY id) FROM invoice_items WHERE invoice_id=k.source_id)
       AND (SELECT array_agg(corrected_item_id ORDER BY corrected_item_id) FROM invoice_correction_lines WHERE correction_id=c.id)
         =(SELECT array_agg(id ORDER BY id) FROM invoice_items WHERE invoice_id=k.target_id)
       AND NOT EXISTS(SELECT 1 FROM invoice_correction_lines x
         LEFT JOIN invoice_items a ON a.id=x.original_item_id LEFT JOIN invoice_items b ON b.id=x.corrected_item_id
         WHERE x.correction_id=c.id AND (a.id IS NULL OR b.id IS NULL OR x.plan_item_id IS NOT NULL
           OR (to_jsonb(a)-ARRAY['id','invoice_id','unit_price_minor','total_minor'])
             IS DISTINCT FROM (to_jsonb(b)-ARRAY['id','invoice_id','unit_price_minor','total_minor'])
           OR (SELECT count(*) FROM jsonb_array_elements(k.intent->'lines') e WHERE (e->>'itemId')::int=a.id)<>1
           OR b.unit_price_minor::NUMERIC IS DISTINCT FROM (SELECT (e->>'unitPriceMinor')::NUMERIC FROM jsonb_array_elements(k.intent->'lines') e WHERE (e->>'itemId')::int=a.id)
           OR a.quantity<=0 OR a.unit_price_minor NOT BETWEEN 0 AND 9007199254740991
           OR a.total_minor::NUMERIC<>a.quantity::NUMERIC*a.unit_price_minor
           OR b.quantity<=0 OR b.unit_price_minor NOT BETWEEN 0 AND 9007199254740991
           OR b.total_minor::NUMERIC<>b.quantity::NUMERIC*b.unit_price_minor
           OR k.intent->>'mode'='preserve-numerals' AND b.unit_price_minor::NUMERIC<>
             a.unit_price_minor::NUMERIC*(CASE WHEN n.base_currency='YER' THEN 1 ELSE 100 END)/(CASE WHEN i.base_currency='YER' THEN 1 ELSE 100 END)))
       AND i.total_minor=(SELECT sum(total_minor) FROM invoice_items WHERE invoice_id=i.id)
       AND n.total_minor=(SELECT sum(total_minor) FROM invoice_items WHERE invoice_id=n.id)
       AND i.total_minor BETWEEN 0 AND 9007199254740991 AND n.total_minor BETWEEN 0 AND 9007199254740991
       AND i.discount_minor BETWEEN 0 AND i.total_minor AND n.discount_minor BETWEEN 0 AND n.total_minor
       AND n.discount_minor::NUMERIC=(k.intent->>'discountMinor')::NUMERIC
       AND (k.intent->>'mode'<>'preserve-numerals' OR n.discount_minor::NUMERIC=i.discount_minor::NUMERIC*
         (CASE WHEN n.base_currency='YER' THEN 1 ELSE 100 END)/(CASE WHEN i.base_currency='YER' THEN 1 ELSE 100 END))
       AND NOT EXISTS(SELECT 1 FROM payments WHERE invoice_id=k.source_id)
       AND i.plan_id IS NULL AND (k.target_snapshot->>'plan_id') IS NULL
       AND NOT EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=k.source_id AND
         (plan_item_id IS NOT NULL OR source_type IS NOT NULL OR source_id IS NOT NULL))
       AND NOT EXISTS(SELECT 1 FROM plan_items WHERE origin_invoice_id=k.source_id OR billed_invoice_id=k.source_id)
       AND NOT EXISTS(SELECT 1 FROM clinical_cases WHERE origin_invoice_id=k.source_id)
       AND NOT EXISTS(SELECT 1 FROM visits WHERE invoice_id=k.source_id)
       AND NOT EXISTS(SELECT 1 FROM ortho_adjustments WHERE billing_invoice_id=k.source_id)
       AND NOT EXISTS(SELECT 1 FROM approved_agreement_principals WHERE invoice_id=k.source_id)
       AND NOT EXISTS(SELECT 1 FROM debt_repayment_arrangements WHERE invoice_id=k.source_id)
       AND NOT EXISTS(SELECT 1 FROM invoice_settlement_reclassifications old WHERE old.correction_id=c.id OR k.source_id=ANY(old.source_invoice_ids))
       AND NOT EXISTS(SELECT 1 FROM invoice_corrections old WHERE old.id<>c.id AND
         (old.original_invoice_id=k.source_id OR old.corrected_invoice_id=k.source_id OR old.corrected_invoice_id=k.target_id))
       AND EXISTS(SELECT 1 FROM invoice_correction_receipts r WHERE r.correction_id=c.id
         AND jsonb_typeof(r.receipt)='object'
         AND r.receipt-ARRAY['version','kind','evidenceKind','correctionId','patientId','currency','originalCurrency','idempotencyKey','requestHash','createdBy','actorUserId','effectiveAt','amountMode','settledMinor','sourcePrincipalMinor','targetPrincipalMinor','original','corrected']='{}'::jsonb
         AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['version','correctionId','patientId','actorUserId','settledMinor','sourcePrincipalMinor','targetPrincipalMinor']) field
           WHERE jsonb_typeof(r.receipt->field) IS DISTINCT FROM 'number')
         AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['kind','evidenceKind','currency','originalCurrency','idempotencyKey','requestHash','createdBy','effectiveAt','amountMode']) field
           WHERE jsonb_typeof(r.receipt->field) IS DISTINCT FROM 'string')
         AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['original','corrected']) field
           WHERE jsonb_typeof(r.receipt->field) IS DISTINCT FROM 'object'
             OR (r.receipt->field)-ARRAY['id','patientId','baseCurrency','invoiceNumber','createdAt']<>'{}'::jsonb
             OR jsonb_typeof(r.receipt->field->'id') IS DISTINCT FROM 'number'
             OR jsonb_typeof(r.receipt->field->'patientId') IS DISTINCT FROM 'number'
             OR jsonb_typeof(r.receipt->field->'baseCurrency') IS DISTINCT FROM 'string'
             OR jsonb_typeof(r.receipt->field->'invoiceNumber') IS DISTINCT FROM 'string'
             OR jsonb_typeof(r.receipt->field->'createdAt') IS DISTINCT FROM 'string')
         AND r.receipt->>'originalCurrency'=c.original_currency
         AND (r.receipt#>>'{original,patientId}')::int=c.patient_id
         AND (r.receipt#>>'{corrected,patientId}')::int=c.patient_id
         AND r.receipt->>'version'='1' AND r.receipt->>'kind'='invoice-currency-correction' AND r.receipt->>'evidenceKind'='unpaid_root_v1'
         AND (r.receipt->>'correctionId')::int=c.id AND r.receipt->>'requestHash'=c.request_hash
         AND r.receipt->>'amountMode'=k.intent->>'mode' AND r.receipt->>'settledMinor'='0'
         AND (r.receipt->>'sourcePrincipalMinor')::NUMERIC=i.total_minor::NUMERIC-i.discount_minor
         AND (r.receipt->>'targetPrincipalMinor')::NUMERIC=n.total_minor::NUMERIC-n.discount_minor
         AND r.receipt->>'effectiveAt'=to_char(k.action_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         AND r.receipt#>>'{corrected,createdAt}'=r.receipt->>'effectiveAt'
         AND r.receipt#>>'{original,createdAt}'=to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         AND r.receipt#>>'{original,invoiceNumber}'=i.invoice_number AND r.receipt#>>'{corrected,invoiceNumber}'=n.invoice_number
         AND (r.receipt->>'actorUserId')::NUMERIC BETWEEN 1 AND 9007199254740991
         AND trunc((r.receipt->>'actorUserId')::NUMERIC)=(r.receipt->>'actorUserId')::NUMERIC
         AND (r.receipt->>'patientId')::int=c.patient_id AND r.receipt->>'currency'=c.currency
         AND r.receipt->>'idempotencyKey'=c.idempotency_key AND r.receipt->>'createdBy'=c.created_by
         AND (r.receipt#>>'{original,id}')::int=k.source_id AND (r.receipt#>>'{corrected,id}')::int=k.target_id
         AND r.receipt#>>'{original,baseCurrency}'=i.base_currency AND r.receipt#>>'{corrected,baseCurrency}'=n.base_currency)
       AND EXISTS(SELECT 1 FROM audit_log WHERE action='invoice.correct' AND entity='invoice' AND entity_id=k.source_id::TEXT
         AND actor=c.created_by AND details->>'evidenceKind'='unpaid_root_v1'
         AND (details->>'correctionId')::INTEGER=c.id AND (details->>'replacementId')::INTEGER=k.target_id)
       AND NOT EXISTS(WITH RECURSIVE descendants(id) AS (SELECT k.target_id UNION
         SELECT x.corrected_invoice_id FROM invoice_corrections x JOIN descendants f ON f.id=x.original_invoice_id)
         SELECT 1 FROM descendants f JOIN invoices x ON x.id=f.id WHERE x.patient_id<>i.patient_id OR x.base_currency<>k.target_currency)
      ) AS valid
    FROM invoice_corrections c FULL JOIN invoice_unpaid_currency_transitions d ON d.correction_id=c.id
      FULL JOIN invoice_unpaid_currency_claims k ON k.source_id=d.source_id
      LEFT JOIN invoices i ON i.id=COALESCE(k.source_id,c.original_invoice_id)
      LEFT JOIN invoices n ON n.id=k.target_id
    WHERE (c.currency_evidence_kind='unpaid_root_v1' OR k.source_id IS NOT NULL OR d.correction_id IS NOT NULL)
      AND (c.patient_id=ANY($1::int[]) OR i.patient_id=ANY($1::int[]))
    ORDER BY c.id,k.source_id`, [[...new Set(patientIds)]]);
  return rows.map(row => {
    if (row.valid !== true || !isCurrency(row.source_currency) || !isCurrency(row.target_currency)
      || row.source_currency === row.target_currency
      || !['preserve-numerals','reviewed-target-amounts'].includes(row.amount_mode)) throw new ReclassificationProofError();
    return {
      kind: 'unpaid_root_v1', correctionId: row.correction_id, patientId: row.patient_id,
      sourceInvoiceId: row.source_id, targetInvoiceId: row.target_id,
      sourceCurrency: row.source_currency, targetCurrency: row.target_currency,
      sourceTotalMinor: safe(row.source_total), sourceDiscountMinor: safe(row.source_discount),
      targetTotalMinor: safe(row.target_total), targetDiscountMinor: safe(row.target_discount),
      effectiveAt: row.effective_at, sourceCreatedAt: row.source_created_at,
      amountMode: row.amount_mode as UnpaidCurrencyTransition['amountMode'],
    };
  });
}
