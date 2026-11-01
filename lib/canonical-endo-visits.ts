import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { MAX_DURATION, MIN_DURATION } from "./appointment-services";
import { doctorAvailabilitySuggestions } from "./appointment-availability-advisory";
import { PATIENT_CARE_CAPABILITIES } from "./canonical-patient-reads";
import { NO_STORE } from "./canonical-patient-http";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { loadCapacityContextWith, loadProviderBlockWindows, resolveServiceWith } from "./capacity-context";
import { ClinicalDoctorIdentityConflict } from "./clinical-doctor-identity";
import { settleRejectedClinicalLabCommandInTransaction } from "./clinical-lab-command-settlement";
import {
  CLINIC_TIME_ZONE,
  ClinicalPlanConflict,
  InventoryShortage,
  ProcedurePriceRejected,
  addVisitAddendumInTransaction,
  deletePatientCascadeInTransaction,
  doctorOwnsPatient,
  findPatientIdByNumberWith,
  getClinicalVisitWith,
  getPartyWith,
  getSettingsWith,
  getPool,
  insertAuditRow,
  listAppointmentsByDateWith,
  mergeDuplicatePatientInTransaction,
  patientInDoctorScopeWith,
  patientMaterialMovementsWith,
  saveClinicalNotes,
  setVisitProceduresInTransaction,
  signClinicalVisitInTransaction,
  visitMaterialMovementsWith,
  visitPatientOfWith,
  type ClinicalVisit,
  type DbClient,
  type DbPool,
  type PatientMaterialMovementLine,
  type ProcedurePriceOverride,
  type VisitMaterialLine,
} from "./db";
import { readDoctorAvailabilityAdvisoryWith } from "./doctor-availability-advisory";
import {
  checkEndoAddendum,
  checkEndoStatusChange,
  checkEndoTreatmentDraft,
  checkEndoVisitDraft,
} from "./endodontics";
import {
  ENDO_ADDENDUM_MESSAGE,
  ENDO_CROWN_MESSAGE,
  ENDO_STATUS_MESSAGE,
  OPEN_ENDO_MESSAGE,
  SAVE_ENDO_VISIT_MESSAGE,
  addEndoAddendumInTransaction,
  changeEndoStatusInTransaction,
  listPatientEndoWith,
  openEndoTreatmentInTransaction,
  saveEndoVisitInTransaction,
  setEndoCrownInTransaction,
  type EndoTreatmentView,
  type SaveEndoVisitRefusal,
} from "./endodontics-db";
import { visibleEndoTreatment } from "./endodontics-response";
import { withHttpIdempotencyInTx } from "./http-idempotency";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";
import { InventoryBusy, InventoryTrackingRequired } from "./inventory-domain/legacy-write-guard";
import { listVisitMaterialReturnsWith, returnVisitMaterialInTransaction, type VisitMaterialReturnLine } from "./inventory-visit-returns";
import { LabWorkContractError, parseLabWorkDraft, parseLabWorkRetirements } from "./lab-work-intent-contract";
import { LabWorkIntentError, labWorkIntentSupported, readLabWorkCommandInTransaction } from "./lab-work-intent-db";
import { CLINIC_BASE_CURRENCY, isCurrency } from "./money";
import { checkOrthoSessionDraft } from "./ortho-baseline";
import {
  PATIENT_NUMBER_MAXIMUM,
  numberingReason,
  parseNumberingVersion,
  parsePatientNumber,
  type PatientNumberSnapshot,
} from "./patient-numbering";
import { PatientNumberingError } from "./patient-numbering-db";
import { patientNumberingErrorResponse } from "./patient-numbering-response";
import { completeReceptionHandoffInTransaction, isHandoffSignature } from "./reception-handoff-db";
import { clinicDateString, toMinutes } from "./schedule";
import { foreignRatesFromSettings } from "./service-pricing";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationClinician,
  staffOperationIdentity,
  staffOperationOwnerOperations,
  staffOperationPatientScope,
  withStaffOperation,
  type StaffOperationHandle,
  type StaffRuntimeAction,
} from "./staff-operation-runtime";

type VisibleEndoTreatmentView = EndoTreatmentView;

export const ENDO_VISIT_READ_MAX_BYTES = 1024 * 1024;

export class CanonicalEndoVisitRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
    readonly extra?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CanonicalEndoVisitRefusal";
  }
}

export function canonicalEndoVisitFailure(error: unknown, fallback: string, scopeKind: "patient" | "appointment" = "patient"): NextResponse {
  if (error instanceof CanonicalEndoVisitRefusal) {
    return NextResponse.json(
      { code: error.code, message: error.message, ...(error.extra ?? {}) },
      { status: error.status, headers: NO_STORE },
    );
  }
  if (error instanceof PatientNumberingError) {
    const response = patientNumberingErrorResponse(error);
    response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return response;
  }
  if (error instanceof LabWorkContractError) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: 400, headers: NO_STORE });
  }
  if (error instanceof LabWorkIntentError) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  }
  if ((error as { code?: string })?.code === "55P03") {
    return NextResponse.json({ code: "clinical_busy", message: "يوجد تحديث سريري جارٍ؛ حدّث الزيارة وأعد المحاولة." }, { status: 409, headers: NO_STORE });
  }
  if (error instanceof ClinicalDoctorIdentityConflict) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: 409, headers: NO_STORE });
  }
  if (error instanceof ClinicalPlanConflict) {
    return NextResponse.json({ code: "clinical_plan_conflict", message: error.message }, { status: 409, headers: NO_STORE });
  }
  if (error instanceof ProcedurePriceRejected) {
    return NextResponse.json(
      { code: "price_authority", message: error.message },
      { status: error.forbidden ? 403 : 409, headers: NO_STORE },
    );
  }
  if (error instanceof InventoryBusy || error instanceof InventoryTrackingRequired) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: 409, headers: NO_STORE });
  }
  if (error instanceof InventoryShortage) {
    return NextResponse.json({ code: "inventory_shortage", message: error.message }, { status: 409, headers: NO_STORE });
  }
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    const message = /RECORD_SCOPE_DENIED$/.test(refusal.code)
      ? (scopeKind === "appointment" ? "لا تملك صلاحية عرض مواعيد الأطباء." : "لا تملك صلاحية عرض ملفات المرضى.")
      : refusal.message;
    return NextResponse.json({ code: refusal.code, message }, { status: refusal.status, headers: NO_STORE });
  }
  return NextResponse.json({ message: fallback }, { status: 500, headers: NO_STORE });
}

const positiveInt = (raw: unknown): number | null => {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

const optionalPositiveInt = (raw: unknown): { ok: true; value: number | null } | { ok: false } => {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const id = positiveInt(raw);
  return id !== null ? { ok: true, value: id } : { ok: false };
};

const PATIENT_NOT_FOUND_MESSAGE = "لا يوجد مريض بهذا الرقم.";
const VISIT_NOT_FOUND_MESSAGE = "الزيارة غير موجودة.";

async function assertPatientInSnapshotScope(
  q: Pick<DbClient, "query">,
  patientScope: { readonly kind: "all" } | { readonly kind: "own"; readonly clinicianPartyId: number } | { readonly kind: "none" },
  patientId: number,
): Promise<void> {
  if (patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows } = await q.query("SELECT 1 FROM patients WHERE id = $1", [patientId]);
  const inside = rows.length === 1 && (
    patientScope.kind === "all" || await patientInDoctorScopeWith(q, patientScope.clinicianPartyId, patientId)
  );
  if (!inside) throw new CanonicalEndoVisitRefusal("patient_not_found", 404, PATIENT_NOT_FOUND_MESSAGE);
}

async function assertPatientInOperationScope(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  patientId: number,
  lockMode: "SHARE" | "UPDATE" | "NONE" = "SHARE",
): Promise<void> {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const lockSql = lockMode === "NONE" ? "" : ` FOR ${lockMode}`;
  const { rows } = await client.query(`SELECT 1 FROM patients WHERE id = $1${lockSql}`, [patientId]);
  const inside = rows.length === 1 && (
    scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId)
  );
  if (!inside) throw new CanonicalEndoVisitRefusal("patient_not_found", 404, PATIENT_NOT_FOUND_MESSAGE);
}

