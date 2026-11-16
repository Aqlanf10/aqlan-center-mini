import "server-only";
import { NextResponse } from "next/server";
import {
  addVisitAddendumOn, doctorOwnsPatient, getClinicalVisitWith, getPool, getSettingsWith, insertAuditRow, lockVisitPatientFirst, saveClinicalNotes,
  setVisitProceduresOn, signClinicalVisitLockedOn, ClinicalPlanConflict, ProcedurePriceRejected, InventoryShortage, CLINIC_TIME_ZONE,
  type DbClient, type ProcedurePriceOverride,
} from "./db";
import { InventoryBusy, InventoryTrackingRequired } from "./inventory-domain/legacy-write-guard";
import { checkOrthoSessionDraft } from "./ortho-baseline";
import { CLINICAL_SIGN_MESSAGES } from "./clinical-sign-messages";
import { labVisitReviewVersion, labVisitSignatureVersion } from "./lab-visit-signature";
import { ClinicalDoctorIdentityConflict } from "./clinical-doctor-identity";
import { createHash } from "node:crypto";
import { LabWorkIntentError, canonicalLabActor } from "./lab-work-intent-db";
import { LabWorkContractError, parseLabWorkDraft, parseLabWorkRetirements, type LabWorkDraft } from "./lab-work-intent-contract";
import { settleRejectedClinicalLabCommandOn } from "./clinical-lab-command-settlement";
import { foreignRatesFromSettings } from "./service-pricing";
import { clinicDateString } from "./schedule";
import { CLINIC_BASE_CURRENCY, isCurrency } from "./money";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { readCanonicalVisitClinical } from "./canonical-visit-clinical";
import {
  staffOperationCapabilities, staffOperationClinician, staffOperationIdentity, staffOperationIsProtectedOwner,
  staffOperationPatientScope, withStaffOperation,
} from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Canonical visit documentation (M2 slice 85): POST /api/visits/[id]/clinical
 * `save` and `addendum`. Design: docs/review/visit-documentation-contract-design-20261104.md §3.
 *
 * - One admitted `clinical.visits.document` transaction; the visit inside the scope by the
 *   queue read's condition (outside = 404).
 * - A clinician-linked actor or the protected owner documents any day: notes, the treating
 *   doctor and procedures. Any other documenting account (the legacy assistant label)
 *   documents today's visits only, notes only: the doctor and the procedures unchanged
 *   (403 otherwise). The role check precedes body validation.
 * - Procedures run the legacy body (`setVisitProceduresOn`) with price authority by grants
 *   (the approved map's `priceOverrides` fields): a missing price is the server price (an
 *   unchanged saved line keeps its saved price; a new line the catalogue price); a
 *   discount `finance.discounts.apply` within the ceiling, beyond it
 *   `finance.discounts.override`; an increase or a manual price for an unpriced service
 *   `finance.price-increases.apply`; each override audited in the same transaction.
 * - The addendum (the map: `clinical.visits.document`) appends to a signed visit, with the
 *   same actor rule; audited in the same transaction; an optional request key replays.
 * - Refused, never guessed (409): a change of the visit's billing currency (financial
 *   group 4).
 * - A lab draft inside the save (M2 slice 87): a clinician-linked actor or the owner holding
 *   `clinical.lab.order` (legacy doctor/admin); the legacy command identity (request key,
 *   the body's hash, the expected patient) and body; the lab layer binds the receipt to the
 *   canonical actor (`canonicalLabActor`). An exact replay returns the saved result; a
 *   deterministic rejection rolls back and is then settled durably in a freshly admitted
 *   operation that re-proves the same authority (legacy semantics); unknown failures stay
 *   unresolved.
 * - The response is the projected cockpit read (no money without finance.invoices.view).
 *
 * Signing (M2 slice 86; owner decisions 6629149113): `action: "sign"` in the same admitted
 * transaction, running the legacy locked body (`signClinicalVisitLockedOn`: invoice,
 * sessions, inventory, ortho adjustment). `clinical.visits.sign` or the owner; a signer
 * without a clinician link finishes today's visits only, without orthodontic session data
 * or a billing decision, and is never the default treating doctor (the legacy assistant
 * finisher). The visit must be linked to a file. Orthodontic session data needs
 * `clinical.ortho.edit` (the map). "No charge" for an outside-contract adjustment: the
 * owner, or the adjustment case's responsible doctor holding `clinical.ortho.edit` while
 * the owner-only setting `ortho.case_doctor_no_charge` is on; never a finance grant. The
 * reason, the decider and the basis go to the `visit.sign` audit row in the same
 * transaction. The sign summary's amounts and invoice references are returned only with
 * `finance.invoices.view` or to the owner. A visit carrying durable lab work is signed only
 * by a signer holding `clinical.lab.order` (or the owner): the lab layer materializes its
 * orders bound to the canonical actor (slice 87).
 */
export class CanonicalVisitDocumentRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "CanonicalVisitDocumentRefusal";
  }
}
const refuse = (code: string, status: 400 | 403 | 404 | 409, message: string) => new CanonicalVisitDocumentRefusal(code, status, message);
const VISIT_MISSING = "لا توجد زيارة بهذا الرقم ضمن مرضاك.";
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const text = (value: unknown, max = 2000) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

