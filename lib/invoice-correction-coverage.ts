/** Alias i is the current plan item. Every mutable identity/price field used by
 * coverage is compared with the immutable, authorized correction snapshot. */
export const INVOICE_APPROVED_WORK_SQL = `jsonb_build_object(
  'serviceId',i.service_id,'doctorId',i.doctor_id,'quantity',i.quantity,'unitPriceMinor',i.unit_price_minor,
  'caseId',i.case_id,'toothCode',i.tooth_code,'surfaces',i.surfaces,
  'caseSite',(SELECT c.site FROM clinical_cases c WHERE c.id=i.case_id))`;

export const INVOICE_CORRECTION_COVERAGE_SQL = `EXISTS (
  SELECT 1 FROM invoice_corrections revision JOIN invoice_correction_lines approved ON approved.correction_id=revision.id
    JOIN invoice_items corrected_line ON corrected_line.id=approved.corrected_item_id
  WHERE revision.corrected_invoice_id=i.billed_invoice_id AND revision.patient_id=t.patient_id AND revision.currency=t.base_currency
    AND approved.plan_item_id=i.id AND corrected_line.invoice_id=revision.corrected_invoice_id
    AND corrected_line.plan_item_id=i.id AND approved.approved_work=${INVOICE_APPROVED_WORK_SQL})`;