async function assertVisitInOperationScope(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  visitId: number,
): Promise<{ patientId: number | null; doctorId: number | null }> {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const visit = await visitPatientOfWith(client, visitId);
  const inside = visit !== null && (
    scope.kind === "all"
    || visit.doctorId === scope.clinicianPartyId
    || (visit.patientId !== null && await patientInDoctorScopeWith(client, scope.clinicianPartyId, visit.patientId))
  );
  if (!inside || !visit) throw new CanonicalEndoVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND_MESSAGE);
  return visit;
}

/* ============================================================================
 * 1. Endodontics (/api/patients/[id]/endo/**)
 * ========================================================================== */

export async function readCanonicalPatientEndo(
  session: VerifiedDurableSession,
  patientId: number,
): Promise<{ readonly treatments: VisibleEndoTreatmentView[] }> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_patient_id", 400, "رقم مريض غير صالح.");
  }
  return runCanonicalReadSnapshot(session, "read:patients.record", async (q, scope) => {
    await assertPatientInSnapshotScope(q, scope.patientScope, patientId);
    const planVisible = scope.granted("clinical.plans.view");
    const treatments = await listPatientEndoWith(q, patientId);
    return { treatments: treatments.map((view) => visibleEndoTreatment(view, planVisible)) };
  }, { errorPrefix: "STAFF_READ", maxBytes: ENDO_VISIT_READ_MAX_BYTES });
}

export async function createCanonicalEndoTreatment(
  session: VerifiedDurableSession,
  patientId: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<VisibleEndoTreatmentView> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_patient_id", 400, "رقم مريض غير صالح.");
  }
  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
  const draft = checkEndoTreatmentDraft(body);
  if (!draft.ok) throw new CanonicalEndoVisitRefusal("invalid_endo_draft", 400, draft.message);
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    await assertPatientInOperationScope(client, handle, "clinical.visits.document", patientId, "SHARE");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const caps = await staffOperationCapabilities(client, handle, "clinical.visits.document", ["clinical.plans.view"] as const);
    const result = await openEndoTreatmentInTransaction(client, {
      patientId,
      ...draft.value,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      const status = result.reason === "no_patient" ? 404 : result.reason === "bad_tooth" || result.reason === "bad_case" ? 400 : 409;
      throw new CanonicalEndoVisitRefusal(`endo_${result.reason}`, status, OPEN_ENDO_MESSAGE[result.reason]);
    }
    return visibleEndoTreatment(result.treatment, caps.has("clinical.plans.view"));
  });
}

export async function updateCanonicalEndoStatus(
  session: VerifiedDurableSession,
  patientId: number,
  treatmentId: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<VisibleEndoTreatmentView> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || !Number.isSafeInteger(treatmentId) || treatmentId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_endo_id", 400, "رقم غير صالح.");
  }
  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
  const change = checkEndoStatusChange(body);
  if (!change.ok) throw new CanonicalEndoVisitRefusal("invalid_endo_status", 400, change.message);
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    await assertPatientInOperationScope(client, handle, "clinical.visits.document", patientId, "SHARE");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const caps = await staffOperationCapabilities(client, handle, "clinical.visits.document", ["clinical.plans.view"] as const);
    const result = await changeEndoStatusInTransaction(client, {
      patientId,
      treatmentId,
      status: change.value.status as "completed" | "abandoned",
      outcome: change.value.outcome,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      if (result.reason === "not_ready") {
        throw new CanonicalEndoVisitRefusal("endo_not_ready", 409, result.message ?? "علاج الجذور غير جاهز للإكمال.");
      }
      throw new CanonicalEndoVisitRefusal(
        `endo_${result.reason}`,
        result.reason === "not_found" ? 404 : 409,
        ENDO_STATUS_MESSAGE[result.reason],
      );
    }
    return visibleEndoTreatment(result.treatment, caps.has("clinical.plans.view"));
  });
}

export async function updateCanonicalEndoCrown(
  session: VerifiedDurableSession,
  patientId: number,
  treatmentId: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<VisibleEndoTreatmentView> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || !Number.isSafeInteger(treatmentId) || treatmentId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_endo_id", 400, "رقم غير صالح.");
  }
  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
  const crownItem = optionalPositiveInt(body.crownPlanItemId);
  const rctItem = optionalPositiveInt(body.rctPlanItemId);
  if (typeof body.crownRequired !== "boolean") {
    throw new CanonicalEndoVisitRefusal("invalid_endo_crown", 400, "حدّد هل التاج لازم أم لا.");
  }
  if (!crownItem.ok || !rctItem.ok) {
    throw new CanonicalEndoVisitRefusal("invalid_endo_crown_item", 400, "بند الخطة غير صالح.");
  }
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    await assertPatientInOperationScope(client, handle, "clinical.visits.document", patientId, "SHARE");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const caps = await staffOperationCapabilities(
      client,
      handle,
      "clinical.visits.document",
      ["clinical.plans.view", "clinical.plans.edit"] as const,
    );
    if ((crownItem.value !== null || rctItem.value !== null) && !caps.has("clinical.plans.edit")) {
      throw new CanonicalEndoVisitRefusal("plan_edit_forbidden", 403, "تعديل خطط العلاج غير مفعّل لحسابك.");
    }
    const result = await setEndoCrownInTransaction(client, {
      patientId,
      treatmentId,
      crownRequired: body.crownRequired as boolean,
      crownPlanItemId: crownItem.value,
      rctPlanItemId: rctItem.value,
      canEditPlanLinks: caps.has("clinical.plans.edit"),
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      const status = result.reason === "not_found"
        ? 404
        : result.reason === "plan_forbidden"
          ? 403
          : ["bad_item", "bad_rct"].includes(result.reason)
            ? 400
            : 409;
      throw new CanonicalEndoVisitRefusal(`endo_${result.reason}`, status, ENDO_CROWN_MESSAGE[result.reason]);
    }
    return visibleEndoTreatment(result.treatment, caps.has("clinical.plans.view"));
  });
}

const SAVE_ENDO_VISIT_STATUS: Record<SaveEndoVisitRefusal, 400 | 404 | 409> = {
  not_found: 404,
  visit_not_found: 404,
  wrong_patient: 400,
  closed: 409,
  visit_signed: 409,
  no_treating_doctor: 409,
  ambiguous_doctor: 409,
  exists: 409,
  version_conflict: 409,
};

export async function saveCanonicalEndoVisit(
  session: VerifiedDurableSession,
  patientId: number,
  treatmentId: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ readonly created: boolean; readonly treatment: VisibleEndoTreatmentView }> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || !Number.isSafeInteger(treatmentId) || treatmentId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_endo_id", 400, "رقم غير صالح.");
  }
  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
  const visitId = positiveInt(body.visitId);
  if (!visitId) {
    throw new CanonicalEndoVisitRefusal("invalid_visit_id", 400, "اختر الزيارة التي يُسجَّل عليها علاج الجذور.");
  }
  let expectedVersion: number | null = null;
  if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
    const version = Number(body.expectedVersion);
    if (!Number.isInteger(version) || version < 1) {
      throw new CanonicalEndoVisitRefusal("invalid_version", 400, "رقم إصدار السجل غير صالح.");
    }
    expectedVersion = version;
  }
  const draft = checkEndoVisitDraft(body);
  if (!draft.ok) throw new CanonicalEndoVisitRefusal("invalid_endo_visit_draft", 400, draft.message);
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    await assertPatientInOperationScope(client, handle, "clinical.visits.document", patientId, "SHARE");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const actorPartyId = await staffOperationClinician(client, handle, "clinical.visits.document");
    const caps = await staffOperationCapabilities(client, handle, "clinical.visits.document", ["clinical.plans.view"] as const);
    const result = await saveEndoVisitInTransaction(client, {
      patientId,
      treatmentId,
      visitId,
      draft: draft.value,
      expectedVersion,
      actorPartyId,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      throw new CanonicalEndoVisitRefusal(
        `endo_${result.reason}`,
        SAVE_ENDO_VISIT_STATUS[result.reason],
        SAVE_ENDO_VISIT_MESSAGE[result.reason],
      );
    }
    return {
      created: result.created,
      treatment: visibleEndoTreatment(result.treatment, caps.has("clinical.plans.view")),
    };
  });
}