type ProcedureRow = {
  labWork?: LabWorkDraft | null;
  serviceId: number; toothCode: number | null; surfaces: string | null; quantity: number;
  unitPriceMinor: number | null; priceReason: string | null; doctorId: number | null; note: string | null; planItemId: number | null;
};
/** Legacy parsing (rows without a service are dropped), except that a missing price stays
 * missing: the server price, never a zero request. */
export function parseCanonicalProcedures(raw: unknown): ProcedureRow[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) throw refuse("invalid_procedures", 400, "قائمة الإجراءات غير صالحة.");
  return raw.map(row => (row ?? {}) as Record<string, unknown>).filter(row => Number(row.serviceId) > 0).map(row => ({
    ...(row.labWork !== undefined ? { labWork: parseLabWorkDraft(row.labWork) } : {}),
    serviceId: Number(row.serviceId),
    toothCode: Number(row.toothCode) || null,
    surfaces: typeof row.surfaces === "string" ? row.surfaces : null,
    quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
    unitPriceMinor: row.unitPriceMinor === undefined || row.unitPriceMinor === null ? null : Math.max(0, Math.round(Number(row.unitPriceMinor) || 0)),
    priceReason: text(row.priceReason, 300),
    doctorId: Number(row.doctorId) || null,
    note: text(row.note, 300),
    planItemId: Number(row.planItemId) > 0 ? Number(row.planItemId) : null,
  }));
}
const clinicalKey = (line: { serviceId: number; toothCode: number | null; surfaces: string | null; quantity: number; doctorId: number | null; planItemId: number | null }) =>
  JSON.stringify([line.serviceId, line.toothCode ?? null, (line.surfaces ?? "").trim() || null, line.quantity, line.doctorId ?? null, line.planItemId ?? null]);

const hasLabCommand = (body: Record<string, unknown>) => Object.hasOwn(body, "labRequestKey") || Object.hasOwn(body, "labRetirements")
  || (Array.isArray(body.procedures) && body.procedures.some(row => !!row && typeof row === "object" && !!(row as Record<string, unknown>).labWork));

const visitIdOf = (raw: string) => {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw refuse("invalid_visit_input", 400, "رقم الزيارة غير صالح.");
  return Number(raw);
};

/** Lock-order contention while proving scope is a bounded refusal, never a backward wait
 * (the reviewed mechanism of 2fb7c07c). The whole operation rolls back. */
async function withoutScopeLockWait<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
      throw refuse("visit_scope_conflict", 409, "تعذّر تثبيت نطاق الزيارة والمريض. حدّث الزيارة وراجع النتيجة قبل طلب جديد.");
    }
    throw error;
  }
}

/**
 * Admission after the writers' own locks, held to commit: the visit's patient first
 * (`lockVisitPatientFirst`, FOR NO KEY UPDATE), then the visit FOR UPDATE, then the scope
 * decided on the locked row. A doctor's link through this visit holds because the visit is
 * locked; any other link is a positive ownership witness held FOR SHARE (NOWAIT). A patient
 * changed while waiting would need its lock after the visit's (the reverse order): refused
 * (409) instead. Every writer below (save, addendum, sign, lab draft) re-takes the same
 * locks in the same order.
 */
