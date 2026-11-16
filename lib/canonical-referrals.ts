import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE, closeReferralOn, createInternalReferralOn, createReferralOn, getPool, getReferralWith, listMyReferralsWith,
  myClinicalTodayWith, patientInDoctorScopeWith, transitionInternalReferralOnClient, type DbClient,
} from "./db";
import { checkInternalReferralDraft, checkReferralClose, checkReferralDraft, checkReferralTransition, type ReferralAction } from "./referrals";
import { clinicDateString } from "./schedule";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import type { StaffRecordConstraint } from "./staff-capabilities";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationAppointmentScope, staffOperationClinician, staffOperationIdentity, staffOperationIsProtectedOwner,
  staffOperationPatientScope, withStaffOperation, type StaffOperationHandle,
} from "./staff-operation-runtime";
import { stableJson } from "./canonical-lab-create";

/**
 * Canonical referrals (M2 slice 73, group 3): POST /api/patients/[id]/referrals,
 * PATCH /api/referrals/[id], POST /api/referrals/[id]/transition and
 * GET /api/referrals/mine. One admitted `clinical.referrals.manage` operation each (the
 * map's capability), inside the actor's patient scope; outside the scope answers like a
 * missing referral or patient.
 *
 * Role labels translated (legacy → canonical), never widened:
 * - Issue a letter (external or internal): the legacy route required a clinician
 *   identity (a doctor, or an admin linked to a doctor party; reception refused). The
 *   canonical issuer is the actor's validated clinician link; without one, refused.
 * - Close an external referral: legacy allowed any role with access to the patient; the
 *   canonical path needs `clinical.referrals.manage` (narrower).
 * - Internal workflow (`canActOnReferral`): accept, decline and complete by the receiving
 *   clinician; cancel and acknowledge by the referring clinician; schedule by the
 *   receiving clinician or an actor with the WHOLE appointment scope (the legacy
 *   «reception» rule, as the accepted slice-23 rebooking translates it). The legacy
 *   «admin may do every step» is the protected owner only; another account never gets it
 *   from a role label.
 * - Mine: the actor's clinician link; patients inside the patient scope; today's
 *   appointments only with an appointment scope. No link → empty lists (as legacy).
 * Writes run the legacy bodies on the admitted transaction: the internal create and the
 * workflow step unchanged; the external create and close with their audit row now in the
 * SAME transaction (the legacy writers record it after). Create is idempotent by a
 * required `requestKey` (advisory lock + receipt in the create audit row). No money.
 */
export class CanonicalReferralRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "CanonicalReferralRefusal";
  }
}
export const REFERRAL_RECEIPT_WINDOW = "1 day";
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const invalid = (message: string, field?: string) => new CanonicalReferralRefusal("invalid_referral", 400, message, field);
const referralMissing = () => new CanonicalReferralRefusal("referral_not_found", 404, "لا توجد إحالة بهذا الرقم ضمن مرضاك.");
const patientMissing = () => new CanonicalReferralRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");

function positiveId(raw: unknown, message: string): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw invalid(message);
  return value;
}
async function inScope(client: Pick<DbClient, "query">, scope: StaffRecordConstraint, patientId: number): Promise<boolean> {
  if (scope.kind === "all") return true;
  if (scope.kind === "none") return false;
  return patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
}
async function admit(client: DbClient, handle: StaffOperationHandle) {
  const scope = await staffOperationPatientScope(client, handle, "clinical.referrals.manage");
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const identity = await staffOperationIdentity(client, handle, "clinical.referrals.manage");
  return { scope, identity, actor: { actor: identity.username, actorRole: identity.role } };
}

/* ---------------------------------------------------------------- issue */

export function parseCanonicalReferralCreate(body: Record<string, unknown>) {
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!KEY_PATTERN.test(requestKey)) throw invalid("مفتاح الطلب مفقود أو غير صالح؛ أعد فتح النموذج.", "requestKey");
  const { requestKey: _key, ...rest } = body;
  void _key;
  if (rest.kind === "internal") {
    const draft = checkInternalReferralDraft(rest);
    if (!draft.ok) throw invalid(draft.message);
    return { requestKey, kind: "internal" as const, draft: draft.value, fingerprint: createHash("sha256").update(stableJson({ kind: "internal", ...draft.value })).digest("hex") };
  }
  const draft = checkReferralDraft(rest);
  if (!draft.ok) throw invalid(draft.message);
  return { requestKey, kind: "external" as const, draft: draft.value, fingerprint: createHash("sha256").update(stableJson({ kind: "external", ...draft.value })).digest("hex") };
}

const INTERNAL_FAILURES = {
  no_patient: () => patientMissing(),
  bad_receiver: () => invalid("الطبيب المحال إليه غير موجود أو غير نشط.", "toPartyId"),
  self: () => invalid("لا تُحال الحالة إلى المحيل نفسه.", "toPartyId"),
  bad_link: () => invalid("الحالة أو بند الخطة المختار لا يخص هذا المريض."),
} as const;

