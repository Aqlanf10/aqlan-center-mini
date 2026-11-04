import "server-only";
import { NextResponse } from "next/server";
import {
  addVisitAddendumOn, getClinicalVisitWith, getPool, getSettingsWith, insertAuditRow, patientInDoctorScopeWith, saveClinicalNotes,
  setVisitProceduresOn, signClinicalVisitLockedOn, ClinicalPlanConflict, ProcedurePriceRejected, InventoryShortage, CLINIC_TIME_ZONE,
  type DbClient, type ProcedurePriceOverride,
} from "./db";
import { InventoryBusy, InventoryTrackingRequired } from "./inventory-domain/legacy-write-guard";
import { checkOrthoSessionDraft } from "./ortho-baseline";
import { CLINICAL_SIGN_MESSAGES } from "./clinical-sign-messages";
import { ClinicalDoctorIdentityConflict } from "./clinical-doctor-identity";
import { LabWorkIntentError } from "./lab-work-intent-db";
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
 *   group 4); a lab draft inside the save (the lab identity layer still re-authorizes a
 *   legacy session).
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
 * `finance.invoices.view` or to the owner. A visit carrying a durable lab identity
 * refuses (409) until the lab identity layer accepts a canonical actor.
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
  serviceId: number; toothCode: number | null; surfaces: string | null; quantity: number;
  unitPriceMinor: number | null; priceReason: string | null; doctorId: number | null; note: string | null; planItemId: number | null;
};
/** Legacy parsing (rows without a service are dropped), except that a missing price stays
 * missing: the server price, never a zero request. */
