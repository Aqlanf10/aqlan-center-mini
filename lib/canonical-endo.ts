import "server-only";
import { NextResponse } from "next/server";
import { getPool, patientInDoctorScopeWith, type DbClient } from "./db";
import {
  ENDO_ADDENDUM_MESSAGE, ENDO_CROWN_MESSAGE, ENDO_STATUS_MESSAGE, OPEN_ENDO_MESSAGE, SAVE_ENDO_VISIT_MESSAGE,
  addEndoAddendumOn, changeEndoStatusOn, listPatientEndoWith, openEndoTreatmentOn, saveEndoVisitOn, setEndoCrownOn,
  type EndoTreatmentView, type SaveEndoVisitRefusal,
} from "./endodontics-db";
import { checkEndoAddendum, checkEndoStatusChange, checkEndoTreatmentDraft, checkEndoVisitDraft } from "./endodontics";
import { visibleEndoTreatment } from "./endodontics-response";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities, staffOperationClinician, staffOperationIdentity, staffOperationIsProtectedOwner,
  staffOperationPatientScope, withStaffOperation,
} from "./staff-operation-runtime";

/**
 * Canonical endodontics (M2 slice 77, group 3): GET/POST /api/patients/[id]/endo and the
 * episode's status, crown decision, visit record and addenda.
 *
 * - Read: `read:patients.clinical` (a clinical grant) inside the patient scope; plan items
 *   and plan progress only with `clinical.plans.view` (the legacy `canViewPlans`
 *   projection, `visibleEndoTreatment`). No money.
 * - Writes: one admitted `clinical.visits.document` transaction inside the patient scope,
 *   by the actor's validated clinician link or the protected owner (the legacy doctor/admin
 *   labels, never wider). The legacy bodies run unchanged on that transaction (`…On`):
 *   their row locks, version checks, same-content replays and audit rows; a refusal rolls
 *   the whole transaction back.
 * - Crown: linking plan items additionally needs `clinical.plans.edit` (legacy
 *   `canEditPlans`), refused before the body.
 * - Addenda (signed visits only): additionally `clinical.visits.sign` (the map), with the
 *   legacy request key (`endo_addenda.request_key`).
 * - Outside the scope reads and writes like missing (404). The scope check takes no row
 *   lock, so each body keeps its own lock order.
 */
export class CanonicalEndoRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "CanonicalEndoRefusal";
  }
}
const invalid = (message: string) => new CanonicalEndoRefusal("invalid_endo_request", 400, message);
const patientMissing = () => new CanonicalEndoRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");

function positiveId(raw: string, message = "رقم غير صالح."): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw invalid(message);
  return Number(raw);
}
const optionalId = (raw: unknown): { ok: true; value: number | null } | { ok: false } => {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const id = typeof raw === "string" ? Number(raw) : raw;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? { ok: true, value: id } : { ok: false };
};

export async function readCanonicalEndo(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.clinical", patientId, async (query, scope) => ({
    treatments: (await listPatientEndoWith(query, patientId)).map(view => visibleEndoTreatment(view, scope.granted("clinical.plans.view"))),
  }));
}

type Held = ReadonlySet<"clinical.plans.view" | "clinical.plans.edit" | "clinical.visits.sign">;
interface EndoContext {
  client: DbClient;
  actor: { actor: string; actorRole: string };
  clinicianPartyId: number | null;
  held: Held;
}
type BodyResult = { ok: true; treatment: EndoTreatmentView; created?: boolean } | { ok: false; refusal: CanonicalEndoRefusal };