export async function commandCanonicalReferralCreate(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId, "رقم مريض غير صالح.");
  const request = parseCanonicalReferralCreate(body);
  return withStaffOperation(pool, session, "clinical.referrals.manage", async (client, handle) => {
    const { scope, identity, actor } = await admit(client, handle);
    const clinician = await staffOperationClinician(client, handle, "clinical.referrals.manage");
    if (clinician === null) {
      throw new CanonicalReferralRefusal("referral_issuer_required", 403, "خطاب الإحالة يصدره طبيبٌ مرتبط بجهة طبيب — الحساب غير مرتبط بطبيب.");
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-create:' || $1::text || ':' || $2::text))", [identity.userId, request.requestKey]);
    const { rows: [receipt] } = await client.query<{ referral: string | null; fingerprint: string | null }>(
      `SELECT details->>'الإحالة' AS referral, details->>'requestFingerprint' AS fingerprint FROM audit_log
        WHERE action = 'referral.create' AND created_at > NOW() - $3::interval
          AND details->>'requestKey' = $1 AND details->>'requestActorId' = $2::text
        ORDER BY id DESC LIMIT 1`,
      [request.requestKey, identity.userId, REFERRAL_RECEIPT_WINDOW]);
    if (receipt) {
      if (receipt.fingerprint !== request.fingerprint) {
        throw new CanonicalReferralRefusal("referral_request_key_reused", 409, "مفتاح الطلب استُعمل لطلب مختلف؛ أعد فتح النموذج وأرسل من جديد.");
      }
      const existing = receipt.referral ? await getReferralWith(client, Number(receipt.referral)) : null;
      if (!existing || !await inScope(client, scope, existing.patientId)) throw referralMissing();
      return { ...existing, replayed: true as const };
    }
    if (!await inScope(client, scope, patientId)) throw patientMissing();
    const stamp = { requestKey: request.requestKey, requestFingerprint: request.fingerprint, requestActorId: String(identity.userId) };
    if (request.kind === "internal") {
      const result = await createInternalReferralOn(client, { ...request.draft, patientId, doctorPartyId: clinician, ...actor }, stamp);
      if (!result.ok) throw INTERNAL_FAILURES[result.reason]();
      return { ...(await getReferralWith(client, result.id))!, replayed: false as const };
    }
    const referral = await createReferralOn(client, { ...request.draft, patientId, doctorPartyId: clinician, ...actor }, stamp);
    if (!referral) throw patientMissing();
    return { ...referral, replayed: false as const };
  });
}

/* ---------------------------------------------------------------- close (external) */

