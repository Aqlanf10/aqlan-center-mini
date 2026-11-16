import "server-only";
import { CLINIC_TIME_ZONE, patientInDoctorScopeWith, previewVisitBillingWith, type DbClient, type VisitWalkout } from "./db";
import { readVisitCheckoutInSnapshot } from "./checkout-db";
import type { CheckoutCurrencyLine } from "./checkout-summary";
import type { CheckoutDueRecommendation } from "./checkout-due-recommendation";
import { CanonicalPatientReadRefusal } from "./canonical-patient-reads";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import type { CanonicalRecordRead } from "./canonical-record-reads";
import { readReceptionHandoffWith } from "./reception-handoff-db";
import { CURRENCIES, type Currency } from "./money";
import { clinicDateString } from "./schedule";
import { readVisitFinancialContext } from "./visit-financial-context-db";
import { redactVisitFinancialContext } from "./visit-financial-context";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The visit's money reads on the canonical runtime (M2 slice 89). The field-by-field
 * contract is section 6 of docs/review/financial-group4-contract-design-20261104.md
 * (owner decisions G4-1, G4-4, G4-6, 6648682456):
 *  - every response passes through an explicit allowlist projection, never spreading;
 *  - a derived value is shown only with every grant its inputs need; a hidden group is
 *    omitted, never zeroed (a zero would read as "nothing due" or "nothing paid");
 *  - the legacy `workflow.doctor_financial_view` setting has no effect here;
 *  - the protected owner holds every group.
 * One read-only snapshot per request; the visit inside the patient scope (its clinician,
 * or its patient inside the scope); outside reads like missing.
 */
const VISIT_MISSING = "الزيارة غير موجودة.";
const MAX_BYTES = 2 * 1024 * 1024;

function visitIdOf(raw: unknown): number {
  const value = typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new CanonicalPatientReadRefusal("invalid_patient_query", "رقم الزيارة غير صالح.");
  return value;
}