async function admitLockedVisit(client: DbClient, handle: Parameters<typeof staffOperationCapabilities>[1], visitId: number) {
  const scope = await staffOperationPatientScope(client, handle, "clinical.visits.document");
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const lockedPatient = await lockVisitPatientFirst(client, visitId);
  const { rows: [visit] } = await client.query<{ patient_id: number | null; doctor_id: number | null; arrived_at: Date; billing_currency: string | null }>(
    "SELECT patient_id, doctor_id, arrived_at, billing_currency FROM visits WHERE id = $1 FOR UPDATE", [visitId]);
  if (!visit) throw refuse("visit_not_found", 404, VISIT_MISSING);
  if (visit.patient_id !== null && visit.patient_id !== lockedPatient) {
    throw refuse("visit_scope_conflict", 409, "تعذّر تثبيت نطاق الزيارة والمريض. حدّث الزيارة وراجع النتيجة قبل طلب جديد.");
  }
  const inside = scope.kind === "all" || visit.doctor_id === scope.clinicianPartyId
    || (visit.patient_id !== null && await withoutScopeLockWait(() => doctorOwnsPatient(scope.clinicianPartyId, visit.patient_id!, client, "nowait")));
  if (!inside) throw refuse("visit_not_found", 404, VISIT_MISSING);
  return visit;
}

export async function commandCanonicalVisitDocument(session: VerifiedDurableSession, rawVisitId: string, rawBody: unknown, pool = getPool()) {
  const visitId = visitIdOf(rawVisitId);
  const body = (rawBody ?? {}) as Record<string, unknown>;
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) throw refuse("invalid_body", 400, "طلب غير صالح.");
  const action = String(body.action ?? "save");
  const labCommand = hasLabCommand(body) ? labCommandOf(body) : null;
  let labActor: { userId: number; username: string; role: string } | null = null;
  let signed: Record<string, unknown> | undefined;
  try {
  signed = await withStaffOperation(pool, session, "clinical.visits.document", async (client, handle): Promise<Record<string, unknown> | undefined> => {
    const visit = await admitLockedVisit(client, handle, visitId);
    const clinician = await staffOperationClinician(client, handle, "clinical.visits.document");
    const owner = await staffOperationIsProtectedOwner(client, handle, "clinical.visits.document");
    const full = clinician !== null || owner;
    if (!full && clinicDateString(visit!.arrived_at, CLINIC_TIME_ZONE) !== clinicDateString(new Date(), CLINIC_TIME_ZONE)) {
      throw refuse("visit_today_only", 403, "التوثيق دون ارتباطٍ بطبيب يقتصر على زيارات اليوم.");
    }
    if (action === "sign") {
      const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
      return signCanonicalVisitInOperation(client, handle, visitId, visit!, body, clinician, owner, identity);
    }
    if (action !== "save" && action !== "addendum") throw refuse("invalid_action", 400, "إجراء غير معروف على الزيارة.");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    if (labCommand) {
      await requireLabAuthority(client, handle, full, owner);
      if (action !== "save" || !labCommand.valid) throw refuse("invalid_lab_command", 400, "هوية عملية مسوّدة المختبر غير صالحة.");
      if (labCommand.patientId !== visit!.patient_id) throw refuse("source_changed", 409, "تغيّر المريض المرتبط بالزيارة؛ حدّث الملف قبل حفظ عمل المختبر.");
      labActor = identity;
    }
    if (action === "addendum") { await appendCanonicalVisitAddendum(client, visitId, body, identity); return undefined; }
    await saveCanonicalVisitDocumentation(client, handle, visitId, visit!, body, full, identity, labCommand && labActor ? { ...labCommand, actor: labActor } : null);
    return undefined;
  });
  } catch (error) {
    const code = labCommand?.valid && labActor ? labRejectionCode(error) : null;
    if (code && labCommand && labActor) {
      const outcome = await settleCanonicalLabRejection(pool, session, visitId, labCommand, labActor, code).catch(() => null);
      if (outcome?.outcome === "applied") {
        return { ...await readCanonicalVisitClinical(session, visitId), labWorkCommand: labReceipt(visitId, labCommand, labActor) };
      }
      if (outcome?.outcome === "rejected") {
        throw new CanonicalVisitDocumentRefusal(outcome.code, 409, "لم يُحفظ الطلب. حدّث البيانات وصحّحها ثم احفظ من جديد.",
          { labWorkCommand: labReceipt(visitId, labCommand, labActor), labWorkOutcome: "rejected" });
      }
    }
    throw error;
  }
  const read = await readCanonicalVisitClinical(session, visitId);
  if (signed) return { ...read, signResult: signed };
  return labCommand && labActor ? { ...read, labWorkCommand: labReceipt(visitId, labCommand, labActor) } : read;
}