export async function createCanonicalEndoAddendum(
  session: VerifiedDurableSession,
  patientId: number,
  treatmentId: number,
  endoVisitId: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ readonly created: boolean; readonly treatment: VisibleEndoTreatmentView }> {
  if (
    !Number.isSafeInteger(patientId) || patientId <= 0
    || !Number.isSafeInteger(treatmentId) || treatmentId <= 0
    || !Number.isSafeInteger(endoVisitId) || endoVisitId <= 0
  ) {
    throw new CanonicalEndoVisitRefusal("invalid_endo_id", 400, "رقم غير صالح.");
  }
  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
  const text = checkEndoAddendum(body);
  if (!text.ok) throw new CanonicalEndoVisitRefusal("invalid_addendum", 400, text.message);
  const requestKey = body.requestKey;
  if (typeof requestKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(requestKey)) {
    throw new CanonicalEndoVisitRefusal("invalid_request_key", 400, "مفتاح إعادة محاولة الملحق غير صالح.");
  }
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    const caps = await staffOperationCapabilities(
      client,
      handle,
      "clinical.visits.document",
      ["clinical.visits.sign", "clinical.plans.view"] as const,
    );
    if (!caps.has("clinical.visits.sign")) {
      throw new CanonicalEndoVisitRefusal(
        "sign_capability_required",
        403,
        "إضافة ملحق على سجلٍّ موقَّع تتطلب صلاحية توقيع الزيارات.",
      );
    }
    await assertPatientInOperationScope(client, handle, "clinical.visits.document", patientId, "SHARE");
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const result = await addEndoAddendumInTransaction(client, {
      patientId,
      treatmentId,
      endoVisitId,
      text: text.value,
      requestKey,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : ["bad_key", "bad_text"].includes(result.reason) ? 400 : 409;
      throw new CanonicalEndoVisitRefusal(`endo_${result.reason}`, status, ENDO_ADDENDUM_MESSAGE[result.reason]);
    }
    return {
      created: result.created,
      treatment: visibleEndoTreatment(result.treatment, caps.has("clinical.plans.view")),
    };
  });
}

/* ============================================================================
 * 2. Clinical Visit (/api/visits/[id]/clinical) & Lab Work Command
 * ========================================================================== */

function projectClinicalVisit(
  visit: ClinicalVisit,
  grants: { readonly hasCare: boolean; readonly canViewPlans: boolean; readonly canViewOrtho: boolean },
): ClinicalVisit {
  let projected: ClinicalVisit = visit;
  if (!grants.hasCare) {
    projected = {
      ...projected,
      chiefComplaint: null,
      examination: null,
      diagnosis: null,
      addendum: null,
      previousVisit: null,
      latestDiagnosis: null,
      activeCases: [],
      suggestions: { ...projected.suggestions, chiefComplaint: null },
    };
  }
  if (!grants.canViewPlans) {
    projected = {
      ...projected,
      planItemsMatched: 0,
      planTitle: null,
      planWarning: null,
      outstanding: [],
      sessionPricing: [],
    };
  }
  if (!grants.canViewOrtho) {
    projected = {
      ...projected,
      ortho: null,
    };
  }
  return projected;
}

export async function readCanonicalClinicalVisit(
  session: VerifiedDurableSession,
  visitId: number,
): Promise<ClinicalVisit> {
  if (!Number.isSafeInteger(visitId) || visitId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_visit_id", 400, "رقم الزيارة غير صالح.");
  }
  return runCanonicalReadSnapshot(session, "read:visits.today", async (q, scope) => {
    if (scope.patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const meta = await visitPatientOfWith(q, visitId);
    const inside = meta !== null && (
      scope.patientScope.kind === "all"
      || meta.doctorId === scope.patientScope.clinicianPartyId
      || (meta.patientId !== null && await patientInDoctorScopeWith(q, scope.patientScope.clinicianPartyId, meta.patientId))
    );
    if (!inside) throw new CanonicalEndoVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND_MESSAGE);
    const visit = await getClinicalVisitWith(q, visitId, {
      actorPartyId: scope.clinicianPartyId,
      clinicianScopePartyId: scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null,
    });
    if (!visit) throw new CanonicalEndoVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND_MESSAGE);
    return projectClinicalVisit(visit, {
      hasCare: PATIENT_CARE_CAPABILITIES.some((cap) => scope.granted(cap)),
      canViewPlans: scope.granted("clinical.plans.view"),
      canViewOrtho: scope.granted("clinical.ortho.view"),
    });
  }, { errorPrefix: "STAFF_READ", maxBytes: ENDO_VISIT_READ_MAX_BYTES });
}

const SIGN_REASON_MESSAGES: Record<string, string> = {
  not_found: "الزيارة غير موجودة.",
  already_signed: "الزيارة موقَّعة سلفًا. التصحيح يكون بملحق.",
  empty: "سجّل إجراءً أو تشخيصًا قبل توقيع الزيارة.",
  no_patient: "اربط الزيارة بملف مريض قبل التوقيع — الفاتورة تدخل كشف حسابه.",
  mixed_plan_currencies: "الزيارة تجمع بنود خطط بعملات اتفاقٍ مختلفة — لا تُفوتر فاتورةً واحدة. أفصل الإجراءات على زياراتٍ أو خططٍ بعملةٍ واحدة.",
  no_treating_doctor: "حدّد الطبيب المعالج للزيارة (أو لكل إجراء) قبل التوقيع — لا يُفوتر إجراءٌ بلا طبيب، وإلا ضاعت عمولته.",
  unmet_dependency: "بنودٌ في هذه الزيارة تتطلب ما لم يكتمل بعد — اكتب سبب المتابعة لتُكمل التوقيع.",
  invalid_override_reason: "سبب المتابعة طويل جدًا — الحد الأقصى ٣٠٠ حرف.",
  ortho_adjustments_ambiguous: "توجد أكثر من شدّة تقويم مرتبطة بهذه الزيارة؛ راجع الحالة والعمل المقصود قبل التوقيع. لم يُسجّل أي رسم أو توقيع.",
  ortho_case_invalid: "حالة التقويم المرسلة مغلقة أو لا تخص مريض هذه الزيارة — حدّث الشاشة وأعد التوقيع.",
  plan_session_unlinked: "إجراءٌ حرّ يطابق بندًا له تمويل قائم أو جلسات في خطة المريض — اربطه ببنده الأصلي، أو ببند جديد صريح للعمل الإضافي، قبل التوقيع.",
  amended_plan_session_unlinked: "للخدمة تعديل مالي موثق؛ استقلال هذا العمل عن تغطيته غير متحقق. ربط الخدمة المعدلة سريريًا غير مدعوم حاليًا. تبقى الزيارة مسودة للمراجعة؛ لن تُنشأ فاتورة ثانية لهذا العمل.",
  invalid_decision_reason: "اكتب سبب «بلا رسوم» للشدّة (من ٣ أحرف إلى ٣٠٠).",
};

