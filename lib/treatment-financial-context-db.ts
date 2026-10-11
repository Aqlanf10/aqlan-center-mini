import {
  ensureSchema, getPool, PLAN_ITEM_FINANCIAL_REVIEW_SQL, PLAN_ITEM_INVOICE_LINEAGE_SQL,
  PLAN_ITEM_LEGACY_LINEAGE_SQL, PLAN_ITEM_LEGACY_CONTEXT_SQL,
} from "./db";
import { openingPosition } from "./legacy-balance-arrangements-db";
import { legacyCoverageStateFromContext } from "./legacy-treatment-coverage";
import { requireCurrency } from "./money";
import { projectTreatmentFinancialReferences, type FinancialReceiptEvidence, type FinancialOpeningEvidence } from "./treatment-financial-context";

function minor(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Unsafe financial amount");
  return result;
}
function invoiceStatus(value: string): "open" | "paid" | "cancelled" {
  if (value === "open" || value === "paid" || value === "cancelled") return value;
  throw new Error("Unknown invoice status");
}
function agreementStatus(value: string): "live" | "void" {
  if (value === "live" || value === "void") return value;
  throw new Error("Unknown historical agreement status");
}
function receiptKind(value: string): "payment" | "refund" {
  if (value === "payment" || value === "refund") return value;
  throw new Error("Unknown receipt kind");
}

/**
 * All financial facts come from one PostgreSQL read-only repeatable-read snapshot.
 * No preview writes, automatic relinks, invented receipt allocation or commission recalculation.
 * Callers must enforce the same money/patient authorization as the patient ledger.
 */