type LabCommand = { valid: boolean; patientId: number; requestKey: string; requestHash: string; retirements: unknown };
/** The legacy command identity: the request key, the expected patient and the body's hash. */
function labCommandOf(body: Record<string, unknown>): LabCommand {
  const valid = Array.isArray(body.procedures) && Number.isSafeInteger(body.labPatientId) && Number(body.labPatientId) > 0
    && typeof body.labRequestKey === "string" && KEY.test(body.labRequestKey);
  return { valid, patientId: Number(body.labPatientId), requestKey: String(body.labRequestKey ?? ""),
    requestHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), retirements: body.labRetirements };
}
const labReceipt = (visitId: number, command: LabCommand, actor: { username: string }) =>
  ({ requestKey: command.requestKey, requestHash: command.requestHash, visitId, patientId: command.patientId, actor: actor.username });
async function requireLabAuthority(client: DbClient, handle: Parameters<typeof staffOperationCapabilities>[1], full: boolean, owner: boolean) {
  if (!full) throw refuse("lab_draft_clinician_only", 403, "مسوّدة المختبر للطبيب المرتبط أو المالك.");
  if (!owner && !(await staffOperationCapabilities(client, handle, "clinical.visits.document", ["clinical.lab.order"] as const)).has("clinical.lab.order")) {
    throw refuse("lab_order_not_granted", 403, "مسوّدة المختبر تحتاج صلاحية طلب أعمال المختبر.");
  }
}
const UNRESOLVED_LAB = new Set(["command_busy", "intent_busy", "clinical_boundary_busy", "unauthorized", "schema_unavailable", "idempotency_conflict", "source_changed", "invalid_receipt"]);
/** The legacy route's deterministic rejections: only these are settled durably. */
function labRejectionCode(error: unknown): string | null {
  if (error instanceof LabWorkContractError) return error.code;
  if (error instanceof LabWorkIntentError && error.status === 409 && !UNRESOLVED_LAB.has(error.code)) return error.code;
  if (error instanceof ClinicalDoctorIdentityConflict) return error.code;
  if (error instanceof ClinicalPlanConflict) return "clinical_plan_conflict";
  if (error instanceof ProcedurePriceRejected) return "procedure_price_rejected";
  return null;
}
/** Settlement in a freshly admitted operation: the same scope, clinician-or-owner and
 * clinical.lab.order are proved again before the rejection receipt is written. */
async function settleCanonicalLabRejection(pool: ReturnType<typeof getPool>, session: VerifiedDurableSession, visitId: number,
  command: LabCommand, actor: { userId: number; username: string; role: string }, code: string) {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "clinical.visits.document");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "own" && !await withoutScopeLockWait(() => doctorOwnsPatient(scope.clinicianPartyId, command.patientId, client, "nowait"))) {
      throw refuse("visit_not_found", 404, VISIT_MISSING);
    }
    const clinician = await staffOperationClinician(client, handle, "clinical.visits.document");
    const owner = await staffOperationIsProtectedOwner(client, handle, "clinical.visits.document");
    await requireLabAuthority(client, handle, clinician !== null || owner, owner);
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    if (identity.userId !== actor.userId) throw new Error("STAFF_OPERATION_PERMISSIONS_STALE");
    return settleRejectedClinicalLabCommandOn(client, { patientId: command.patientId, visitId, session: canonicalLabActor(identity),
      requestKey: command.requestKey, requestHash: command.requestHash, code });
  });
}

const NO_CHARGE_REFUSED = "قرار «بلا رسوم» لشدّة خارج الاتفاق للمالك، ولطبيب حالة التقويم المسؤول عنها بصلاحية تعديل التقويم إذا فعّل المالك ذلك في الإعدادات.";

