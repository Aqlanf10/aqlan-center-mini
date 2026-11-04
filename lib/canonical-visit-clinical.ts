import "server-only";
import { NextResponse } from "next/server";
import { getClinicalVisitWith, getPool, patientInDoctorScopeWith, type ClinicalVisit } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { labVisitReviewVersion } from "./lab-visit-signature";
import { CanonicalPatientReadRefusal } from "./canonical-patient-reads";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { LabWorkIntentError, labWorkIntentSupported, readLabWorkCommandForActorInTransaction } from "./lab-work-intent-db";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The visit cockpit on the canonical runtime (M2 slice 84):
 * `GET /api/visits/[id]/clinical` and `GET /api/visits/[id]/lab-work-command`.
 *
 * The read (design: docs/review/visit-documentation-contract-design-20261104.md §2):
 * - `read:patients.clinical` inside one owning snapshot; the visit inside the scope by the
 *   queue read's condition (all, the clinician's assigned visit, or its patient inside the
 *   scope); outside reads like missing (404).
 * - The legacy composite (`getClinicalVisitWith`) runs on that snapshot. An unlinked visit's
 *   phone-matched file contributes its record context only when the scope admits it.
 * - The projection is an allowlist. The money group — prices, totals, currencies, invoice
 *   references, coverage and billing classes, and the lab signing fence (a hash over the
 *   prices) — is shown only with `finance.invoices.view` (the grant of the visit billing
 *   preview) or to the protected owner (owner rule 6615124926; proposal 3 of the design,
 *   reversible). Hidden fields are omitted, never zeroed.
 * - Orthodontic chairside data and ortho entries among the active cases need
 *   `clinical.ortho.view` (the independent ortho projection).
 *
 * The receipt read (`lab-work-command`): one admitted `clinical.lab.order` transaction (the
 * legacy doctor/admin labels), the visit's patient inside the scope, the legacy lock order
 * (patient, then the visit, NOWAIT) and the same actor/key try-lock, then rolled back.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const VISIT_MISSING = "لا توجد زيارة بهذا الرقم ضمن مرضاك.";

type Row = Record<string, unknown>;
const pick = (source: object, keys: readonly string[]): Row => {
  const out: Row = {};
  for (const key of keys) if (Object.hasOwn(source, key)) out[key] = (source as Row)[key];
  return out;
};

export const VISIT_CLINICAL_KEYS = Object.freeze([
  "labWorkIntentSupported", "labWorkIntentRequired", "labReviewVersion", "id", "patientId", "patientName", "chiefComplaint", "examination",
  "diagnosis", "treatmentDone", "nextPlan", "addendum", "doctorId", "status", "signedAt", "signedBy", "arrivedAt",
  "procedures", "planItemsMatched", "planTitle", "amendedServiceConflict", "plannedVisit", "previousVisit",
  "latestDiagnosis", "activeCases", "outstanding", "labOrders", "suggestions", "referral",
] as const);
export const VISIT_MONEY_KEYS = Object.freeze([
  "totalMinor", "planCurrency", "billingCurrency", "invoiceId", "invoiceReferenceState", "planWarning", "sessionPricing",
  "labSignVersion",
] as const);
export const PROCEDURE_CLINICAL_KEYS = Object.freeze([
  "labWork", "labWorkOrderId", "id", "serviceId", "serviceName", "category", "toothCode", "surfaces", "quantity",
  "doctorId", "planItemId", "note",
] as const);
export const PROCEDURE_MONEY_KEYS = Object.freeze(["unitPriceMinor", "totalMinor", "planCurrency"] as const);
export const OUTSTANDING_CLINICAL_KEYS = Object.freeze([
  "labWork", "labWorkOrderId", "planItemId", "serviceId", "planTitle", "serviceName", "toothCode", "sessionCount",
  "doneSessions", "quantity", "status", "surfaces", "caseId", "caseSite", "unmetRequirements", "clinicalConsentRecorded",
] as const);
export const OUTSTANDING_MONEY_KEYS = Object.freeze([
  "unitPriceMinor", "billingRule", "billingStatus", "planCurrency", "includedByAgreement", "prebilled", "origin",
  "originInvoiceId", "billedInvoiceId", "financialReviewRequired",
] as const);
export const ORTHO_CLINICAL_KEYS = Object.freeze([
  "caseId", "appliance", "phase", "slot", "upperWire", "lowerWire", "lastAdjustment", "daysSinceLast", "lastDone",
  "elastics", "elasticNote", "suggestedUpper", "suggestedLower", "visitAdjustmentId", "legacyBaseline", "nextWeeks",
] as const);
export const ORTHO_MONEY_KEYS = Object.freeze(["adjustmentBillingClass"] as const);

export interface VisitClinicalView { readonly money: boolean; readonly ortho: boolean }