export async function handleCanonicalClinicalVisitPost(
  request: Request,
  session: VerifiedDurableSession,
  visitId: number | null,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  if (!visitId) {
    return NextResponse.json({ code: "invalid_visit_id", message: "رقم الزيارة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const source = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
    ? (rawBody as Record<string, unknown>)
    : {};
  const action = String(source.action ?? "save");
  const hasLabCommand = Object.hasOwn(source, "labRequestKey")
    || Object.hasOwn(source, "labRetirements")
    || (Array.isArray(source.procedures) && source.procedures.some((row) => !!row && typeof row === "object" && !!(row as Record<string, unknown>).labWork));
  if (hasLabCommand && (
    action !== "save"
    || !Array.isArray(source.procedures)
    || !Number.isSafeInteger(source.labPatientId)
    || Number(source.labPatientId) <= 0
    || typeof source.labRequestKey !== "string"
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(source.labRequestKey)
  )) {
    return NextResponse.json({ code: "invalid_lab_command", message: "هوية عملية مسوّدة المختبر غير صالحة." }, { status: 400, headers: NO_STORE });
  }
  const labRequestHash = hasLabCommand ? createHash("sha256").update(JSON.stringify(source)).digest("hex") : null;
  let labPatientId: number | null = null;
  let actorUsername = "";
  const text = (value: unknown, max = 2000) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

  const revalidated = revalidateVerifiedDurableSession(session);
  if (!revalidated) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  const actorKey = `${revalidated.durableIdentity.realmId}:${revalidated.durableIdentity.subjectId}`;

  const runAction = async (): Promise<NextResponse> => {
    try {
      if (action === "sign") {
        const rawDecision = (source.outsideContractDecision ?? null) as { decision?: unknown; reason?: unknown } | null;
        let outsideContractDecision: { decision: "no_charge"; reason: string } | null = null;
        if (rawDecision !== null) {
          if (rawDecision.decision !== "no_charge" || typeof rawDecision.reason !== "string") {
            throw new CanonicalEndoVisitRefusal("invalid_ortho_decision", 400, "قرار الشدّة غير صالح — «بلا رسوم» مع سببٍ مكتوب.");
          }
          outsideContractDecision = { decision: "no_charge", reason: rawDecision.reason };
        }
        const orthoSession = checkOrthoSessionDraft(source.orthoSession);
        if (!orthoSession.ok) {
          throw new CanonicalEndoVisitRefusal("invalid_ortho_session", 400, orthoSession.message);
        }
        const payload = await withStaffOperation(pool, session, "clinical.visits.sign", async (client, handle) => {
          const caps = await staffOperationCapabilities(
            client,
            handle,
            "clinical.visits.sign",
            ["clinical.visits.document", "clinical.ortho.edit", "clinical.plans.view", "clinical.ortho.view"] as const,
          );
          if (!caps.has("clinical.visits.document")) {
            throw new CanonicalEndoVisitRefusal("document_capability_required", 403, "التوثيق السريري غير مفعّل لحسابك.");
          }
          if ((orthoSession.value !== null || outsideContractDecision !== null) && !caps.has("clinical.ortho.edit")) {
            throw new CanonicalEndoVisitRefusal("ortho_edit_required", 403, "تسجيل شدّة التقويم أو قرار فوترتها يتطلب صلاحية تعديل التقويم.");
          }
          await assertVisitInOperationScope(client, handle, "clinical.visits.sign", visitId);
          // Peer-review #2: replay is answered only after live capability + visit scope were re-proved.
          return withHttpIdempotencyInTx(client, request, `visits.clinical.sign:${visitId}`, actorKey, source, async () => {
          const identity = await staffOperationIdentity(client, handle, "clinical.visits.sign");
          const signerDoctorPartyId = await staffOperationClinician(client, handle, "clinical.visits.sign");
          const result = await signClinicalVisitInTransaction(client, {
            visitId,
            baseCurrency: CLINIC_BASE_CURRENCY,
            signedBy: identity.username,
            signerDoctorPartyId,
            dependencyOverrideReason: typeof source.dependencyOverrideReason === "string" ? source.dependencyOverrideReason : null,
            orthoSession: orthoSession.value,
            outsideContractDecision,
            signerRole: identity.role,
            canonicalOperation: { handle, action: "clinical.visits.sign" },
            labSignVersion: typeof source.labSignVersion === "string" ? source.labSignVersion : null,
          });
          if (result.reason) {
            const status = result.reason === "invalid_override_reason" || result.reason === "invalid_decision_reason"
              ? 400
              : result.reason === "not_found"
                ? 404
                : 409;
            const extra = result.reason === "unmet_dependency"
              ? { unmetRequirements: result.unmetRequirements ?? [] }
              : result.reason === "plan_session_unlinked" || result.reason === "amended_plan_session_unlinked"
                ? { sessionConflicts: result.sessionConflicts ?? [] }
                : undefined;
            throw new CanonicalEndoVisitRefusal(result.reason, status, SIGN_REASON_MESSAGES[result.reason] ?? "تعذّر توقيع الزيارة.", extra);
          }
          await insertAuditRow(client, {
            action: "visit.sign",
            entity: "visit",
            entityId: visitId,
            entityLabel: result.visit?.patientName,
            details: {
              الإجراءات: result.visit?.procedures.length ?? 0,
              الإجمالي: result.duesMinor,
              الفاتورة: result.invoiceId,
              الفاتورة_المرتبطة_بالزيارة: result.visit?.invoiceId ?? result.invoiceId,
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
              الطبيب_المعالج: result.visit?.doctorId ?? null,
              ...(result.orthoBillingDecision ? { قرار_الشدّة: result.orthoBillingDecision === "billed" ? "فوتِرت" : "بلا رسوم" } : {}),
            },
            actor: identity.username,
            actorRole: identity.role,
          });
          const projectedVisit = result.visit
            ? projectClinicalVisit(result.visit, {
                hasCare: true,
                canViewPlans: caps.has("clinical.plans.view"),
                canViewOrtho: caps.has("clinical.ortho.view"),
              })
            : null;
          return { status: 200, body: {
            ...projectedVisit,
            invoiceId: projectedVisit?.invoiceId ?? result.invoiceId,
            createdInvoiceId: result.invoiceId,
            invoiceCurrency: result.invoiceCurrency,
            duesMinor: result.duesMinor,
            sessionsCompleted: result.sessionsCompleted,
            nextPlannedVisit: result.nextPlannedVisit,
            labOrdersCreated: result.labOrdersCreated,
            materialsDeducted: result.materialsDeducted,
            orthoAdjustmentId: result.orthoAdjustmentId,
            orthoBillingClass: result.orthoBillingClass,
          } };
          });
        });
        return NextResponse.json(payload.body, {
          status: payload.status,
          headers: payload.replay ? { ...NO_STORE, "X-Idempotent-Replay": "true" } : NO_STORE,
        });
      }

      if (action === "addendum") {
        const note = text(source.text, 1000);
        if (!note) throw new CanonicalEndoVisitRefusal("invalid_addendum", 400, "اكتب نصّ الملحق.");
        const updated = await withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
          await assertVisitInOperationScope(client, handle, "clinical.visits.document", visitId);
          return withHttpIdempotencyInTx(client, request, `visits.clinical.addendum:${visitId}`, actorKey, source, async () => {
          const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
          const clinicianPartyId = await staffOperationClinician(client, handle, "clinical.visits.document");
          const scope = await staffOperationPatientScope(client, handle, "clinical.visits.document");
          const caps = await staffOperationCapabilities(
            client,
            handle,
            "clinical.visits.document",
            ["clinical.plans.view", "clinical.ortho.view"] as const,
          );
          const added = await addVisitAddendumInTransaction(client, {
            visitId,
            text: note,
            author: identity.username,
          });
          if (!added) {
            throw new CanonicalEndoVisitRefusal("visit_not_signed", 409, "الملحق يُضاف على زيارة موقَّعة فقط.");
          }
          await insertAuditRow(client, {
            action: "visit.addendum",
            entity: "visit",
            entityId: visitId,
            details: { النص: note },
            actor: identity.username,
            actorRole: identity.role,
          });
          const visit = await getClinicalVisitWith(client, visitId, {
            actorPartyId: clinicianPartyId,
            clinicianScopePartyId: scope.kind === "own" ? scope.clinicianPartyId : null,
          });
          if (!visit) throw new CanonicalEndoVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND_MESSAGE);
          return { status: 200, body: projectClinicalVisit(visit, {
            hasCare: true,
            canViewPlans: caps.has("clinical.plans.view"),
            canViewOrtho: caps.has("clinical.ortho.view"),
          }) };
          });
        });
        return NextResponse.json(updated.body, {
          status: updated.status,
          headers: updated.replay ? { ...NO_STORE, "X-Idempotent-Replay": "true" } : NO_STORE,
        });
      }

      const savedPayload = await withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
        const caps = await staffOperationCapabilities(
          client,
          handle,
          "clinical.visits.document",
          [
            "clinical.lab.order",
            "finance.discounts.apply",
            "finance.discounts.override",
            "finance.price-increases.apply",
            "clinical.plans.view",
            "clinical.ortho.view",
          ] as const,
        );
        if (hasLabCommand && !caps.has("clinical.lab.order")) {
          throw new CanonicalEndoVisitRefusal("lab_order_forbidden", 403, "طلب عمل المختبر غير مفعّل لحسابك.");
        }
        await assertVisitInOperationScope(client, handle, "clinical.visits.document", visitId);
        const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
        actorUsername = identity.username;
        const clinicianPartyId = await staffOperationClinician(client, handle, "clinical.visits.document");
        const scope = await staffOperationPatientScope(client, handle, "clinical.visits.document");
        const visit = await getClinicalVisitWith(client, visitId, {
          actorPartyId: clinicianPartyId,
          clinicianScopePartyId: scope.kind === "own" ? scope.clinicianPartyId : null,
        });
        if (!visit) throw new CanonicalEndoVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND_MESSAGE);
        if (hasLabCommand && source.labPatientId !== visit.patientId) {
          throw new CanonicalEndoVisitRefusal("source_changed", 409, "تغيّر المريض المرتبط بالزيارة؛ حدّث الملف قبل حفظ عمل المختبر.");
        }
        labPatientId = visit.patientId;

        const clinicalNotes = {
          chiefComplaint: text(source.chiefComplaint, 500),
          examination: text(source.examination),
          diagnosis: text(source.diagnosis),
          treatmentDone: text(source.treatmentDone),
          nextPlan: text(source.nextPlan, 500),
          doctorId: Number(source.doctorId) || null,
        };

        if (Array.isArray(source.procedures)) {
          const procedures = source.procedures
            .map((row) => row as Record<string, unknown>)
            .filter((row) => Number(row.serviceId) > 0)
            .map((row) => ({
              ...(row.labWork !== undefined ? { labWork: parseLabWorkDraft(row.labWork) } : {}),
              serviceId: Number(row.serviceId),
              toothCode: Number(row.toothCode) || null,
              surfaces: typeof row.surfaces === "string" ? row.surfaces : null,
              quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
              unitPriceMinor: Math.max(0, Math.round(Number(row.unitPriceMinor) || 0)),
              priceReason: text(row.priceReason, 300),
              doctorId: Number(row.doctorId) || null,
              note: text(row.note, 300),
              planItemId: Number(row.planItemId) > 0 ? Number(row.planItemId) : null,
            }));
          const settings = await getSettingsWith(client);
          const maxDiscount = Number(settings["billing.max_discount_percent"]);
          const overrides: ProcedurePriceOverride[] = [];
          if (source.billingCurrency !== undefined && source.billingCurrency !== null && !isCurrency(source.billingCurrency)) {
            if (hasLabCommand) throw new LabWorkIntentError("invalid_billing_currency", "عملة الزيارة غير صالحة.", 409);
            throw new CanonicalEndoVisitRefusal("invalid_billing_currency", 400, "عملة الزيارة غير صالحة.");
          }
          const ok = await setVisitProceduresInTransaction(client, {
            visitId,
            ...(hasLabCommand
              ? {
                  labCommand: {
                    expectedPatientId: source.labPatientId as number,
                    requestKey: source.labRequestKey as string,
                    requestHash: labRequestHash!,
                    retirements: parseLabWorkRetirements(source.labRetirements),
                    canonicalOperation: { handle, action: "clinical.visits.document" },
                  },
                }
              : {}),
            procedures,
            clinicalNotes,
            canonicalPriceAuthority: {
              capabilities: {
                canApplyDiscount: caps.has("finance.discounts.apply"),
                canOverrideDiscount: caps.has("finance.discounts.override"),
                canIncreasePrice: caps.has("finance.price-increases.apply"),
              },
              maxDiscountPercent: Number.isFinite(maxDiscount) ? maxDiscount : 0,
            },
            overrides,
            billingCurrency: isCurrency(source.billingCurrency) ? source.billingCurrency : undefined,
            rates: foreignRatesFromSettings(settings),
          });
          if (!ok) {
            if (hasLabCommand) throw new LabWorkIntentError("visit_signed", "الزيارة موقَّعة — لا تُعدَّل إجراءاتها.", 409);
            throw new CanonicalEndoVisitRefusal("visit_signed", 409, "الزيارة موقَّعة — لا تُعدَّل إجراءاتها.");
          }
          for (const override of overrides) {
            await insertAuditRow(client, {
              action: "visit.price_override",
              entity: "visit",
              entityId: visitId,
              entityLabel: `${visit.patientName ?? ""} — ${override.serviceName}`,
              details: {
                الخدمة: override.serviceName,
                العملة: override.currency,
                النوع: override.kind === "discount" ? "خصم" : override.kind === "increase" ? "رفع فوق الدليل" : "سعر يدوي لخدمة غير مسعّرة",
                سعر_الدليل: override.catalogMinor,
                السعر_المعتمد: override.requestedMinor,
                نسبة_الخصم: override.discountPercent,
                السبب: override.reason,
              },
              actor: identity.username,
              actorRole: identity.role,
            });
          }
        } else if (!(await saveClinicalNotes({ ...clinicalNotes, visitId }, client))) {
          throw new CanonicalEndoVisitRefusal("visit_signed", 409, "الزيارة موقَّعة — لا تُعدَّل. أضف ملحقًا.");
        }

        const saved = await getClinicalVisitWith(client, visitId, {
          actorPartyId: clinicianPartyId,
          clinicianScopePartyId: scope.kind === "own" ? scope.clinicianPartyId : null,
        });
        if (!saved) throw new CanonicalEndoVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND_MESSAGE);
        const projected = projectClinicalVisit(saved, {
          hasCare: true,
          canViewPlans: caps.has("clinical.plans.view"),
          canViewOrtho: caps.has("clinical.ortho.view"),
        });
        return hasLabCommand
          ? {
              ...projected,
              labWorkCommand: {
                requestKey: source.labRequestKey,
                requestHash: labRequestHash,
                visitId,
                patientId: projected.patientId,
                actor: identity.username,
              },
            }
          : projected;
      });
      return NextResponse.json(savedPayload, { headers: NO_STORE });
    } catch (error) {
      const unresolved = new Set([
        "command_busy",
        "intent_busy",
        "clinical_boundary_busy",
        "unauthorized",
        "schema_unavailable",
        "idempotency_conflict",
        "source_changed",
        "invalid_receipt",
      ]);
      const rejectionCode = error instanceof LabWorkContractError
        ? error.code
        : error instanceof LabWorkIntentError && error.status === 409 && !unresolved.has(error.code)
          ? error.code
          : error instanceof ClinicalDoctorIdentityConflict
            ? error.code
            : error instanceof ClinicalPlanConflict
              ? "clinical_plan_conflict"
              : error instanceof ProcedurePriceRejected && !error.forbidden
                ? "procedure_price_rejected"
                : null;
      if (hasLabCommand && labPatientId !== null && labRequestHash && rejectionCode) {
        try {
          const settled = await withStaffOperation(pool, session, "clinical.lab.order", async (settleClient, settleHandle) => {
            const settleIdentity = await staffOperationIdentity(settleClient, settleHandle, "clinical.lab.order");
            const settleClinician = await staffOperationClinician(settleClient, settleHandle, "clinical.lab.order");
            const settleScope = await staffOperationPatientScope(settleClient, settleHandle, "clinical.lab.order");
            const result = await settleRejectedClinicalLabCommandInTransaction(settleClient, {
              patientId: labPatientId!,
              visitId,
              canonicalOperation: { handle: settleHandle, action: "clinical.lab.order" },
              requestKey: source.labRequestKey as string,
              requestHash: labRequestHash,
              code: rejectionCode,
            });
            const labWorkCommand = {
              requestKey: source.labRequestKey,
              requestHash: labRequestHash,
              patientId: labPatientId,
              visitId,
              actor: actorUsername || settleIdentity.username,
            };
            if (result.outcome === "applied") {
              const saved = await getClinicalVisitWith(settleClient, visitId, {
                actorPartyId: settleClinician,
                clinicianScopePartyId: settleScope.kind === "own" ? settleScope.clinicianPartyId : null,
              });
              if (saved?.patientId !== labPatientId) throw new Error("source changed");
              return { status: 200 as const, body: { ...saved, labWorkCommand } };
            }
            return {
              status: 409 as const,
              body: {
                labWorkCommand,
                labWorkOutcome: "rejected",
                code: result.code,
                message: "لم يُحفظ الطلب. حدّث البيانات وصحّحها ثم احفظ من جديد.",
              },
            };
          });
          return NextResponse.json(settled.body, { status: settled.status, headers: NO_STORE });
        } catch {
          // Preserve original error when rejection settlement cannot establish terminal proof.
        }
      }
      return canonicalEndoVisitFailure(error, "تعذّر حفظ الزيارة.");
    }
  };

  return runAction();
}

