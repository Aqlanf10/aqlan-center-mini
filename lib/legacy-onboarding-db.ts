import { ensureSchema, getPool, ORTHO_CASE_FUNDED_SQL, orthoAdjustmentBillingClass } from "./db";
import { isLegacyFinancialMode } from "./ortho-baseline";
import { legacyOnboarding, type LegacyOnboarding } from "./legacy-onboarding";
import { readCaseFinancialReference } from "./ortho-financial-reference-db";

/** Money-free case reference and the unchanged signing classifier, from one snapshot.
 * The optional identity retains the old endpoint contract; the Ortho UI always supplies it.
 */
export async function patientLegacyOnboarding(patientId: number, caseId?: number): Promise<(LegacyOnboarding & { caseId: number }) | null> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0
    || caseId !== undefined && (!Number.isSafeInteger(caseId) || caseId <= 0)) throw new Error("Invalid case identity");
  await ensureSchema();
  const client = await getPool().connect();
  let destroy = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [row] } = await client.query<{
      id: number; baseline_kind: string | null; legacy_financial_mode: string | null;
      opening_currencies: string[]; arrangement_currencies: string[]; funded_plan: boolean;
    }>(`SELECT c.id, c.baseline_kind, c.legacy_financial_mode,
          ARRAY(SELECT o.currency FROM patient_opening_balances o
            WHERE o.patient_id = c.patient_id ORDER BY o.currency) AS opening_currencies,
          ARRAY(SELECT a.currency FROM legacy_balance_arrangements a
            WHERE a.patient_id = c.patient_id AND a.cancelled_at IS NULL
            UNION SELECT a.opening_currency FROM debt_repayment_arrangements a JOIN LATERAL (
              SELECT status, terms FROM debt_repayment_revisions WHERE arrangement_id = a.id ORDER BY version DESC LIMIT 1
            ) r ON TRUE WHERE a.patient_id = c.patient_id AND a.opening_currency IS NOT NULL
              AND r.status = 'active' AND r.terms->>'mode' = 'installments') AS arrangement_currencies,
          ${ORTHO_CASE_FUNDED_SQL} AS funded_plan
        FROM ortho_cases c WHERE c.patient_id = $1
          AND (($2::int IS NOT NULL AND c.id = $2) OR ($2::int IS NULL AND c.status IN ('active', 'retention')))
        ORDER BY c.id DESC LIMIT 1`, [patientId, caseId ?? null]);
    if (!row) { await client.query("COMMIT"); return null; }
    const financialReference = await readCaseFinancialReference(client, patientId, row.id);
    const adjustmentClass = await orthoAdjustmentBillingClass(client, row.id, patientId);
    const result = { caseId: row.id, ...legacyOnboarding({
      legacy: row.baseline_kind === "legacy",
      financialMode: isLegacyFinancialMode(row.legacy_financial_mode) ? row.legacy_financial_mode : null,
      openingCurrencies: row.opening_currencies, activeArrangementCurrencies: row.arrangement_currencies,
      fundedPlan: row.funded_plan, financialReference, adjustmentClass,
    }) };
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { destroy = true; }
    throw error;
  } finally { client.release(destroy); }
}
