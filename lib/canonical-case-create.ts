import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createClinicalCaseOn, getPool, patientInDoctorScopeWith } from "./db";
import { checkCaseDraft } from "./cases";
import { stableJson } from "./canonical-lab-create";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities, staffOperationClinician, staffOperationIdentity, staffOperationIsProtectedOwner,
  staffOperationPatientScope, withStaffOperation,
} from "./staff-operation-runtime";

/**
 * Canonical case opening (M2 slice 80): POST /api/patients/[id]/cases.
 *
 * - One admitted `clinical.plans.edit` transaction (the map's capability) inside the
 *   patient scope, by the actor's clinician link or the protected owner (the legacy
 *   doctor/admin labels, never wider). An orthodontic case or an ortho bridge also needs
 *   `clinical.ortho.view` (the independent ortho projection, as slice 43).
 * - Initial responsibility: the owner may name any active doctor; a clinician may name
 *   only themself — the legacy rule, never a grant of another doctor's patient.
 * - The legacy body (`createClinicalCaseOn`): patient FOR NO KEY UPDATE, the ortho bridge
 *   checks (same patient, once), the insert and the case.create audit row together.
 * - `requestKey` is required: under a transaction advisory lock on (actor, key) the
 *   receipt (the audit row) is looked up first; the same request returns the first case
 *   (`replayed`), another request with the key is refused (409). A retry after a lost
 *   response never opens a second case.
 */
export class CanonicalCaseCreateRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "CanonicalCaseCreateRefusal";
  }
}
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const RECEIPT_WINDOW = "1 day";
const invalid = (message: string) => new CanonicalCaseCreateRefusal("invalid_case_create", 400, message);
const missing = () => new CanonicalCaseCreateRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");

export async function commandCanonicalCaseCreate(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  if (!/^[1-9][0-9]{0,9}$/.test(rawPatientId) || Number(rawPatientId) > 2147483647) throw invalid("رقم مريض غير صالح.");
  const patientId = Number(rawPatientId);
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!KEY_PATTERN.test(requestKey)) throw invalid("مفتاح الطلب مفقود أو غير صالح؛ أعد فتح النموذج.");
  const draft = checkCaseDraft(body);
  if (!draft.ok) throw invalid(draft.message);
  const fingerprint = createHash("sha256").update(stableJson({ patientId, ...draft.value })).digest("hex");
  const action = "clinical.plans.edit" as const;
  return withStaffOperation(pool, session, action, async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, action);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const clinician = await staffOperationClinician(client, handle, action);
    const owner = await staffOperationIsProtectedOwner(client, handle, action);
    if (clinician === null && !owner) throw new CanonicalCaseCreateRefusal("case_create_clinician_required", 403, "فتح الحالات للطبيب المرتبط بجهة طبيب أو للمالك.");
    const held = await staffOperationCapabilities(client, handle, action, ["clinical.ortho.view"] as const);
    if ((draft.value.specialty === "orthodontics" || draft.value.orthoCaseId !== null) && !held.has("clinical.ortho.view")) {
      throw new CanonicalCaseCreateRefusal("case_create_ortho_denied", 403, "حالة التقويم تحتاج صلاحية عرض التقويم المستقلة.");
    }
    const identity = await staffOperationIdentity(client, handle, action);
    const inside = async () => scope.kind === "all" || patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('case-create:' || $1::text || ':' || $2::text))", [identity.userId, requestKey]);
    const { rows: [receipt] } = await client.query<{ caseId: string | null; fingerprint: string | null }>(
      `SELECT details->>'الحالة' AS "caseId", details->>'requestFingerprint' AS fingerprint FROM audit_log
        WHERE action = 'case.create' AND created_at > NOW() - $3::interval
          AND details->>'requestKey' = $1 AND details->>'requestActorId' = $2::text
        ORDER BY id DESC LIMIT 1`,
      [requestKey, String(identity.userId), RECEIPT_WINDOW]);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CanonicalCaseCreateRefusal("case_request_key_reused", 409, "مفتاح الطلب استُعمل لطلب مختلف؛ أعد فتح النموذج وأرسل من جديد.");
      if (!await inside()) throw missing();
      return { ok: true as const, caseId: Number(receipt.caseId), replayed: true };
    }
    if (!await inside()) throw missing();
    const result = await createClinicalCaseOn(client, { ...draft.value, patientId, actor: identity.username, actorRole: identity.role },
      async partyId => owner || partyId === clinician ? { actor: identity.username, actorRole: identity.role } : null,
      { requestKey, requestFingerprint: fingerprint, requestActorId: String(identity.userId) });
    if (!result.ok) {
      const refusals = {
        no_patient: ["patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك."],
        bad_responsible: ["case_create_bad_responsible", 400, "الطبيب المسؤول يجب أن يكون طبيبًا مسجّلًا، ولا يُسند الطبيب حالةً إلا لنفسه."],
        bad_ortho: ["case_create_bad_ortho", 400, "حالة التقويم لا تخص هذا المريض."],
        already_bridged: ["case_create_already_bridged", 409, "حالة التقويم هذه مربوطة من قبل."],
      } as const;
      const [code, status, message] = refusals[result.reason];
      throw new CanonicalCaseCreateRefusal(code, status, message);
    }
    return { ok: true as const, caseId: result.caseId, replayed: false };
  });
}

/** The canonical branch of the case POST (null for a legacy envelope). */
export async function canonicalCaseCreateRoute(request: Request, rawPatientId: string): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await commandCanonicalCaseCreate(selected.handle, rawPatientId, body);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalCaseCreateRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
    return canonicalPatientReadFailure(error, "تعذّر حفظ الحالة. أعد المحاولة.");
  }
}