export async function readCanonicalVisitLabWorkCommand(
  session: VerifiedDurableSession,
  visitId: number,
  requestKey: string,
  requestHash: string,
  pool: DbPool = getPool(),
): Promise<unknown> {
  if (
    !Number.isSafeInteger(visitId)
    || visitId <= 0
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)
    || !/^[a-f0-9]{64}$/.test(requestHash)
  ) {
    throw new CanonicalEndoVisitRefusal("invalid_command_ref", 400, "مرجع العملية غير صالح.");
  }
  return withStaffOperation(pool, session, "clinical.lab.order", async (client, handle) => {
    if (!(await labWorkIntentSupported(client))) throw new LabWorkIntentError("schema_unavailable", 503);
    const scope = await staffOperationPatientScope(client, handle, "clinical.lab.order");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
    const visit = (
      await client.query<{ patient_id: number | null; doctor_id: number | null }>(
        "SELECT patient_id, doctor_id FROM visits WHERE id = $1",
        [visitId],
      )
    ).rows[0];
    if (!visit?.patient_id) throw new LabWorkIntentError("visit_unavailable", 404);
    if (scope.kind === "own" && !(await doctorOwnsPatient(scope.clinicianPartyId, visit.patient_id, client, "nowait"))) {
      throw new LabWorkIntentError("visit_unavailable", 404);
    }
    await client.query("SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE NOWAIT", [visit.patient_id]);
    const locked = (
      await client.query<{ patient_id: number | null }>(
        "SELECT patient_id FROM visits WHERE id = $1 FOR SHARE NOWAIT",
        [visitId],
      )
    ).rows[0];
    if (locked?.patient_id !== visit.patient_id) throw new LabWorkIntentError("source_changed", 409);
    const result = await readLabWorkCommandInTransaction(client, {
      patientId: visit.patient_id,
      sourceKind: "visit",
      sourceId: visitId,
      canonicalOperation: { handle, action: "clinical.lab.order" },
      requestKey,
      requestHash,
    });
    return result
      ? {
          found: true,
          receipt: { requestKey, requestHash, visitId, patientId: visit.patient_id, actor: identity.username },
          result,
        }
      : { found: false };
  });
}