async function signCanonicalVisitInOperation(
  client: DbClient, handle: Parameters<typeof staffOperationCapabilities>[1], visitId: number,
  visit: { patient_id: number | null }, body: Record<string, unknown>, clinician: number | null, owner: boolean,
  identity: { userId: number; username: string; role: string },
): Promise<Record<string, unknown>> {
  const held = await staffOperationCapabilities(client, handle, "clinical.visits.document",
    ["clinical.visits.sign", "clinical.ortho.edit", "finance.invoices.view", "clinical.lab.order"] as const);
  if (!owner && !held.has("clinical.visits.sign")) throw refuse("visit_sign_not_granted", 403, "توقيع الزيارة يحتاج صلاحية توقيع الزيارات.");
  const full = clinician !== null || owner;
  const orthoEdit = owner || held.has("clinical.ortho.edit");
  const hasOrthoSession = body.orthoSession !== undefined && body.orthoSession !== null;
  if (hasOrthoSession && !(full && orthoEdit)) {
    throw refuse("ortho_session_not_granted", 403, "تسجيل شدّة التقويم عند التوقيع لطبيبٍ مرتبط بصلاحية تعديل التقويم، أو للمالك.");
  }
  const rawDecision = body.outsideContractDecision ?? null;
  let decision: { decision: "no_charge"; reason: string } | null = null;
  let basis: "owner" | "case_doctor" | null = null;
  if (rawDecision !== null) {
    // Authority before validation: the owner always; otherwise the setting, the clinician
    // link and clinical.ortho.edit now, and the exact case below (inside the locked body).
    if (!owner) {
      const settings = await getSettingsWith(client);
      if (settings["ortho.case_doctor_no_charge"] !== "true" || clinician === null || !held.has("clinical.ortho.edit")) {
        throw refuse("no_charge_not_granted", 403, NO_CHARGE_REFUSED);
      }
    }
    const candidate = rawDecision as { decision?: unknown; reason?: unknown };
    if (typeof rawDecision !== "object" || candidate.decision !== "no_charge" || typeof candidate.reason !== "string") {
      throw refuse("invalid_decision", 400, "قرار الشدّة غير صالح — «بلا رسوم» مع سببٍ مكتوب.");
    }
    decision = { decision: "no_charge", reason: candidate.reason };
    basis = owner ? "owner" : "case_doctor";
  }
  const orthoSession = checkOrthoSessionDraft(body.orthoSession);
  if (!orthoSession.ok) throw refuse("invalid_ortho_session", 400, orthoSession.message);
  if (visit.patient_id === null) throw refuse("visit_unlinked", 409, "اربط الزيارة بملف مريض أو افتح له ملفًا قبل التوقيع — الفاتورة تدخل كشف حسابه.");
  const existing = await getClinicalVisitWith(client, visitId, { actorPartyId: clinician });
  if (!existing) throw refuse("visit_not_found", 404, VISIT_MISSING);
  // The lab review fence: a reviewer without the money view signs against the money-free
  // version; once it matches here, the server supplies the full fence the body re-checks
  // under its own locks. A reviewer holding the full fence may still send it.
  let labSignVersion = typeof body.labSignVersion === "string" ? body.labSignVersion : null;
  if (typeof body.labReviewVersion === "string") {
    if (body.labReviewVersion !== labVisitReviewVersion({ ...existing, visitId })) {
      throw refuse("stale_lab_sign_review", 409, "تغيّرت أعمال الزيارة منذ المراجعة؛ حدّث البيانات وراجعها قبل التوقيع.");
    }
    labSignVersion = labVisitSignatureVersion({ visitId, patientId: existing.patientId, doctorId: existing.doctorId,
      billingCurrency: existing.billingCurrency, diagnosis: existing.diagnosis, treatmentDone: existing.treatmentDone, procedures: existing.procedures });
  }
  let outcome: Awaited<ReturnType<typeof signClinicalVisitLockedOn>>;
  try {
    outcome = await signClinicalVisitLockedOn(client, {
      visitId, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: identity.username,
      // The legacy finisher rule: an account without a clinician link is never the default treating doctor.
      signerDoctorPartyId: clinician,
      dependencyOverrideReason: typeof body.dependencyOverrideReason === "string" ? body.dependencyOverrideReason : null,
      orthoSession: orthoSession.value, outsideContractDecision: decision,
      signerRole: identity.role,
      // Durable lab work materializes only for a clinician or the owner holding clinical.lab.order (legacy doctor/admin).
      ...(full && (owner || held.has("clinical.lab.order")) ? { session: canonicalLabActor(identity) } : {}),
      labSignVersion,
      authorizeNoCharge: async caseId => {
        if (owner) return;
        const { rows: [kase] } = caseId === null ? { rows: [] as { responsible_doctor_id: number | null }[] }
          : await client.query<{ responsible_doctor_id: number | null }>("SELECT responsible_doctor_id FROM ortho_cases WHERE id = $1 AND patient_id = $2 FOR SHARE", [caseId, visit.patient_id]);
        if (!kase || kase.responsible_doctor_id === null || kase.responsible_doctor_id !== clinician) throw refuse("no_charge_not_case_doctor", 403, NO_CHARGE_REFUSED);
      },
    }, existing);
  } catch (error) {
    if (error instanceof LabWorkIntentError && error.code === "unauthorized") {
      throw refuse("lab_order_not_granted", 403, "توقيع زيارةٍ تحمل عمل مختبر يحتاج طبيبًا مرتبطًا بصلاحية طلب أعمال المختبر، أو المالك. لم يُوقَّع شيء.");
    }
    throw error;
  }
  if (!outcome.commit) {
    const reason = outcome.result.reason ?? "not_found";
    const status = reason === "invalid_override_reason" || reason === "invalid_decision_reason" ? 400 : 409;
    throw new CanonicalVisitDocumentRefusal(reason, status, CLINICAL_SIGN_MESSAGES[reason] ?? "تعذّر توقيع الزيارة.", {
      ...(outcome.result.unmetRequirements ? { unmetRequirements: outcome.result.unmetRequirements } : {}),
      ...(outcome.result.sessionConflicts ? { sessionConflicts: outcome.result.sessionConflicts } : {}),
    });
  }
  const result = outcome.result;
  await insertAuditRow(client, {
    action: "visit.sign", entity: "visit", entityId: visitId, entityLabel: existing.patientName,
    details: {
      الإجراءات: existing.procedures.length,
      الإجمالي: result.duesMinor,
      الفاتورة: result.invoiceId,
      عملة_الفاتورة: result.invoiceCurrency,
      تحديثات_المخطط: result.chartUpdates,
      بنود_اكتملت: result.planItemsDone,
      جلسات_منجزة: result.sessionsCompleted,
      طلبات_معمل_تلقائية: result.labOrdersCreated,
      حركات_مستهلكات: result.materialsDeducted,
      الجلسة_القادمة: result.nextPlannedVisit?.title ?? null,
      شدّة_التقويم: result.orthoAdjustmentId,
      تصنيف_فوترة_الشدّة: result.orthoBillingClass,
      المنهي: identity.username,
      دور_المنهي: identity.role,
      الطبيب_المعالج: existing.doctorId ?? null,
      ...(decision ? {
        قرار_الشدّة: result.orthoBillingDecision === "billed" ? "فوتِرت" : "بلا رسوم",
        سبب_القرار: decision.reason.trim(),
        متخذ_القرار: identity.username,
        أساس_القرار: basis === "owner" ? "المالك" : "طبيب الحالة (إعداد المالك مفعّل)",
      } : {}),
    },
    actor: identity.username, actorRole: identity.role,
  });
  const money = owner || held.has("finance.invoices.view");
  return {
    sessionsCompleted: result.sessionsCompleted,
    nextPlannedVisit: result.nextPlannedVisit,
    labOrdersCreated: result.labOrdersCreated,
    materialsDeducted: result.materialsDeducted,
    orthoAdjustmentId: result.orthoAdjustmentId,
    ...(money ? {
      invoiceId: result.invoiceId, invoiceCurrency: result.invoiceCurrency, duesMinor: result.duesMinor,
      orthoBillingClass: result.orthoBillingClass,
    } : {}),
  };
}