/** Pure allowlist projection of the legacy composite. */
export function projectCanonicalVisitClinical(visit: ClinicalVisit, view: VisitClinicalView): Row {
  const keys = (clinical: readonly string[], money: readonly string[]) => view.money ? [...clinical, ...money] : clinical;
  const out = pick(visit, keys(VISIT_CLINICAL_KEYS, VISIT_MONEY_KEYS));
  out.procedures = visit.procedures.map(line => pick(line, keys(PROCEDURE_CLINICAL_KEYS, PROCEDURE_MONEY_KEYS)));
  out.outstanding = visit.outstanding.map(item => pick(item, keys(OUTSTANDING_CLINICAL_KEYS, OUTSTANDING_MONEY_KEYS)));
  out.activeCases = view.ortho ? visit.activeCases : visit.activeCases.filter(entry => entry.kind !== "ortho");
  if (view.ortho) out.ortho = visit.ortho === null ? null : pick(visit.ortho, keys(ORTHO_CLINICAL_KEYS, ORTHO_MONEY_KEYS));
  return out;
}

const visitIdOf = (raw: unknown) => {
  const value = typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new CanonicalPatientReadRefusal("invalid_patient_query", "رقم الزيارة غير صالح.");
  return value;
};

export async function readCanonicalVisitClinical(session: VerifiedDurableSession, rawVisitId: unknown) {
  const visitId = visitIdOf(rawVisitId);
  return runCanonicalReadSnapshot(session, "read:patients.clinical", async (query, scope) => {
    const patientScope = scope.patientScope;
    if (patientScope.kind === "none") throw new CanonicalPatientReadRefusal("patient_not_found", VISIT_MISSING);
    const patientInside = async (patientId: number) =>
      patientScope.kind === "all" || patientInDoctorScopeWith(query, patientScope.clinicianPartyId, patientId);
    const { rows: [row] } = await query.query<{ patient_id: number | null; doctor_id: number | null }>(
      "SELECT patient_id, doctor_id FROM visits WHERE id = $1", [visitId]);
    const inside = row !== undefined && (patientScope.kind === "all" || row.doctor_id === patientScope.clinicianPartyId
      || (row.patient_id !== null && await patientInside(row.patient_id)));
    if (!inside) throw new CanonicalPatientReadRefusal("patient_not_found", VISIT_MISSING);
    const visit = await getClinicalVisitWith(query, visitId, { actorPartyId: scope.clinicianPartyId, admitPreviewPatient: patientInside });
    if (!visit) throw new CanonicalPatientReadRefusal("patient_not_found", VISIT_MISSING);
    const owner = scope.isProtectedOwner();
    // The money-free lab review fence (slice 87): what a reviewer without the invoice view signs against.
    if (visit.labWorkIntentSupported) Object.assign(visit, { labReviewVersion: labVisitReviewVersion({ ...visit, visitId: visit.id }) });
    return projectCanonicalVisitClinical(visit, {
      money: owner || scope.granted("finance.invoices.view"),
      ortho: owner || scope.granted("clinical.ortho.view"),
    });
  }, { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}

export class CanonicalLabCommandRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "CanonicalLabCommandRefusal";
  }
}
const UNPROVEN = "تعذّر إثبات نتيجة العملية؛ لا تنشئ طلبًا بديلًا.";

export async function readCanonicalVisitLabCommand(session: VerifiedDurableSession, rawVisitId: unknown, requestKey: string, requestHash: string, pool = getPool()) {
  const visitId = visitIdOf(rawVisitId);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey) || !/^[a-f0-9]{64}$/.test(requestHash)) {
    throw new CanonicalLabCommandRefusal("invalid_command", 400, "مرجع العملية غير صالح.");
  }
  try {
    return await withStaffOperation(pool, session, "clinical.lab.order", async (client, handle) => {
      const scope = await staffOperationPatientScope(client, handle, "clinical.lab.order");
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (!await labWorkIntentSupported(client)) throw new CanonicalLabCommandRefusal("schema_unavailable", 503, UNPROVEN);
      const { rows: [visit] } = await client.query<{ patient_id: number | null }>("SELECT patient_id FROM visits WHERE id = $1", [visitId]);
      // The receipt belongs to the visit's file: an unlinked visit, or one outside the scope, reads as missing.
      if (!visit?.patient_id || !(scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, visit.patient_id))) {
        throw new CanonicalLabCommandRefusal("visit_not_found", 404, VISIT_MISSING);
      }
      await client.query("SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE NOWAIT", [visit.patient_id]);
      const { rows: [locked] } = await client.query<{ patient_id: number | null }>("SELECT patient_id FROM visits WHERE id = $1 FOR SHARE NOWAIT", [visitId]);
      if (locked?.patient_id !== visit.patient_id) throw new CanonicalLabCommandRefusal("source_changed", 409, UNPROVEN);
      const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
      const result = await readLabWorkCommandForActorInTransaction(client, {
        actorUserId: identity.userId, patientId: visit.patient_id, sourceKind: "visit", sourceId: visitId, requestKey, requestHash,
      });
      return result
        ? { found: true as const, receipt: { requestKey, requestHash, visitId, patientId: visit.patient_id, actor: identity.username }, result }
        : { found: false as const };
    });
  } catch (error) {
    if (error instanceof LabWorkIntentError) throw new CanonicalLabCommandRefusal(error.code, error.status === 400 ? 400 : 409, UNPROVEN);
    if ((error as { code?: string }).code === "55P03") throw new CanonicalLabCommandRefusal("command_busy", 409, UNPROVEN);
    throw error;
  }
}

export function canonicalLabCommandFailure(error: unknown): NextResponse {
  if (error instanceof CanonicalLabCommandRefusal) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  }
  return canonicalPatientReadFailure(error, UNPROVEN);
}
