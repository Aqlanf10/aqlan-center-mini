import { PLAN_ITEM_FINANCIAL_REVIEW_SQL, PLAN_ITEM_LEGACY_CONTEXT_SQL, type DbClient } from "./db";
import { legacyCoverageStateFromContext } from "./legacy-treatment-coverage";
import { planConsentIsCurrent } from "../components/legacy-treatment-view";
import { journeyFail, type JourneyAuthority, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { journeyContentHash } from "./ortho-case-journey-history";
import { journeyId, type ConsentObservation } from "./ortho-case-journey-records";
export interface JourneyPlanSource {
  planId: number; title: string; status: string; patientId: number;
  items: { id: number; caseId: number | null; serviceName: string; toothCode: number | null; surfaces: string | null; quantity: number; status: string }[];
  consent: Omit<ConsentObservation, "capturedAt">;
}
/** Pure observation only: never call recordPlanConsent or any installment writer. */
export async function lockJourneyPlan(client: Pick<DbClient, "query">, input: Pick<JourneyOwnerInput, "patientId">, authority: Pick<JourneyAuthority, "canViewPlans">, planId: number): Promise<JourneyPlanSource> {
  if (!authority.canViewPlans) journeyFail(403, "plan_read_denied");
  const { rows: plans } = await client.query<{ id: number; patient_id: number; title: string; status: string; consent_at: string | null; consent_by: string | null }>(
    `SELECT id,patient_id,title,status,to_char(consent_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS consent_at,consent_by
     FROM treatment_plans WHERE id=$1 AND patient_id=$2 FOR SHARE`, [planId, input.patientId]);
  const plan = plans[0]; if (!plan || plan.patient_id !== input.patientId) journeyFail(409, "plan_scope_mismatch");
  const { rows } = await client.query<{
    id: number; case_id: number | null; service_name: string; tooth_code: number | null; surfaces: string | null; quantity: number; status: string;
    billing_status: string; financial_review: boolean; legacy_agreement_id: number | null; legacy_agreement_status: "live" | "void" | null; legacy_context: unknown;
  }>(`SELECT i.id,i.case_id,i.service_name,i.tooth_code,i.surfaces,i.quantity,i.status,i.billing_status,
      ${PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS financial_review,
      (SELECT la.id FROM legacy_treatment_agreements la WHERE la.plan_item_id=i.id ORDER BY la.id DESC LIMIT 1) AS legacy_agreement_id,
      (SELECT la.status FROM legacy_treatment_agreements la WHERE la.plan_item_id=i.id ORDER BY la.id DESC LIMIT 1) AS legacy_agreement_status,
      ${PLAN_ITEM_LEGACY_CONTEXT_SQL} AS legacy_context
      FROM plan_items i WHERE i.plan_id=$1 ORDER BY i.id LIMIT 1001 FOR SHARE OF i`, [planId]);
  if (rows.length > 1000) journeyFail(413, "plan_scope_too_large");
  const items = rows.map(row => {
    if (!journeyId(row.id) || typeof row.service_name !== "string" || !Number.isSafeInteger(row.quantity) || row.quantity <= 0 || typeof row.status !== "string") journeyFail(500, "invalid_plan_source");
    return { id: row.id, caseId: row.case_id, serviceName: row.service_name, toothCode: row.tooth_code, surfaces: row.surfaces, quantity: row.quantity, status: row.status };
  });
  // Reuse the current canonical historical-consent predicate and coverage parser.
  // Monetary values never enter this DTO or its renderer projection.
  const consentItems = rows.map(row => {
    const coverage = legacyCoverageStateFromContext(row.legacy_context), verified = !row.legacy_agreement_id || coverage.kind === "verified";
    return { legacyAgreementId: row.legacy_agreement_id ?? undefined, legacyAgreementStatus: row.legacy_agreement_status ?? undefined,
      billingStatus: row.financial_review || !verified ? "needs_financial_review" : row.billing_status,
      legacyCoverageState: coverage.kind, legacyCoverageSite: coverage.kind === "verified" ? coverage.coverage.site : null,
      legacyCurrentConsentRequired: !verified || !plan.consent_at };
  });
  const planScopeHash = journeyContentHash({ planId, title: plan.title, status: plan.status, items, consentItems: consentItems.map(item => ({ ...item, legacyAgreementId: item.legacyAgreementId ?? null, legacyAgreementStatus: item.legacyAgreementStatus ?? null })) });
  const state = plan.consent_at === null ? "not_recorded" as const : planConsentIsCurrent({ consentAt: plan.consent_at, items: consentItems }) ? "current" as const : "historical_unverified" as const;
  const observed = { planId, consentAt: plan.consent_at, consentBy: plan.consent_by, state, planScopeHash };
  return { planId, patientId: plan.patient_id, title: plan.title, status: plan.status, items,
    consent: { ...observed, observationHash: journeyContentHash(observed) } };
}