async function appendCanonicalVisitAddendum(client: DbClient, visitId: number, body: Record<string, unknown>, identity: { userId: number; username: string; role: string }) {
  const note = text(body.text, 1000);
  if (!note) throw refuse("invalid_addendum", 400, "اكتب نصّ الملحق.");
  const requestKey = body.requestKey === undefined ? null : typeof body.requestKey === "string" && KEY.test(body.requestKey) ? body.requestKey : false;
  if (requestKey === false) throw refuse("invalid_request_key", 400, "مفتاح الطلب غير صالح؛ أعد فتح النموذج.");
  if (requestKey) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('visit-addendum:' || $1::text || ':' || $2::text))", [identity.userId, requestKey]);
    const { rows } = await client.query(
      "SELECT 1 FROM audit_log WHERE action = 'visit.addendum' AND entity = 'visit' AND entity_id = $1::text AND details->>'requestKey' = $2 AND details->>'requestActorId' = $3::text LIMIT 1",
      [visitId, requestKey, identity.userId]);
    if (rows.length > 0) return;
  }
  if (!await addVisitAddendumOn(client, { visitId, text: note, author: identity.username })) {
    throw refuse("visit_not_signed", 409, "الملحق يُضاف على زيارة موقَّعة فقط.");
  }
  await insertAuditRow(client, {
    action: "visit.addendum", entity: "visit", entityId: visitId,
    details: { النص: note, ...(requestKey ? { requestKey, requestActorId: String(identity.userId) } : {}) },
    actor: identity.username, actorRole: identity.role,
  });
}