async function readInsideVisit<T>(session: VerifiedDurableSession, read: CanonicalRecordRead, rawVisitId: unknown,
  work: (query: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope, visitId: number) => Promise<T>): Promise<T> {
  const visitId = visitIdOf(rawVisitId);
  return runCanonicalReadSnapshot(session, read, async (query, scope) => {
    const patientScope = scope.patientScope;
    if (patientScope.kind === "none") throw new CanonicalPatientReadRefusal("patient_not_found", VISIT_MISSING);
    const { rows: [row] } = await query.query<{ patient_id: number | null; doctor_id: number | null }>("SELECT patient_id, doctor_id FROM visits WHERE id = $1", [visitId]);
    const inside = row !== undefined && (patientScope.kind === "all" || row.doctor_id === patientScope.clinicianPartyId
      || (row.patient_id !== null && await patientInDoctorScopeWith(query, patientScope.clinicianPartyId, row.patient_id)));
    if (!inside) throw new CanonicalPatientReadRefusal("patient_not_found", VISIT_MISSING);
    return work(query, scope, visitId);
  }, { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}

/** `GET /api/visits/[id]/billing-preview`: the whole response is dues (finance.invoices.view). */
export async function readCanonicalVisitBillingPreview(session: VerifiedDurableSession, rawVisitId: unknown) {
  return readInsideVisit(session, "read:visits.money", rawVisitId, async (query, _scope, visitId) => {
    const preview = await previewVisitBillingWith(query as DbClient, visitId);
    if (!preview) throw new CanonicalPatientReadRefusal("patient_not_found", VISIT_MISSING);
    return preview;
  });
}

/** `GET /api/visits/[id]/financial-context`: clinical coverage for documenters; the source
 * references (invoice and agreement identifiers and links) with finance.invoices.view only. */
export async function readCanonicalVisitFinancialContext(session: VerifiedDurableSession, rawVisitId: unknown) {
  return readInsideVisit(session, "read:visits.financial-context", rawVisitId, async (query, scope, visitId) => {
    const { rows: [visit] } = await query.query<{ patient_id: number | null }>("SELECT patient_id FROM visits WHERE id = $1", [visitId]);
    const result = await readVisitFinancialContext(query as DbClient, visitId, visit?.patient_id ?? null);
    if (!result) throw new CanonicalPatientReadRefusal("patient_not_found", VISIT_MISSING);
    return redactVisitFinancialContext(result, scope.isProtectedOwner() || scope.granted("finance.invoices.view"));
  });
}

/** A per-currency amount map copied by the known currencies only. */
function currencyMap(source: Partial<Record<Currency, number>>): Partial<Record<Currency, number>> {
  const out: Partial<Record<Currency, number>> = {};
  for (const currency of CURRENCIES) if (typeof source[currency] === "number") out[currency] = source[currency];
  return out;
}

export interface WalkoutGrants { readonly payments: boolean; readonly ledger: boolean; readonly collect: boolean; readonly handoff: boolean }

/** The walkout allowlist (admission already proved finance.invoices.view: the dues group). */
export function projectCanonicalWalkout(input: {
  walkout: VisitWalkout; summary: CheckoutCurrencyLine[]; dueRecommendation: CheckoutDueRecommendation | null; signedToday: boolean;
  receptionHandoff?: { status: string; handledReason: string | null } | null;
}, grants: WalkoutGrants) {
  const { walkout } = input;
  const dueGroup = grants.payments && grants.ledger;
  return {
    visitId: walkout.visitId, patientId: walkout.patientId, patientName: walkout.patientName, patientNumber: walkout.patientNumber,
    arrivedAt: walkout.arrivedAt, signedAt: walkout.signedAt, doctorName: walkout.doctorName,
    treatmentDone: walkout.treatmentDone, nextPlan: walkout.nextPlan,
    lines: walkout.lines.map(line => ({
      description: line.description, toothCode: line.toothCode, quantity: line.quantity, billingClass: line.billingClass,
      unitPriceMinor: line.unitPriceMinor, currency: line.currency, included: line.included,
      ...(line.financialReviewRequired !== undefined ? { financialReviewRequired: line.financialReviewRequired } : {}),
    })),
    orthoAdjustment: walkout.orthoAdjustment === null ? null : {
      id: walkout.orthoAdjustment.id, billingClass: walkout.orthoAdjustment.billingClass, decision: walkout.orthoAdjustment.decision,
      pendingDecision: walkout.orthoAdjustment.pendingDecision,
      ...(walkout.orthoAdjustment.coverageReviewRequired !== undefined ? { coverageReviewRequired: walkout.orthoAdjustment.coverageReviewRequired } : {}),
    },
    invoice: walkout.invoice === null ? null : { id: walkout.invoice.id, number: walkout.invoice.number, netMinor: walkout.invoice.netMinor, currency: walkout.invoice.currency },
    nextAppointment: walkout.nextAppointment === null ? null : { date: walkout.nextAppointment.date, time: walkout.nextAppointment.time },
    deferred: walkout.deferred,
    signedToday: input.signedToday,
    ...(grants.payments ? { payments: walkout.payments.map(row => ({ receiptNumber: row.receiptNumber, kind: row.kind, amountMinor: row.amountMinor, currency: row.currency })) } : {}),
    ...(grants.ledger ? { balances: walkout.balances.map(row => ({ currency: row.currency, balanceMinor: row.balanceMinor })) } : {}),
    checkout: {
      ...(grants.ledger ? { previous: currencyMap(walkout.checkout.previous), current: currencyMap(walkout.checkout.current) } : {}),
      ...(grants.payments ? {
        invoicePaidMinor: walkout.checkout.invoicePaidMinor,
        paymentsToday: walkout.checkout.paymentsToday.map(row => ({ currency: row.currency, netMinor: row.netMinor })),
        openingPaidToday: walkout.checkout.openingPaidToday.map(row => ({ currency: row.currency, netMinor: row.netMinor })),
      } : {}),
    },
    summary: input.summary.map(line => ({
      currency: line.currency, newBillableMinor: line.newBillableMinor,
      ...(grants.payments ? { paymentsTodayMinor: line.paymentsTodayMinor, todayRemainingMinor: line.todayRemainingMinor } : {}),
      ...(grants.ledger ? { previousBalanceMinor: line.previousBalanceMinor, currentBalanceMinor: line.currentBalanceMinor,
        legacySuggestedMinor: line.legacySuggestedMinor, legacyRemainingMinor: line.legacyRemainingMinor } : {}),
      ...(dueGroup ? { dueNowMinor: line.dueNowMinor } : {}),
    })),
    ...(dueGroup ? { dueRecommendation: input.dueRecommendation === null ? null : {
      patientId: input.dueRecommendation.patientId, visitInvoiceId: input.dueRecommendation.visitInvoiceId,
      accountHref: input.dueRecommendation.accountHref,
      collectionAction: grants.collect ? input.dueRecommendation.collectionAction : "none",
      currencies: input.dueRecommendation.currencies.map(row => ({
        currency: row.currency, currentBalanceMinor: row.currentBalanceMinor, knownRemainingMinor: row.knownRemainingMinor,
        otherRemainingMinor: row.otherRemainingMinor, dueNowMinor: row.dueNowMinor, status: row.status, reasons: [...row.reasons],
        sources: row.sources.map(source => ({ kind: source.kind, authorityId: source.authorityId, currency: source.currency, invoiceId: source.invoiceId,
          openingCurrency: source.openingCurrency, remainingMinor: source.remainingMinor, dueNowMinor: source.dueNowMinor, available: source.available })),
      })),
    } } : {}),
    ...(grants.handoff && input.receptionHandoff ? { receptionHandoff: { status: input.receptionHandoff.status, handledReason: input.receptionHandoff.handledReason } } : {}),
  };
}

/** `GET /api/visits/[id]/walkout`: finance.invoices.view inside the scope, the groups by grant. */
export async function readCanonicalVisitWalkout(session: VerifiedDurableSession, rawVisitId: unknown) {
  return readInsideVisit(session, "read:visits.money", rawVisitId, async (query, scope, visitId) => {
    const checkout = await readVisitCheckoutInSnapshot(query as DbClient, visitId);
    if (!checkout) throw new CanonicalPatientReadRefusal("patient_not_found", VISIT_MISSING);
    const owner = scope.isProtectedOwner();
    const has = (capability: Parameters<typeof scope.granted>[0]) => owner || scope.granted(capability);
    const { walkout, summary, dueRecommendation, today } = checkout;
    const signedToday = walkout.signedAt !== null && clinicDateString(new Date(walkout.signedAt), CLINIC_TIME_ZONE) === today;
    const grants: WalkoutGrants = {
      payments: has("finance.payments.view"), ledger: has("finance.patient-ledger.view"),
      collect: has("finance.payments.collect"), handoff: has("visits.manage"),
    };
    const handoff = grants.handoff && walkout.signedAt ? await readReceptionHandoffWith(query, visitId, walkout) : null;
    return projectCanonicalWalkout({ walkout, summary, dueRecommendation, signedToday,
      receptionHandoff: handoff ? { status: handoff.status, handledReason: handoff.handledReason } : null }, grants);
  });
}