/** One admitted endo write: clinician link or owner, extra grants, scope (no row lock), the body. */
async function endoWrite(
  session: VerifiedDurableSession, patientId: number, pool: ReturnType<typeof getPool>,
  options: { needSign?: boolean; validate?: () => void; preflight?: (held: Held) => void },
  body: (ctx: EndoContext) => Promise<BodyResult>,
): Promise<{ treatment: EndoTreatmentView; status: 200 | 201 }> {
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "clinical.visits.document");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const clinicianPartyId = await staffOperationClinician(client, handle, "clinical.visits.document");
    if (clinicianPartyId === null && !await staffOperationIsProtectedOwner(client, handle, "clinical.visits.document")) {
      throw new CanonicalEndoRefusal("endo_clinician_required", 403, "علاج الجذور يكتبه الطبيب المرتبط بجهة طبيب أو المالك.");
    }
    const held = await staffOperationCapabilities(client, handle, "clinical.visits.document", ["clinical.plans.view", "clinical.plans.edit", "clinical.visits.sign"] as const);
    if (options.needSign && !held.has("clinical.visits.sign")) {
      throw new CanonicalEndoRefusal("endo_sign_required", 403, "الملحق على زيارة موقَّعة يتطلب صلاحية توقيع الزيارات.");
    }
    // The body is validated only after the role-level checks, as the legacy routes did:
    // a refused actor never sees validation messages.
    options.validate?.();
    options.preflight?.(held);
    if (scope.kind !== "all" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId)) throw patientMissing();
    const result = await body({ client, actor: { actor: identity.username, actorRole: identity.role }, clinicianPartyId, held });
    // A refusal throws, so the admitted transaction rolls back whatever the body did.
    if (!result.ok) throw result.refusal;
    return { treatment: visibleEndoTreatment(result.treatment, held.has("clinical.plans.view")), status: result.created ? 201 : 200 };
  });
}

export async function commandCanonicalEndoOpen(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId, "رقم مريض غير صالح.");
  let draft: Extract<ReturnType<typeof checkEndoTreatmentDraft>, { ok: true }>["value"];
  const validate = () => { const checked = checkEndoTreatmentDraft(body); if (!checked.ok) throw invalid(checked.message); draft = checked.value; };
  const result = await endoWrite(session, patientId, pool, { validate }, async ({ client, actor }) => {
    const opened = await openEndoTreatmentOn(client, { patientId, ...draft, ...actor });
    if (opened.ok) return { ok: true, treatment: opened.treatment, created: true };
    const status = opened.reason === "no_patient" ? 404 : opened.reason === "bad_tooth" || opened.reason === "bad_case" ? 400 : 409;
    return { ok: false, refusal: new CanonicalEndoRefusal(`endo_${opened.reason}`, status, OPEN_ENDO_MESSAGE[opened.reason]) };
  });
  return { ...result, status: 201 as const };
}

export async function commandCanonicalEndoStatus(session: VerifiedDurableSession, rawPatientId: string, rawTreatmentId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  const treatmentId = positiveId(rawTreatmentId);
  let change: Extract<ReturnType<typeof checkEndoStatusChange>, { ok: true }>["value"];
  const validate = () => { const checked = checkEndoStatusChange(body); if (!checked.ok) throw invalid(checked.message); change = checked.value; };
  const result = await endoWrite(session, patientId, pool, { validate }, async ({ client, actor }) => {
    const moved = await changeEndoStatusOn(client, {
      patientId, treatmentId, status: change.status as "completed" | "abandoned", outcome: change.outcome, ...actor,
    });
    if (moved.ok) return { ok: true, treatment: moved.treatment };
    if (moved.reason === "not_ready") return { ok: false, refusal: new CanonicalEndoRefusal("endo_not_ready", 409, moved.message ?? "علاج الجذور غير جاهز للإكمال.") };
    return { ok: false, refusal: new CanonicalEndoRefusal(`endo_${moved.reason}`, moved.reason === "not_found" ? 404 : 409, ENDO_STATUS_MESSAGE[moved.reason]) };
  });
  return { ...result, status: 200 as const };
}

export async function commandCanonicalEndoCrown(session: VerifiedDurableSession, rawPatientId: string, rawTreatmentId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  const treatmentId = positiveId(rawTreatmentId);
  const crownItem = optionalId(body.crownPlanItemId);
  const rctItem = optionalId(body.rctPlanItemId);
  const crownRequired = body.crownRequired === true;
  const linksPlan = crownItem.ok && rctItem.ok && (crownItem.value !== null || rctItem.value !== null);
  const result = await endoWrite(session, patientId, pool, {
    validate: () => {
      if (typeof body.crownRequired !== "boolean") throw invalid("حدّد هل التاج لازم أم لا.");
      if (!crownItem.ok || !rctItem.ok) throw invalid("بند الخطة غير صالح.");
    },
    // Linking a plan item touches the plan: the plan-edit grant, never a back door around it.
    preflight: held => {
      if (linksPlan && !held.has("clinical.plans.edit")) throw new CanonicalEndoRefusal("endo_plan_edit_required", 403, "تعديل خطط العلاج غير مفعّل لحسابك.");
    },
  }, async ({ client, actor, held }) => {
    const decided = await setEndoCrownOn(client, {
      patientId, treatmentId, crownRequired, crownPlanItemId: crownItem.ok ? crownItem.value : null, rctPlanItemId: rctItem.ok ? rctItem.value : null,
      canEditPlanLinks: held.has("clinical.plans.edit"), ...actor,
    });
    if (decided.ok) return { ok: true, treatment: decided.treatment };
    const status = decided.reason === "not_found" ? 404 : decided.reason === "plan_forbidden" ? 403 : ["bad_item", "bad_rct"].includes(decided.reason) ? 400 : 409;
    return { ok: false, refusal: new CanonicalEndoRefusal(`endo_${decided.reason}`, status, ENDO_CROWN_MESSAGE[decided.reason]) };
  });
  return { ...result, status: 200 as const };
}