async function saveCanonicalVisitDocumentation(
  client: DbClient, handle: Parameters<typeof staffOperationCapabilities>[1], visitId: number,
  visit: { doctor_id: number | null; billing_currency: string | null }, body: Record<string, unknown>, full: boolean,
  identity: { username: string; role: string },
  lab: (LabCommand & { actor: { userId: number; username: string; role: string } }) | null = null,
) {
  const notes = {
    chiefComplaint: text(body.chiefComplaint, 500), examination: text(body.examination), diagnosis: text(body.diagnosis),
    treatmentDone: text(body.treatmentDone), nextPlan: text(body.nextPlan, 500), doctorId: Number(body.doctorId) || null,
  };
  const procedures = parseCanonicalProcedures(body.procedures);
  if (body.billingCurrency !== undefined && body.billingCurrency !== null) {
    const stored = isCurrency(visit.billing_currency) ? visit.billing_currency : CLINIC_BASE_CURRENCY;
    if (!isCurrency(body.billingCurrency)) throw refuse("invalid_currency", 400, "عملة الزيارة غير صالحة.");
    if (body.billingCurrency !== stored) {
      // Inside a lab command the legacy route settles this as a deterministic rejection.
      if (lab) throw new LabWorkIntentError("invalid_billing_currency", "عملة الزيارة غير صالحة.", 409);
      throw refuse("billing_currency_financial", 409, "تغيير عملة الزيارة قرارٌ مالي لم يُنقل بعد إلى الحساب الموحّد؛ احفظ دون تغييرها.");
    }
  }
  if (!full) {
    if (notes.doctorId !== (visit.doctor_id ?? null)) throw refuse("assistant_doctor_locked", 403, "التوثيق دون ارتباطٍ بطبيب لا يغيّر الطبيب المعالج.");
    if (procedures) {
      const { rows } = await client.query<{ service_id: number; tooth_code: number | null; surfaces: string | null; quantity: number; doctor_id: number | null; plan_item_id: number | null; unit_price_minor: string }>(
        "SELECT service_id, tooth_code, surfaces, quantity, doctor_id, plan_item_id, unit_price_minor::text FROM visit_procedures WHERE visit_id = $1", [visitId]);
      const have = rows.map(row => clinicalKey({ serviceId: row.service_id, toothCode: row.tooth_code, surfaces: row.surfaces, quantity: row.quantity, doctorId: row.doctor_id, planItemId: row.plan_item_id })).sort();
      const want = procedures.map(clinicalKey).sort();
      const priced = procedures.some(line => line.unitPriceMinor !== null);
      if (priced || have.length !== want.length || have.some((key, index) => key !== want[index])) {
        throw refuse("assistant_procedures_locked", 403, "التوثيق دون ارتباطٍ بطبيب لا يعدّل الإجراءات أو أسعارها أو أطباءها — يعدّلها الطبيب.");
      }
    }
    if (!await saveClinicalNotes({ ...notes, visitId }, client)) throw refuse("visit_signed", 409, "الزيارة موقَّعة — لا تُعدَّل. أضف ملحقًا.");
    return;
  }
  if (!procedures) {
    if (!await saveClinicalNotes({ ...notes, visitId }, client)) throw refuse("visit_signed", 409, "الزيارة موقَّعة — لا تُعدَّل. أضف ملحقًا.");
    return;
  }
  // An unchanged saved line keeps its saved price (decided and audited when set): matched
  // one-to-one by its clinical identity, only when no price is sent for it.
  const { rows: saved } = await client.query<{ service_id: number; tooth_code: number | null; surfaces: string | null; quantity: number; doctor_id: number | null; plan_item_id: number | null; unit_price_minor: string }>(
    "SELECT service_id, tooth_code, surfaces, quantity, doctor_id, plan_item_id, unit_price_minor::text FROM visit_procedures WHERE visit_id = $1 ORDER BY id", [visitId]);
  const savedPrices = new Map<string, number[]>();
  for (const row of saved) {
    const key = clinicalKey({ serviceId: row.service_id, toothCode: row.tooth_code, surfaces: row.surfaces, quantity: row.quantity, doctorId: row.doctor_id, planItemId: row.plan_item_id });
    savedPrices.set(key, [...(savedPrices.get(key) ?? []), Number(row.unit_price_minor)]);
  }
  const withKept = procedures.map(line => {
    if (line.unitPriceMinor !== null) return line;
    const kept = savedPrices.get(clinicalKey(line))?.shift();
    return kept === undefined ? line : { ...line, keptPriceMinor: kept };
  });
  const held = await staffOperationCapabilities(client, handle, "clinical.visits.document",
    ["finance.discounts.apply", "finance.discounts.override", "finance.price-increases.apply"] as const);
  const settings = await getSettingsWith(client);
  const maxDiscount = Number(settings["billing.max_discount_percent"]);
  const overrides: ProcedurePriceOverride[] = [];
  const outcome = await setVisitProceduresOn(client, {
    visitId, procedures: withKept, clinicalNotes: notes, overrides, rates: foreignRatesFromSettings(settings),
    ...(lab ? { labCommand: { expectedPatientId: lab.patientId, requestKey: lab.requestKey, requestHash: lab.requestHash,
      retirements: parseLabWorkRetirements(lab.retirements), session: canonicalLabActor(lab.actor) } } : {}),
    authority: {
      grants: { discount: held.has("finance.discounts.apply"), discountOverride: held.has("finance.discounts.override"), increase: held.has("finance.price-increases.apply") },
      maxDiscountPercent: Number.isFinite(maxDiscount) ? maxDiscount : 0,
    },
  });
  if (outcome === "replayed") return; // an exact lab replay: the saved result stands, nothing new written
  if (outcome !== "saved") {
    if (lab) throw new LabWorkIntentError("visit_signed", "الزيارة موقَّعة — لا تُعدَّل إجراءاتها.", 409);
    throw refuse("visit_signed", 409, "الزيارة موقَّعة — لا تُعدَّل إجراءاتها.");
  }
  for (const override of overrides) {
    await insertAuditRow(client, {
      action: "visit.price_override", entity: "visit", entityId: visitId, entityLabel: override.serviceName,
      details: {
        الخدمة: override.serviceName, العملة: override.currency,
        النوع: override.kind === "discount" ? "خصم" : override.kind === "increase" ? "رفع فوق الدليل" : "سعر يدوي لخدمة غير مسعّرة",
        سعر_الدليل: override.catalogMinor, السعر_المعتمد: override.requestedMinor, نسبة_الخصم: override.discountPercent, السبب: override.reason,
      },
      actor: identity.username, actorRole: identity.role,
    });
  }
}

