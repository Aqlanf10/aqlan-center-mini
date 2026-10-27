/** Internal read-only evidence for historical invoice lines whose plan currency
 * has changed. Audit text is not proof. Follow the exact immutable line handoff,
 * validating every edge and requiring a terminal line on the item's billed
 * invoice (or an explicitly acknowledged removal). A missing edge, cycle or
 * invalid currency document cannot qualify. UNIQUE original/corrected invoice
 * and correction-line keys prevent forks; visited IDs bound traversal.
 * $1 contains only mismatching line IDs from the already scoped report cohort. */
export const DAILY_CLINIC_CORRECTION_LINEAGE_SQL = `
 WITH RECURSIVE lineage AS (
   SELECT ii.id AS root_id, ii.id AS line_id, i.id AS invoice_id,
          i.patient_id, i.base_currency AS currency, ii.plan_item_id,
          ARRAY[i.id] AS visited, 0 AS depth
     FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
     JOIN plan_items pi ON pi.id=ii.plan_item_id
     JOIN treatment_plans tp ON tp.id=pi.plan_id
    WHERE ii.id=ANY($1::int[]) AND i.status='cancelled'
      AND i.plan_id IS NULL AND i.patient_id=tp.patient_id
      AND ((ii.source_type IS NULL AND ii.source_id IS NULL)
        OR (ii.source_type='plan_item' AND ii.source_id=ii.plan_item_id))
   UNION ALL
   SELECT l.root_id, next_line.id, next_invoice.id, l.patient_id,
          next_invoice.base_currency, l.plan_item_id,
          l.visited || next_invoice.id, l.depth+1
     FROM lineage l
     JOIN invoices old_invoice ON old_invoice.id=l.invoice_id
     JOIN invoice_corrections c ON c.original_invoice_id=l.invoice_id
     JOIN invoice_correction_lines cl ON cl.correction_id=c.id AND cl.original_item_id=l.line_id
     JOIN invoice_items next_line ON next_line.id=cl.corrected_item_id
     JOIN invoices next_invoice ON next_invoice.id=c.corrected_invoice_id
    WHERE old_invoice.status='cancelled' AND old_invoice.plan_id IS NULL
      AND c.patient_id=l.patient_id AND next_invoice.patient_id=l.patient_id
      AND next_invoice.plan_id IS NULL
      AND next_line.invoice_id=next_invoice.id
      AND ((next_line.source_type IS NULL AND next_line.source_id IS NULL)
        OR (next_line.source_type='plan_item' AND next_line.source_id=next_line.plan_item_id))
      AND cl.plan_item_id=l.plan_item_id AND next_line.plan_item_id=l.plan_item_id
      AND COALESCE(c.original_currency,c.currency)=l.currency
      AND c.currency=next_invoice.base_currency
      AND NOT next_invoice.id=ANY(l.visited)
      AND cl.approved_work->'serviceId'=to_jsonb(next_line)->'service_id'
      AND cl.approved_work->'doctorId'=to_jsonb(next_line)->'doctor_id'
      AND cl.approved_work->'quantity'=to_jsonb(next_line)->'quantity'
      AND cl.approved_work->'unitPriceMinor'=to_jsonb(next_line)->'unit_price_minor'
      AND (l.currency=c.currency OR EXISTS (
        SELECT 1 FROM invoice_settlement_reclassifications d
         WHERE d.correction_id=c.id AND d.patient_id=l.patient_id
           AND d.source_currency=l.currency AND d.target_currency=c.currency
           AND l.invoice_id=ANY(d.source_invoice_ids)))
 )
 SELECT DISTINCT l.root_id
   FROM lineage l JOIN plan_items pi ON pi.id=l.plan_item_id
   JOIN treatment_plans tp ON tp.id=pi.plan_id
  WHERE l.depth>0 AND l.patient_id=tp.patient_id AND l.currency=tp.base_currency
    AND pi.billed_invoice_id=l.invoice_id
    AND (NOT EXISTS (SELECT 1 FROM invoice_corrections c WHERE c.original_invoice_id=l.invoice_id)
      OR (pi.status='cancelled' AND EXISTS (
        -- An authorized later revision may omit an unstarted item. Absence of
        -- a handoff alone is not proof: its immutable acknowledgement must
        -- contain this original item and explicitly omit it from the replacement.
        SELECT 1 FROM invoice_corrections removed
        JOIN invoices old_invoice ON old_invoice.id=removed.original_invoice_id
        JOIN invoices replacement ON replacement.id=removed.corrected_invoice_id
        JOIN invoice_correction_receipts ack ON ack.correction_id=removed.id
        WHERE removed.original_invoice_id=l.invoice_id
          AND old_invoice.status='cancelled' AND old_invoice.patient_id=l.patient_id
          AND removed.patient_id=l.patient_id AND replacement.patient_id=l.patient_id
          AND COALESCE(removed.original_currency,removed.currency)=l.currency
          AND removed.currency=l.currency AND replacement.base_currency=l.currency
          AND ack.receipt->'patientId'=to_jsonb(l.patient_id)
          AND ack.receipt#>'{original,id}'=to_jsonb(l.invoice_id)
          AND ack.receipt#>'{original,patientId}'=to_jsonb(l.patient_id)
          AND ack.receipt#>>'{original,baseCurrency}'=l.currency
          AND ack.receipt#>'{corrected,id}'=to_jsonb(replacement.id)
          AND ack.receipt#>'{corrected,patientId}'=to_jsonb(l.patient_id)
          AND ack.receipt#>>'{corrected,baseCurrency}'=l.currency
          AND jsonb_typeof(ack.receipt#>'{original,items}')='array'
          AND jsonb_typeof(ack.receipt#>'{corrected,items}')='array'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ack.receipt#>'{original,items}')='array'
                THEN ack.receipt#>'{original,items}' ELSE '[]'::jsonb END) item
            WHERE item->'id'=to_jsonb(l.line_id) AND item->'planItemId'=to_jsonb(l.plan_item_id))
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ack.receipt#>'{corrected,items}')='array'
                THEN ack.receipt#>'{corrected,items}' ELSE '[]'::jsonb END) item
            WHERE item->'planItemId'=to_jsonb(l.plan_item_id))
          AND NOT EXISTS (SELECT 1 FROM invoice_items retained
            WHERE retained.invoice_id=replacement.id AND retained.plan_item_id=l.plan_item_id)
          AND NOT EXISTS (SELECT 1 FROM invoice_correction_lines retained
            WHERE retained.correction_id=removed.id AND retained.original_item_id=l.line_id)
      )))`;