/* ============================================================================
 * 3. Visit & Patient Materials + Reception Handoff
 * ========================================================================== */

export async function readCanonicalVisitMaterials(
  session: VerifiedDurableSession,
  visitId: number,
): Promise<{
  readonly patientId: number | null;
  readonly lines: VisitMaterialLine[];
  readonly returns: VisitMaterialReturnLine[];
}> {
  if (!Number.isSafeInteger(visitId) || visitId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_visit_id", 400, "رقم الزيارة غير صالح.");
  }
  return runCanonicalReadSnapshot(session, "read:visits.today", async (q, scope) => {
    if (scope.patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const visit = await visitPatientOfWith(q, visitId);
    const inside = visit !== null && (
      scope.patientScope.kind === "all"
      || visit.doctorId === scope.patientScope.clinicianPartyId
      || (visit.patientId !== null && await patientInDoctorScopeWith(q, scope.patientScope.clinicianPartyId, visit.patientId))
    );
    if (!inside || !visit) throw new CanonicalEndoVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND_MESSAGE);
    const [lines, returns] = await Promise.all([
      visitMaterialMovementsWith(q, visitId),
      listVisitMaterialReturnsWith(q, visitId),
    ]);
    return { patientId: visit.patientId, lines, returns };
  }, { errorPrefix: "STAFF_READ", maxBytes: ENDO_VISIT_READ_MAX_BYTES });
}

export async function recordCanonicalVisitMaterialReturn(
  session: VerifiedDurableSession,
  visitId: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ readonly ok: true; readonly balance: number; readonly movementId: number }> {
  if (!Number.isSafeInteger(visitId) || visitId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_visit_id", 400, "رقم الزيارة غير صالح.");
  }
  const source = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
    ? (rawBody as Record<string, unknown>)
    : {};
  const itemId = Number(source.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0 || itemId > 2_147_483_647) {
    throw new CanonicalEndoVisitRefusal("invalid_item_id", 400, "رقم المادة غير صالح.");
  }
  const qty = Number(source.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) {
    throw new CanonicalEndoVisitRefusal("invalid_qty", 400, "اكتب كمية صالحة أكبر من صفر.");
  }
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 200) : null;
  return withStaffOperation(pool, session, "clinical.visits.document", async (client, handle) => {
    await assertVisitInOperationScope(client, handle, "clinical.visits.document", visitId);
    const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
    const result = await returnVisitMaterialInTransaction(client, {
      visitId,
      itemId,
      qty,
      reason,
      createdBy: identity.username,
    });
    if (!result.ok) {
      throw new CanonicalEndoVisitRefusal("material_return_refused", result.status, result.message);
    }
    return { ok: true, balance: result.balance, movementId: result.movement.id };
  });
}

export async function readCanonicalPatientMaterials(
  session: VerifiedDurableSession,
  patientId: number,
): Promise<PatientMaterialMovementLine[]> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_patient_id", 400, "رقم المريض غير صالح.");
  }
  return runCanonicalReadSnapshot(session, "read:patients.record", async (q, scope) => {
    await assertPatientInSnapshotScope(q, scope.patientScope, patientId);
    return patientMaterialMovementsWith(q, patientId);
  }, { errorPrefix: "STAFF_READ", maxBytes: ENDO_VISIT_READ_MAX_BYTES });
}

export async function completeCanonicalReceptionHandoff(
  session: VerifiedDurableSession,
  rawVisitId: string,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{
  readonly ok: true;
  readonly visitId: number;
  readonly patientId: number;
  readonly signedAt: string;
  readonly status: "handled";
  readonly handledReason: string;
}> {
  const visitId = Number(rawVisitId);
  if (!/^[1-9]\d*$/.test(rawVisitId) || !Number.isSafeInteger(visitId)) {
    throw new CanonicalEndoVisitRefusal("invalid_visit_id", 400, "رقم الزيارة غير صالح.");
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new CanonicalEndoVisitRefusal("invalid_body", 400, "طلب غير صالح.");
  }
  const source = rawBody as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !["patientId", "signedAt", "reason"].includes(key))
    || typeof source.patientId !== "number"
    || !Number.isSafeInteger(source.patientId)
    || source.patientId <= 0
    || !isHandoffSignature(source.signedAt)
    || typeof source.reason !== "string"
    || source.reason.trim().length < 3
    || source.reason.trim().length > 300
  ) {
    throw new CanonicalEndoVisitRefusal(
      "invalid_handoff_input",
      400,
      "حدّد المريض والتوقيع وسبب إنهاء المتابعة (من ٣ إلى ٣٠٠ حرف).",
    );
  }
  const patientId = source.patientId;
  const signedAt = source.signedAt;
  const reason = source.reason.trim();
  return withStaffOperation(pool, session, "visits.manage", async (client, handle) => {
    const visit = await assertVisitInOperationScope(client, handle, "visits.manage", visitId);
    if (visit.patientId !== patientId) {
      throw new CanonicalEndoVisitRefusal("handoff_patient_changed", 409, "تغيّر المريض المرتبط بالزيارة. حدّث الصفحة.");
    }
    const identity = await staffOperationIdentity(client, handle, "visits.manage");
    const result = await completeReceptionHandoffInTransaction(
      client,
      {
        visitId,
        patientId,
        signedAt,
        reason,
      },
      { actor: identity.username, actorRole: identity.role },
    );
    if (!result.ok) {
      const status = result.reason === "forbidden"
        ? 403
        : result.reason === "not_found"
          ? 404
          : result.reason === "invalid"
            ? 400
            : 409;
      throw new CanonicalEndoVisitRefusal(
        `handoff_${result.reason}`,
        status,
        status === 409 ? "تغيّرت الزيارة أو توقيعها. حدّث الصفحة قبل إنهاء المتابعة." : "تعذّر إنهاء متابعة الزيارة.",
      );
    }
    return result;
  });
}