export function parseCanonicalProcedures(raw: unknown): ProcedureRow[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) throw refuse("invalid_procedures", 400, "قائمة الإجراءات غير صالحة.");
  return raw.map(row => (row ?? {}) as Record<string, unknown>).filter(row => Number(row.serviceId) > 0).map(row => ({
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

export async function commandCanonicalVisitDocument(session: VerifiedDurableSession, rawVisitId: string, rawBody: unknown, pool = getPool()) {
  const visitId = visitIdOf(rawVisitId);
  const body = (rawBody ?? {}) as Record<string, unknown>;
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) throw refuse("invalid_body", 400, "طلب غير صالح.");
  const action = String(body.action ?? "save");
  const signed = await withStaffOperation(pool, session, "clinical.visits.document", async (client, handle): Promise<Record<string, unknown> | undefined> => {
    const scope = await staffOperationPatientScope(client, handle, "clinical.visits.document");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const { rows: [visit] } = await client.query<{ patient_id: number | null; doctor_id: number | null; arrived_at: Date; billing_currency: string | null }>(
      "SELECT patient_id, doctor_id, arrived_at, billing_currency FROM visits WHERE id = $1", [visitId]);
    const inside = visit !== undefined && (scope.kind === "all" || visit.doctor_id === scope.clinicianPartyId
      || (visit.patient_id !== null && await patientInDoctorScopeWith(client, scope.clinicianPartyId, visit.patient_id)));
    if (!inside) throw refuse("visit_not_found", 404, VISIT_MISSING);
    const clinician = await staffOperationClinician(client, handle, "clinical.visits.document");
    const owner = await staffOperationIsProtectedOwner(client, handle, "clinical.visits.document");
    const full = clinician !== null || owner;
    if (!full && clinicDateString(visit!.arrived_at, CLINIC_TIME_ZONE) !== clinicDateString(new Date(), CLINIC_TIME_ZONE)) {
      throw refuse("visit_today_only", 403, "التوثيق دون ارتباطٍ بطبيب يقتصر على زيارات اليوم.");
    }
    if (action === "sign") {
      const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
      return sign(client, handle, visitId, visit!, body, clinician, owner, identity);
    }
    if (action !== "save" && action !== "addendum") throw refuse("invalid_action", 400, "إجراء غير معروف على الزيارة.");
    if (hasLabCommand(body)) throw refuse("lab_draft_not_canonical", 409, "حفظ مسوّدة المختبر من الزيارة على الحساب الموحّد لم يُفعَّل بعد؛ احفظ التوثيق دونها، أو أنشئ الطلب من شاشة المختبر.");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    if (action === "addendum") { await addendum(client, visitId, body, identity); return undefined; }
    await save(client, handle, visitId, visit!, body, full, identity);
    return undefined;
  });
  const read = await readCanonicalVisitClinical(session, visitId);
  return signed ? { ...read, signResult: signed } : read;
}

const NO_CHARGE_REFUSED = "قرار «بلا رسوم» لشدّة خارج الاتفاق للمالك، ولطبيب حالة التقويم المسؤول عنها بصلاحية تعديل التقويم إذا فعّل المالك ذلك في الإعدادات.";

async function sign(
  client: DbClient, handle: Parameters<typeof staffOperationCapabilities>[1], visitId: number,
  visit: { patient_id: number | null }, body: Record<string, unknown>, clinician: number | null, owner: boolean,
  identity: { userId: number; username: string; role: string },
): Promise<Record<string, unknown>> {
  const held = await staffOperationCapabilities(client, handle, "clinical.visits.document",
    ["clinical.visits.sign", "clinical.ortho.edit", "finance.invoices.view"] as const);
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
  let outcome: Awaited<ReturnType<typeof signClinicalVisitLockedOn>>;
  try {
    outcome = await signClinicalVisitLockedOn(client, {
      visitId, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: identity.username,
      // The legacy finisher rule: an account without a clinician link is never the default treating doctor.
      signerDoctorPartyId: clinician,
      dependencyOverrideReason: typeof body.dependencyOverrideReason === "string" ? body.dependencyOverrideReason : null,
      orthoSession: orthoSession.value, outsideContractDecision: decision,
      signerRole: identity.role,
      labSignVersion: typeof body.labSignVersion === "string" ? body.labSignVersion : null,
      authorizeNoCharge: async caseId => {
        if (owner) return;
        const { rows: [kase] } = caseId === null ? { rows: [] as { responsible_doctor_id: number | null }[] }
          : await client.query<{ responsible_doctor_id: number | null }>("SELECT responsible_doctor_id FROM ortho_cases WHERE id = $1 AND patient_id = $2 FOR SHARE", [caseId, visit.patient_id]);
        if (!kase || kase.responsible_doctor_id === null || kase.responsible_doctor_id !== clinician) throw refuse("no_charge_not_case_doctor", 403, NO_CHARGE_REFUSED);
      },
    }, existing);
  } catch (error) {
    if (error instanceof LabWorkIntentError && error.code === "unauthorized") {
      throw refuse("lab_sign_not_canonical", 409, "تحمل هذه الزيارة عمل مختبر بهوية محفوظة؛ توقيعها من الحساب الموحّد لم يُفعَّل بعد. لم يُوقَّع شيء.");
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

async function addendum(client: DbClient, visitId: number, body: Record<string, unknown>, identity: { userId: number; username: string; role: string }) {
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

async function save(
  client: DbClient, handle: Parameters<typeof staffOperationCapabilities>[1], visitId: number,
  visit: { doctor_id: number | null; billing_currency: string | null }, body: Record<string, unknown>, full: boolean,
  identity: { username: string; role: string },
) {
  const notes = {
    chiefComplaint: text(body.chiefComplaint, 500), examination: text(body.examination), diagnosis: text(body.diagnosis),
    treatmentDone: text(body.treatmentDone), nextPlan: text(body.nextPlan, 500), doctorId: Number(body.doctorId) || null,
  };
  const procedures = parseCanonicalProcedures(body.procedures);
  if (body.billingCurrency !== undefined && body.billingCurrency !== null) {
    const stored = isCurrency(visit.billing_currency) ? visit.billing_currency : CLINIC_BASE_CURRENCY;
    if (!isCurrency(body.billingCurrency)) throw refuse("invalid_currency", 400, "عملة الزيارة غير صالحة.");
    if (body.billingCurrency !== stored) throw refuse("billing_currency_financial", 409, "تغيير عملة الزيارة قرارٌ مالي لم يُنقل بعد إلى الحساب الموحّد؛ احفظ دون تغييرها.");
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
    authority: {
      grants: { discount: held.has("finance.discounts.apply"), discountOverride: held.has("finance.discounts.override"), increase: held.has("finance.price-increases.apply") },
      maxDiscountPercent: Number.isFinite(maxDiscount) ? maxDiscount : 0,
    },
  });
  if (outcome !== "saved") throw refuse("visit_signed", 409, "الزيارة موقَّعة — لا تُعدَّل إجراءاتها.");
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
  if (error instanceof LabWorkIntentError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  if ((error as { code?: string }).code === "55P03") return NextResponse.json({ code: "busy", message: "يوجد تحديث سريري جارٍ؛ حدّث الزيارة وأعد المحاولة." }, { status: 409, headers: NO_STORE });
  return canonicalPatientReadFailure(error, "تعذّر حفظ الزيارة.");
}