/** Lock the referral row and require its patient inside the scope (missing otherwise). */
async function lockReferralInScope(client: DbClient, scope: StaffRecordConstraint, id: number) {
  const { rows: [row] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM patient_referrals WHERE id = $1 FOR UPDATE", [id]);
  if (!row || !await inScope(client, scope, row.patient_id)) throw referralMissing();
}

export async function commandCanonicalReferralClose(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = positiveId(rawId, "رقم إحالة غير صالح.");
  const close = checkReferralClose(body);
  if (!close.ok) throw invalid(close.message);
  return withStaffOperation(pool, session, "clinical.referrals.manage", async (client, handle) => {
    const { scope, actor } = await admit(client, handle);
    await lockReferralInScope(client, scope, id);
    const result = await closeReferralOn(client, { id, status: close.value.status, note: close.value.note, ...actor });
    if (!result.ok) {
      if (result.reason === "not_found") throw referralMissing();
      if (result.reason === "internal") throw new CanonicalReferralRefusal("referral_internal", 409, "الإحالة الداخلية تُدار بخطواتها (قبول، حجز، إكمال) لا بالإغلاق المباشر.");
      throw new CanonicalReferralRefusal("referral_closed", 409, "هذه الإحالة أُغلقت من قبل.");
    }
    return result.referral;
  });
}

/* ---------------------------------------------------------------- internal workflow */

const WHO: Record<ReferralAction, string> = {
  accept: "الطبيب المحال إليه", decline: "الطبيب المحال إليه", complete: "الطبيب المحال إليه",
  schedule: "الاستقبال أو الطبيب المحال إليه", cancel: "الطبيب المحيل", acknowledge: "الطبيب المحيل",
};

/** The canonical translation of `canActOnReferral` (see the module comment). */
export function canonicalMayActOnReferral(input: {
  action: ReferralAction; isOwner: boolean; clinician: number | null; wholeAppointmentScope: boolean;
  referringPartyId: number | null; receivingPartyId: number | null;
}): boolean {
  if (input.isOwner) return true;
  const isReceiver = input.clinician !== null && input.clinician === input.receivingPartyId;
  const isReferrer = input.clinician !== null && input.clinician === input.referringPartyId;
  switch (input.action) {
    case "accept": case "decline": case "complete": return isReceiver;
    case "schedule": return isReceiver || input.wholeAppointmentScope;
    case "cancel": case "acknowledge": return isReferrer;
  }
}

class TransitionRefused extends Error {
  constructor(readonly refusal: CanonicalReferralRefusal) { super(refusal.message); }
}

export async function commandCanonicalReferralTransition(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = positiveId(rawId, "رقم إحالة غير صالح.");
  const transition = checkReferralTransition(body);
  if (!transition.ok) throw invalid(transition.message);
  const step = transition.value;
  return withStaffOperation(pool, session, "clinical.referrals.manage", async (client, handle) => {
    const { scope, actor } = await admit(client, handle);
    const clinician = await staffOperationClinician(client, handle, "clinical.referrals.manage");
    const isOwner = await staffOperationIsProtectedOwner(client, handle, "clinical.referrals.manage");
    const appointmentScope = await staffOperationAppointmentScope(client, handle, "clinical.referrals.manage");
    // A referral outside the scope (or missing) answers alike before the workflow writer
    // runs, so its kind and state are never disclosed. The writer's own lock order
    // (appointments, then the referral row) is untouched; `authorize` re-checks under it.
    const { rows: [known] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM patient_referrals WHERE id = $1", [id]);
    if (!known || !await inScope(client, scope, known.patient_id)) throw referralMissing();
    let result: Awaited<ReturnType<typeof transitionInternalReferralOnClient>>;
    try {
      result = await transitionInternalReferralOnClient(client, { id, ...step, ...actor }, {
        authorize: async current => {
          if (!await inScope(client, scope, current.patient_id)) throw new TransitionRefused(referralMissing());
          if (!canonicalMayActOnReferral({
            action: step.action, isOwner, clinician, wholeAppointmentScope: appointmentScope.kind === "all",
            referringPartyId: current.doctor_party_id, receivingPartyId: current.to_party_id,
          })) throw new TransitionRefused(new CanonicalReferralRefusal("referral_step_forbidden", 403, `هذه الخطوة يقوم بها ${WHO[step.action]}.`));
        },
      });
    } catch (error) {
      if (error instanceof TransitionRefused) throw error.refusal;
      throw error;
    }
    if (!result.ok) {
      const refusals = {
        not_found: () => referralMissing(),
        external: () => new CanonicalReferralRefusal("referral_external", 409, "هذه إحالة خارجية — تُغلق بنتيجتها من خطابها."),
        invalid_transition: () => new CanonicalReferralRefusal("referral_invalid_transition", 409, "لا تصحّ هذه الخطوة في حالة الإحالة الآن — حدّث الصفحة."),
        bad_appointment: () => invalid("اختر موعدًا محجوزًا قادمًا لهذا المريض مع الطبيب المحال إليه، غير مرتبطٍ بإحالةٍ أخرى.", "appointmentId"),
      } as const;
      throw refusals[result.reason]();
    }
    return (await getReferralWith(client, id))!;
  });
}

/* ---------------------------------------------------------------- mine */

export async function readCanonicalMyReferrals(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(session, "clinical.referrals.manage", async (query, scope) => {
    const clinician = scope.clinicianPartyId;
    // The issue form's directory: active doctors, names only (the receiving clinician of an
    // internal referral), never another doctor itself (the self-referral is refused anyway).
    const receivers = (await query.query<{ id: number; name: string }>(
      "SELECT id, name FROM parties WHERE kind = 'doctor' AND is_active ORDER BY name, id LIMIT 200")).rows
      .filter(row => row.id !== clinician);
    if (clinician === null || scope.patientScope.kind === "none") return { toMe: [], sentOpen: [], returnedToMe: [], today: [], receivers, canIssue: false };
    const lists = await listMyReferralsWith(query, clinician, scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null);
    const today = scope.appointmentScope.kind === "none" ? [] : await myClinicalTodayWith(query, clinician, clinicDateString(new Date(), CLINIC_TIME_ZONE));
    return { ...lists, today, receivers, canIssue: true };
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}

/* ---------------------------------------------------------------- HTTP */

export async function canonicalReferralRoute(
  request: Request | null,
  run: (handle: VerifiedDurableSession, body: Record<string, unknown>) => Promise<unknown>,
  fallback: string,
  status = 200,
): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  let body: Record<string, unknown> = {};
  if (request) {
    try {
      const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    } catch (error) {
      return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
  }
  try {
    return NextResponse.json(await run(selected.handle, body), { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalReferralRefusal) {
      return NextResponse.json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status, headers: NO_STORE });
    }
    return canonicalPatientReadFailure(error, fallback);
  }
}