const VISIT_STATUS: Record<SaveEndoVisitRefusal, 400 | 404 | 409> = {
  not_found: 404, visit_not_found: 404, wrong_patient: 400, closed: 409, visit_signed: 409,
  no_treating_doctor: 409, ambiguous_doctor: 409, exists: 409, version_conflict: 409,
};

export async function commandCanonicalEndoVisit(session: VerifiedDurableSession, rawPatientId: string, rawTreatmentId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  const treatmentId = positiveId(rawTreatmentId);
  let visitId = 0;
  let expectedVersion: number | null = null;
  let draft: Extract<ReturnType<typeof checkEndoVisitDraft>, { ok: true }>["value"];
  const validate = () => {
    const visitRaw = String(body.visitId ?? "");
    if (!/^[1-9][0-9]{0,9}$/.test(visitRaw) || Number(visitRaw) > 2147483647) throw invalid("اختر الزيارة التي يُسجَّل عليها علاج الجذور.");
    visitId = Number(visitRaw);
    if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
      const version = Number(body.expectedVersion);
      if (!Number.isInteger(version) || version < 1) throw invalid("رقم إصدار السجل غير صالح.");
      expectedVersion = version;
    }
    const checked = checkEndoVisitDraft(body);
    if (!checked.ok) throw invalid(checked.message);
    draft = checked.value;
  };
  return endoWrite(session, patientId, pool, { validate }, async ({ client, actor, clinicianPartyId }) => {
    const saved = await saveEndoVisitOn(client, {
      patientId, treatmentId, visitId, draft, expectedVersion, actorPartyId: clinicianPartyId, ...actor,
    });
    if (saved.ok) return { ok: true, treatment: saved.treatment, created: saved.created };
    return { ok: false, refusal: new CanonicalEndoRefusal(`endo_${saved.reason}`, VISIT_STATUS[saved.reason], SAVE_ENDO_VISIT_MESSAGE[saved.reason]) };
  });
}

export async function commandCanonicalEndoAddendum(session: VerifiedDurableSession, rawPatientId: string, rawTreatmentId: string, rawEndoVisitId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  const treatmentId = positiveId(rawTreatmentId);
  const endoVisitId = positiveId(rawEndoVisitId);
  let text = "";
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  const validate = () => {
    const checked = checkEndoAddendum(body);
    if (!checked.ok) throw invalid(checked.message);
    text = checked.value;
    if (!IDEMPOTENCY_KEY_PATTERN.test(requestKey)) throw invalid("مفتاح إعادة محاولة الملحق غير صالح.");
  };
  return endoWrite(session, patientId, pool, { needSign: true, validate }, async ({ client, actor }) => {
    const added = await addEndoAddendumOn(client, { patientId, treatmentId, endoVisitId, text, requestKey, ...actor });
    if (added.ok) return { ok: true, treatment: added.treatment, created: added.created };
    const status = added.reason === "not_found" ? 404 : ["bad_key", "bad_text"].includes(added.reason) ? 400 : 409;
    return { ok: false, refusal: new CanonicalEndoRefusal(`endo_${added.reason}`, status, ENDO_ADDENDUM_MESSAGE[added.reason]) };
  });
}

/** The canonical branch of an endo write (null for a legacy envelope). */
export async function canonicalEndoRoute(
  request: Request,
  run: (handle: VerifiedDurableSession, body: Record<string, unknown>) => Promise<{ treatment: EndoTreatmentView; status: 200 | 201 }>,
  fallback: string,
): Promise<NextResponse | null> {
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
    const result = await run(selected.handle, body);
    return NextResponse.json(result.treatment, { status: result.status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalEndoRefusal) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
    }
    return canonicalPatientReadFailure(error, fallback);
  }
}
