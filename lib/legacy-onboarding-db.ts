import { ensureSchema, getPool } from "./db";
import { isLegacyFinancialMode } from "./ortho-baseline";
import { legacyOnboarding, type LegacyOnboarding } from "./legacy-onboarding";

/**
 * (P1-A) قائمة تهيئة مريض التقويم السابق — بالمعطيات نفسها التي يقرأها مصنِّف شدّة التوقيع
 * (orthoAdjustmentBillingClass): نوع اللقطة وطريقة المال وعملات الرصيد السابق وتمويل الخطة. قراءةٌ فقط،
 * بلا مبالغ — فيراها الطبيب على مريضه دون أرقامٍ مالية.
 */
export async function patientLegacyOnboarding(patientId: number): Promise<(LegacyOnboarding & { caseId: number }) | null> {
  await ensureSchema();
  const { rows: [row] } = await getPool().query<{
    id: number; baseline_kind: string | null; legacy_financial_mode: string | null;
    opening_currencies: string[]; arrangement_currencies: string[]; funded_plan: boolean;
  }>(
    `SELECT c.id, c.baseline_kind, c.legacy_financial_mode,
            ARRAY(SELECT o.currency FROM patient_opening_balances o
                   WHERE o.patient_id = c.patient_id ORDER BY o.currency) AS opening_currencies,
            ARRAY(SELECT a.currency FROM legacy_balance_arrangements a
                   WHERE a.patient_id = c.patient_id AND a.cancelled_at IS NULL ORDER BY a.currency) AS arrangement_currencies,
            EXISTS(SELECT 1 FROM plan_installments pi WHERE pi.plan_id = c.plan_id) AS funded_plan
       FROM ortho_cases c
      WHERE c.patient_id = $1 AND c.status IN ('active', 'retention')
      ORDER BY c.id DESC LIMIT 1`,
    [patientId],
  );
  if (!row) return null;
  return {
    caseId: row.id,
    ...legacyOnboarding({
      legacy: row.baseline_kind === "legacy",
      financialMode: isLegacyFinancialMode(row.legacy_financial_mode) ? row.legacy_financial_mode : null,
      openingCurrencies: row.opening_currencies,
      activeArrangementCurrencies: row.arrangement_currencies,
      fundedPlan: row.funded_plan,
    }),
  };
}