export function canonicalVisitDocumentFailure(error: unknown): NextResponse {
  if (error instanceof CanonicalVisitDocumentRefusal) {
    return NextResponse.json({ code: error.code, message: error.message, ...error.extra }, { status: error.status, headers: NO_STORE });
  }
  if (error instanceof InventoryBusy || error instanceof InventoryTrackingRequired) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: 409, headers: NO_STORE });
  }
  if (error instanceof InventoryShortage) return NextResponse.json({ code: "inventory_shortage", message: error.message }, { status: 409, headers: NO_STORE });
  if (error instanceof ProcedurePriceRejected) return NextResponse.json({ code: "price_authority", message: error.message }, { status: 409, headers: NO_STORE });
  if (error instanceof ClinicalPlanConflict || error instanceof ClinicalDoctorIdentityConflict) {
    return NextResponse.json({ code: error instanceof ClinicalDoctorIdentityConflict ? error.code : "clinical_plan_conflict", message: error.message }, { status: 409, headers: NO_STORE });
  }
  if (error instanceof LabWorkContractError) return NextResponse.json({ code: error.code, message: error.message }, { status: 400, headers: NO_STORE });
  if (error instanceof LabWorkIntentError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  if ((error as { code?: string }).code === "55P03") return NextResponse.json({ code: "busy", message: "يوجد تحديث سريري جارٍ؛ حدّث الزيارة وأعد المحاولة." }, { status: 409, headers: NO_STORE });
  return canonicalPatientReadFailure(error, "تعذّر حفظ الزيارة.");
}