export async function listTreatmentFinancialReferences(patientId: number) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new Error("Invalid patient identity");
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: patients } = await client.query("SELECT id FROM patients WHERE id = $1", [patientId]);
    if (!patients.length) { await client.query("COMMIT"); return null; }
    const { rows: plans } = await client.query<{
      id: number; patient_id: number; base_currency: string; total_minor: string; status: string;
      billing_mode: string; has_installments: boolean;
    }>(`SELECT t.id, t.patient_id, t.base_currency, t.total_minor::text, t.status, t.billing_mode,
         EXISTS (SELECT 1 FROM plan_installments pi WHERE pi.plan_id = t.id) AS has_installments
       FROM treatment_plans t WHERE t.patient_id = $1 ORDER BY t.id`, [patientId]);
    const { rows: items } = await client.query<{
      id: number; plan_id: number; patient_id: number; case_id: number | null; ortho_case_id: number | null;
      origin: string | null; origin_invoice_id: number | null; billed_invoice_id: number | null;
      billing_status: string; financial_review: boolean; invoice_lineage: boolean; legacy_lineage: boolean; legacy_context: unknown;
    }>(`SELECT i.id, i.plan_id, t.patient_id, i.case_id, c.ortho_case_id, i.origin, i.origin_invoice_id,
         i.billed_invoice_id, i.billing_status, ${PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS financial_review,
         ${PLAN_ITEM_INVOICE_LINEAGE_SQL} AS invoice_lineage, ${PLAN_ITEM_LEGACY_LINEAGE_SQL} AS legacy_lineage,
         ${PLAN_ITEM_LEGACY_CONTEXT_SQL} AS legacy_context
       FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
       LEFT JOIN clinical_cases c ON c.id = i.case_id AND c.patient_id = t.patient_id
       WHERE t.patient_id = $1 ORDER BY t.id, i.id`, [patientId]);
    const { rows: invoices } = await client.query<{
      id: number; patient_id: number; plan_id: number | null; invoice_number: string; base_currency: string;
      total_minor: string; discount_minor: string; status: string;
    }>(`SELECT id, patient_id, plan_id, invoice_number, base_currency, total_minor::text, discount_minor::text, status
       FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId]);
    const { rows: lines } = await client.query<{
      id: number; invoice_id: number; plan_item_id: number | null; source_type: string | null;
      source_id: string | null; total_minor: string;
    }>(`SELECT ii.id, ii.invoice_id, ii.plan_item_id, ii.source_type, ii.source_id::text, ii.total_minor::text
       FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id
       WHERE inv.patient_id = $1 ORDER BY ii.invoice_id, ii.id`, [patientId]);
    const { rows: receipts } = await client.query<{
      id: number; patient_id: number; invoice_id: number | null; plan_id: number | null;
      opening_currency: string | null; reversal_of_id: number | null; currency: string;
      amount_minor: string; base_amount_minor: string; exchange_rate: string; kind: string;
    }>(`SELECT id, patient_id, invoice_id, plan_id, opening_currency, reversal_of_id, currency,
         amount_minor::text, base_amount_minor::text, exchange_rate::text, kind
       FROM payments WHERE patient_id = $1 ORDER BY id`, [patientId]);
    const { rows: agreements } = await client.query<{
      id: number; patient_id: number; plan_item_id: number; case_id: number | null; currency: string;
      agreed_minor: string; previously_paid_minor: string; remaining_minor: string; historical_as_of: string;
      opening_history_id: number | null; opening_effect: string; status: string;
    }>(`SELECT id, patient_id, plan_item_id, case_id, currency, agreed_minor::text, previously_paid_minor::text,
         remaining_minor::text, historical_as_of::text, opening_history_id, opening_effect, status
       FROM legacy_treatment_agreements WHERE patient_id = $1 ORDER BY id`, [patientId]);
    const { rows: currencies } = await client.query<{ currency: string }>(
      "SELECT currency FROM patient_opening_balances WHERE patient_id = $1 ORDER BY currency", [patientId]);
    const openings: FinancialOpeningEvidence[] = [];
    for (const row of currencies) {
      const currency = requireCurrency(row.currency, "رصيد افتتاحي", patientId);
      const position = await openingPosition(client, patientId, currency);
      if (position) openings.push({ currency, ...position });
    }
    const normalizedReceipts: FinancialReceiptEvidence[] = receipts.map((row) => ({
      id: row.id, patientId: row.patient_id, invoiceId: row.invoice_id, planId: row.plan_id,
      openingCurrency: row.opening_currency === null ? null : requireCurrency(row.opening_currency, "هدف رصيد افتتاحي", row.id),
      reversalOfId: row.reversal_of_id, currency: requireCurrency(row.currency, "سند", row.id),
      amountMinor: minor(row.amount_minor), baseAmountMinor: minor(row.base_amount_minor),
      exchangeRate: Number(row.exchange_rate), kind: receiptKind(row.kind),
    }));
    const result = projectTreatmentFinancialReferences({
      patientId,
      plans: plans.map((row) => ({ id: row.id, patientId: row.patient_id,
        currency: requireCurrency(row.base_currency, "خطة", row.id), totalMinor: minor(row.total_minor),
        status: row.status, billingMode: row.billing_mode, hasInstallments: row.has_installments })),
      items: items.map((row) => ({ patientId: row.patient_id, planId: row.plan_id, planItemId: row.id,
        clinicalCaseId: row.case_id, orthoCaseId: row.ortho_case_id, origin: row.origin,
        originInvoiceId: row.origin_invoice_id, billedInvoiceId: row.billed_invoice_id, billingStatus: row.billing_status,
        financialReviewRequired: row.financial_review, hasInvoiceLineage: row.invoice_lineage,
        hasLegacyLineage: row.legacy_lineage, legacyCoverageState: legacyCoverageStateFromContext(row.legacy_context).kind })),
      invoices: invoices.map((row) => ({ id: row.id, patientId: row.patient_id, planId: row.plan_id,
        invoiceNumber: row.invoice_number, currency: requireCurrency(row.base_currency, "فاتورة", row.id),
        totalMinor: minor(row.total_minor), discountMinor: minor(row.discount_minor), status: invoiceStatus(row.status) })),
      lines: lines.map((row) => ({ id: row.id, invoiceId: row.invoice_id, planItemId: row.plan_item_id,
        sourceType: row.source_type, sourceId: row.source_id === null ? null : minor(row.source_id), totalMinor: minor(row.total_minor) })),
      receipts: normalizedReceipts,
      legacyAgreements: agreements.map((row) => ({ id: row.id, patientId: row.patient_id, planItemId: row.plan_item_id,
        clinicalCaseId: row.case_id, currency: requireCurrency(row.currency, "اتفاق تاريخي", row.id),
        agreedMinor: minor(row.agreed_minor), previouslyPaidMinor: minor(row.previously_paid_minor),
        remainingAtRegistrationMinor: minor(row.remaining_minor), historicalAsOf: row.historical_as_of,
        openingHistoryId: row.opening_history_id, openingEffect: row.opening_effect, status: agreementStatus(row.status) })),
      openings,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