/* ============================================================================
 * 4. Appointment Availability (/api/appointments/availability)
 * ========================================================================== */

const validIsoDate = (date: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return date >= "0001-01-01" && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

export async function readCanonicalAppointmentAvailability(
  session: VerifiedDurableSession,
  params: URLSearchParams,
): Promise<ReturnType<typeof doctorAvailabilitySuggestions>> {
  const date = params.get("date") ?? "";
  const doctorId = Number(params.get("doctorId"));
  const durationMinutes = Number(params.get("durationMinutes") ?? 30);
  const serviceId = params.has("serviceId") ? Number(params.get("serviceId")) : null;
  const appointmentType = params.get("appointmentType");
  const chairNo = params.has("chairNo") ? Number(params.get("chairNo")) : null;
  const isNewPatient = params.get("isNewPatient") === "true";
  if (
    !validIsoDate(date)
    || !Number.isInteger(doctorId)
    || doctorId <= 0
    || !Number.isInteger(durationMinutes)
    || durationMinutes < MIN_DURATION
    || durationMinutes > MAX_DURATION
    || (serviceId !== null && (!Number.isInteger(serviceId) || serviceId <= 0))
    || (chairNo !== null && (!Number.isInteger(chairNo) || chairNo <= 0))
  ) {
    throw new CanonicalEndoVisitRefusal("invalid_availability_query", 400, "حدّد طبيبًا وتاريخًا ومدة صحيحة.");
  }
  return runCanonicalReadSnapshot(session, "read:appointments.availability", async (q, scope) => {
    if (scope.appointmentScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.appointmentScope.kind === "own" && scope.appointmentScope.clinicianPartyId !== doctorId) {
      throw new CanonicalEndoVisitRefusal("availability_scope_denied", 403, "يمكنك عرض أوقاتك فقط.");
    }
    const doctor = await getPartyWith(q, doctorId);
    if (!doctor || doctor.kind !== "doctor" || !doctor.isActive) {
      throw new CanonicalEndoVisitRefusal("doctor_not_available", 404, "الطبيب غير متاح للحجز.");
    }
    const [context, service, appointments, blocks, roster] = await Promise.all([
      loadCapacityContextWith(q),
      resolveServiceWith(q, { serviceId, appointmentType }),
      listAppointmentsByDateWith(q, date, null),
      loadProviderBlockWindows(doctorId, date, q),
      readDoctorAvailabilityAdvisoryWith(q, doctorId, date, CLINIC_TIME_ZONE),
    ]);
    if (chairNo !== null && chairNo > context.chairs) {
      throw new CanonicalEndoVisitRefusal("invalid_chair", 400, "الكرسي المختار غير موجود.");
    }
    const now = new Date();
    const clinicTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: CLINIC_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
    return doctorAvailabilitySuggestions({
      date,
      doctorId,
      durationMinutes,
      service,
      context,
      appointments,
      blocks,
      chairNo,
      isNewPatient,
      roster,
      timeZone: CLINIC_TIME_ZONE,
      today: clinicDateString(now, CLINIC_TIME_ZONE),
      nowMinutes: toMinutes(clinicTime) ?? 0,
    });
  }, { errorPrefix: "STAFF_READ", maxBytes: ENDO_VISIT_READ_MAX_BYTES });
}

/* ============================================================================
 * 5. Patient Lifecycle (DELETE /patients/[id], /merge, /number)
 * ========================================================================== */

export async function deleteCanonicalPatient(
  session: VerifiedDurableSession,
  patientId: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ readonly message: string; readonly counts: Record<string, number> }> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_patient_id", 400, "رقم المريض غير صالح.");
  }
  const source = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
    ? (rawBody as Record<string, unknown>)
    : {};
  const reason = typeof source.reason === "string" && source.reason.trim() ? source.reason.trim().slice(0, 300) : null;
  const confirmNumber = typeof source.confirmPatientNumber === "string" ? source.confirmPatientNumber.trim() : null;

  return withStaffOperation(pool, session, "patients.delete", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "patients.delete");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const { rows: [patient] } = await client.query<{ id: number; full_name: string; patient_number: string }>(
      "SELECT id, full_name, patient_number FROM patients WHERE id = $1 FOR UPDATE",
      [patientId],
    );
    const inside = patient !== undefined && (
      scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId)
    );
    if (!inside || !patient) {
      throw new CanonicalEndoVisitRefusal("patient_not_found", 404, PATIENT_NOT_FOUND_MESSAGE);
    }
    if (confirmNumber !== patient.patient_number) {
      throw new CanonicalEndoVisitRefusal("invalid_confirm_number", 400, "تأكيد الحذف يتطلب كتابة رقم ملف المريض نفسه.");
    }
    const identity = await staffOperationIdentity(client, handle, "patients.delete");
    const result = await deletePatientCascadeInTransaction(client, patientId, {
      actor: identity.username,
      actorRole: identity.role,
      reason,
    });
    if (!result.ok) {
      if (result.reason === "has_financial_history") {
        throw new CanonicalEndoVisitRefusal(
          "has_financial_history",
          409,
          "هذا الملف له أثر مالي (دفعات/فواتير/رصيد افتتاحي/حركات مخزون/التزامات أعمال معمل أو صرفها) لا يجوز محوه — السجل المالي يبقى شاهدًا، والتصحيح بأحداث معاكسة، وأي محو قانوني/GDPR مستقبلًا workflow منفصل مصرَّح ومدقَّق.",
          { counts: result.counts ?? {} },
        );
      }
      if (result.reason === "has_clinical_history") {
        throw new CanonicalEndoVisitRefusal(
          "has_clinical_history",
          409,
          "هذا الملف يحمل سجلًّا طبيًّا (زيارات موقّعة/أشعة ومستندات/سيفالو/تقويم/تشخيصات/وصفات/إحالات/تاريخ طبي وعلامات حيوية) يجب حفظه — لا يُحذف. الحذف متاحٌ فقط لملفٍّ سُجّل خطأً بلا سجلٍّ طبي.",
          { counts: result.counts ?? {} },
        );
      }
      throw new CanonicalEndoVisitRefusal("patient_not_found", 404, PATIENT_NOT_FOUND_MESSAGE);
    }
    return {
      message: `حُذف ملف «${patient.full_name}» بكل سجلاته وسُجّل الحذف في التدقيق.`,
      counts: result.counts ?? {},
    };
  });
}

export async function mergeCanonicalPatient(
  session: VerifiedDurableSession,
  targetId: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ readonly message: string; readonly moved: Record<string, number>; readonly patient: unknown }> {
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    throw new CanonicalEndoVisitRefusal("invalid_patient_id", 400, "رقم المريض غير صالح.");
  }
  const source = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
    ? (rawBody as Record<string, unknown>)
    : {};
  const duplicateNumber = typeof source.duplicatePatientNumber === "string" ? source.duplicatePatientNumber.trim() : "";
  const confirmNumber = typeof source.confirmDuplicateNumber === "string" ? source.confirmDuplicateNumber.trim() : "";
  const reason = typeof source.reason === "string" && source.reason.trim() ? source.reason.trim().slice(0, 300) : null;
  if (!duplicateNumber) {
    throw new CanonicalEndoVisitRefusal("missing_duplicate_number", 400, "اكتب رقم الملف المكرر.");
  }
  if (confirmNumber.toUpperCase() !== duplicateNumber.toUpperCase()) {
    throw new CanonicalEndoVisitRefusal("confirm_mismatch", 400, "أعد كتابة رقم الملف المكرر نفسه للتأكيد.");
  }

  return withStaffOperation(pool, session, "patients.merge", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "patients.merge");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const candidateSourceId = await findPatientIdByNumberWith(client, duplicateNumber);
    // Independent finding 12: lock BOTH files (id order) before any scope decision, then
    // re-read under the locks — a decision made before waiting could be stale.
    await client.query(
      "SELECT id FROM patients WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
      [[targetId, ...(candidateSourceId !== null ? [candidateSourceId] : [])]],
    );
    const sourceId = await findPatientIdByNumberWith(client, duplicateNumber);
    if (sourceId !== candidateSourceId) {
      throw new CanonicalEndoVisitRefusal("conflict", 409, "تغيّر رقم الملف المكرر أثناء الدمج. حدّث الصفحة وأعد المحاولة.");
    }
    const targetRes = await client.query<{ id: number; full_name: string }>("SELECT id, full_name FROM patients WHERE id = $1", [targetId]);
    const target = targetRes.rows[0];
    const targetInside = target !== undefined && (
      scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, targetId)
    );
    if (!targetInside || !target) {
      throw new CanonicalEndoVisitRefusal("patient_not_found", 404, PATIENT_NOT_FOUND_MESSAGE);
    }
    const sourceInside = sourceId !== null && (
      scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, sourceId)
    );
    if (!sourceInside || sourceId === null) {
      throw new CanonicalEndoVisitRefusal("duplicate_not_found", 404, "لا يوجد ملف بهذا الرقم.");
    }
    const identity = await staffOperationIdentity(client, handle, "patients.merge");
    const result = await mergeDuplicatePatientInTransaction(client, sourceId, targetId, {
      actor: identity.username,
      actorRole: identity.role,
      reason,
    });
    if (!result.ok) {
      const mapping: Record<typeof result.reason, [string, 400 | 404 | 409]> = {
        same_patient: ["لا يُدمج الملف في نفسه.", 400],
        not_found: ["لا يوجد ملف بهذا الرقم.", 404],
        source_has_financial_history: [
          "الملف المكرر له أثر مالي (دفعات أو حركات مخزون أو رصيد افتتاحي أو سجل مالي سابق، ولو كان مسدّدًا بالكامل). لا يمكن نقل هذه السجلات بالدمج. راجع الملفين واختيار الملف الأساسي قبل المحاولة.",
          409,
        ],
        conflict: ["تعارضٌ يمنع الدمج (سجلٌّ لا يتكرر لكل مريض موجودٌ في الملفين). لم يُغيَّر شيء.", 409],
      };
      const [message, status] = mapping[result.reason];
      throw new CanonicalEndoVisitRefusal(result.reason, status, message, { counts: result.counts ?? {} });
    }
    return {
      message: `دُمج الملف ${duplicateNumber} في ملف «${target.full_name}» وحُذف المكرر.`,
      moved: result.moved,
      patient: result.target,
    };
  });
}

export async function readCanonicalPatientNumber(
  session: VerifiedDurableSession,
  patientId: number,
): Promise<PatientNumberSnapshot> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new PatientNumberingError("invalid", "معرّف المريض غير صالح.");
  }
  return runCanonicalReadSnapshot(session, "read:patients.number", async (q, scope) => {
    if (scope.patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const { rows } = await q.query<{ id: number; patient_number: string; patient_number_version: string }>(
      "SELECT id, patient_number, patient_number_version::text FROM patients WHERE id = $1",
      [patientId],
    );
    const inside = rows[0] !== undefined && (
      scope.patientScope.kind === "all" || await patientInDoctorScopeWith(q, scope.patientScope.clinicianPartyId, patientId)
    );
    if (!inside || !rows[0]) throw new PatientNumberingError("missing", "لم يُعثر على ملف المريض.");
    return {
      patientId: rows[0].id,
      patientNumber: rows[0].patient_number,
      version: rows[0].patient_number_version,
    };
  }, { errorPrefix: "STAFF_READ", maxBytes: ENDO_VISIT_READ_MAX_BYTES });
}

export async function changeCanonicalPatientNumber(
  session: VerifiedDurableSession,
  patientId: number,
  input: {
    patientNumber: unknown;
    expectedVersion: unknown;
    expectedPatientNumber: unknown;
    reason: unknown;
    allowPaperArchiveOverride?: boolean;
  },
  pool: DbPool = getPool(),
): Promise<PatientNumberSnapshot> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new PatientNumberingError("invalid", "معرّف المريض غير صالح.");
  }
  const number = parsePatientNumber(input.patientNumber);
  const version = parseNumberingVersion(input.expectedVersion);
  const reason = numberingReason(input.reason);
  if (!number || !version || !reason || typeof input.expectedPatientNumber !== "string") {
    throw new PatientNumberingError("invalid", "أدخل رقم ملف صحيحًا وسبب التعديل وأعد تحميل الرقم الحالي.");
  }
  const numericCheck = BigInt(number.replace(/^P-0*/, "") || "0");
  if (numericCheck > PATIENT_NUMBER_MAXIMUM) {
    throw new PatientNumberingError("invalid", "رقم الملف خارج النطاق المسموح.");
  }

  try {
    return await withStaffOperation(pool, session, "patients.number.manage", async (client, handle) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('patient_import'))");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('patient_numbering'))");
      const scope = await staffOperationPatientScope(client, handle, "patients.number.manage");
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows } = await client.query<{ id: number; patient_number: string; patient_number_version: string }>(
        "SELECT id, patient_number, patient_number_version::text FROM patients WHERE id = $1 FOR UPDATE",
        [patientId],
      );
      const inside = rows[0] !== undefined && (
        scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId)
      );
      if (!inside || !rows[0]) throw new PatientNumberingError("missing", "لم يُعثر على ملف المريض.");
      const before: PatientNumberSnapshot = {
        patientId: rows[0].id,
        patientNumber: rows[0].patient_number,
        version: rows[0].patient_number_version,
      };
      if (before.version !== version || before.patientNumber !== input.expectedPatientNumber) {
        throw new PatientNumberingError("stale", "تغيّر رقم الملف منذ فتحه؛ حدّث الصفحة قبل المحاولة.");
      }
      if (before.patientNumber === number) {
        throw new PatientNumberingError("invalid", "رقم الملف الجديد مطابق للحالي.");
      }
      const paperOverride = input.allowPaperArchiveOverride === true;
      if (paperOverride) {
        const numeric = Number(number.replace(/^P-0*/, "") || "0");
        if (!Number.isFinite(numeric) || numeric < 1 || numeric >= 7000) {
          throw new PatientNumberingError("invalid", "تجاوز الأرقام المتقاعدة مسموح لأرقام الأرشيف الورقي الأقل من 7000 فقط.");
        }
        const ownerOps = await staffOperationOwnerOperations(
          client,
          handle,
          "patients.number.manage",
          ["settings.security.change"] as const,
        );
        if (!ownerOps.has("settings.security.change")) {
          throw new PatientNumberingError("forbidden", "إعادة استخدام رقم أرشيف ورقي متقاعد (< 7000) متاحة للمالك الأساسي فقط.");
        }
        await client.query("SET LOCAL aqlan.owner_paper_override = 'on'");
      }
      const identity = await staffOperationIdentity(client, handle, "patients.number.manage");
      await client.query("UPDATE patients SET patient_number = $2 WHERE id = $1", [patientId, number]);
      const { rows: [afterRow] } = await client.query<{ id: number; patient_number: string; patient_number_version: string }>(
        "SELECT id, patient_number, patient_number_version::text FROM patients WHERE id = $1",
        [patientId],
      );
      const after: PatientNumberSnapshot = {
        patientId: afterRow.id,
        patientNumber: afterRow.patient_number,
        version: afterRow.patient_number_version,
      };
      await insertAuditRow(client, {
        action: "patient.number.change",
        entity: "patient",
        entityId: patientId,
        actor: identity.username,
        actorRole: identity.role,
        details: {
          before,
          after,
          reason,
          internalPatientIdUnchanged: true,
          oldNumberRetired: true,
          ...(paperOverride ? { paperArchiveOverride: true } : {}),
        },
      });
      return after;
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      throw new PatientNumberingError("duplicate", "رقم الملف مستخدم حاليًا أو سبق استخدامه؛ اختر رقمًا آخر.");
    }
    if (["55P03", "40P01"].includes((error as { code?: string })?.code ?? "")) {
      throw new PatientNumberingError("busy", "هناك عملية ترقيم أخرى؛ حدّث المعاينة وأعد المحاولة.");
    }
    throw error;
  }
}
