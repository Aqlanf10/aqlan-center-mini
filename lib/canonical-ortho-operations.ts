import "server-only";
import { NextResponse } from "next/server";
import { isOutsideContractDecision, type OutsideContractDecision } from "./billing-classification";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import {
  CLINIC_TIME_ZONE,
  closeOrthoCaseWith,
  createOrthoCaseWith,
  decideOrthoAdjustmentBillingWith,
  getPool,
  insertAuditRow,
  linkOrthoCasePlanWith,
  listPendingOrthoDecisionsWith,
  orthoFollowupBoardWith,
  patientInDoctorScopeWith,
  recordAdjustmentWith,
  recordOrthoBaselineWith,
  setOrthoPhaseWith,
  setRetainerWith,
  type DbClient,
  type DbPool,
  type OrthoBaselineRefusal,
} from "./db";
import { PHASE_LABEL, RETAINER_LABEL, type Appliance, type Arches, type OrthoPhase, type RetainerType, type SlotSize } from "./ortho";
import { checkBaselineDraft, checkOrthoSessionDraft } from "./ortho-baseline";
import { BUCKET_ORDER, classifyFollowups, groupByBucket } from "./ortho-followup";
import { clinicDateString } from "./schedule";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationClinician,
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
  type StaffOperationHandle,
  type StaffRuntimeAction,
} from "./staff-operation-runtime";

/**
 * Canonical Orthodontics Operations (M2 slice 31).
 *
 * Covers the remaining orthodontic reads and commands after `GET /api/ortho` (slice 29):
 *  - `GET /api/ortho/[id]`: `read:ortho.case` (`clinical.ortho.view` + patient scope);
 *    redacts `adjustments[].photos` unless `clinical.xrays.view` is granted and `planId`
 *    unless `clinical.plans.view` is granted; outside scope reads as `404`.
 *  - `POST /api/ortho`: `clinical.ortho.edit` + patient scope (and `clinical.plans.view`
 *    when `planId !== null`), with atomic `insertAuditRow`.
 *  - `POST /api/ortho/[id]`: `clinical.ortho.edit` + patient scope (`recordAdjustmentWith`).
 *  - `PATCH /api/ortho/[id]`: `clinical.ortho.edit` + patient scope (`planId` branch also
 *    requires `clinical.plans.edit`), with atomic `insertAuditRow` on phase, retainer, and close.
 *  - `POST /api/ortho/baseline`: `clinical.ortho.edit` + patient scope (`planId !== null`
 *    also requires `clinical.plans.view`; `own` scope cannot assign another doctor).
 *  - `GET /api/ortho/followups`: `read:ortho.followups` (`clinical.ortho.view` + patient scope).
 *  - `GET /api/ortho/billing-decisions`: `read:ortho.billing-decisions` (`clinical.ortho.view` + patient scope).
 *  - `POST /api/ortho/adjustments/[id]/billing-decision`: branches on `decision`
 *    (`billed` -> `finance.invoices.create`; `no_charge` -> `clinical.ortho.edit`) + patient scope.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const APPLIANCES: readonly Appliance[] = Object.freeze(["fixed_metal", "fixed_ceramic", "aligners", "removable", "functional"]);
const ARCHES: readonly Arches[] = Object.freeze(["upper", "lower", "both"]);
const SLOTS: readonly SlotSize[] = Object.freeze(["018", "022"]);

export type CanonicalOrthoRefusalCode =
  | "invalid_ortho_input"
  | "ortho_case_not_found"
  | "patient_not_found"
  | "adjustment_not_found"
  | "ortho_forbidden"
  | "ortho_conflict";

export class CanonicalOrthoRefusal extends Error {
  constructor(
    readonly code: CanonicalOrthoRefusalCode,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "CanonicalOrthoRefusal";
  }
}

export function canonicalOrthoFailure(error: unknown, fallback: string): NextResponse {
  if (error instanceof CanonicalOrthoRefusal) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  }
  return canonicalPatientReadFailure(error, fallback);
}

function positiveId(value: unknown): number | null {
  const n = Number(value);
  return typeof value !== "boolean" && value !== null && value !== "" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function lockPatientAndAssertOrthoScope(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  patientId: number,
  notFoundCode: "ortho_case_not_found" | "patient_not_found" | "adjustment_not_found",
  notFoundMessage: string,
) {
  const { rows: [locked] } = await client.query<{ id: number }>(
    `SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`,
    [patientId],
  );
  const identity = await staffOperationIdentity(client, handle, action);
  const patientScope = await staffOperationPatientScope(client, handle, action);
  if (patientScope.kind === "none") {
    throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
  }
  if (!locked) {
    throw new CanonicalOrthoRefusal(notFoundCode, 404, notFoundMessage);
  }
  if (
    patientScope.kind === "own"
    && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, locked.id))
  ) {
    throw new CanonicalOrthoRefusal(notFoundCode, 404, notFoundMessage);
  }
  return { identity, patientScope };
}

/* ---------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------- */

export async function readCanonicalOrthoFollowups(session: VerifiedDurableSession) {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  return runCanonicalReadSnapshot(
    session,
    "read:ortho.followups",
    async (query, scope) => {
      const board = await orthoFollowupBoardWith(
        query,
        today,
        scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null,
      );
      const rows = classifyFollowups({ cases: board, today });
      const groups = groupByBucket(rows);
      const buckets = BUCKET_ORDER.map(bucket => ({
        bucket,
        count: groups.get(bucket)?.length ?? 0,
        rows: groups.get(bucket) ?? [],
      }));
      return { today, buckets };
    },
    { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 },
  );
}

export async function readCanonicalOrthoBillingDecisions(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(
    session,
    "read:ortho.billing-decisions",
    async (query, scope) => ({
      pending: await listPendingOrthoDecisionsWith(query, {
        scopedClinicianPartyId: scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null,
      }),
    }),
    { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 },
  );
}

/* ---------------------------------------------------------------------------
 * Writes
 * ------------------------------------------------------------------------- */

export async function commandCanonicalOrthoCreate(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ id: number }> {
  return withStaffOperation(pool, session, "clinical.ortho.edit", async (client, handle) => {
    const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
    const patientId = positiveId(source.patientId);
    if (!patientId) throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "اختر المريض أولًا.");

    const plannedMonths = Math.round(Number(source.plannedMonths ?? 18));
    if (!Number.isFinite(plannedMonths) || plannedMonths < 1 || plannedMonths > 120) {
      throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "المدة المتوقعة بين شهر و120 شهرًا.");
    }

    const appliance: Appliance = typeof source.appliance === "string" && (APPLIANCES as readonly string[]).includes(source.appliance)
      ? (source.appliance as Appliance)
      : "fixed_metal";
    const arches: Arches = typeof source.arches === "string" && (ARCHES as readonly string[]).includes(source.arches)
      ? (source.arches as Arches)
      : "both";
    const slot: SlotSize = typeof source.slot === "string" && (SLOTS as readonly string[]).includes(source.slot)
      ? (source.slot as SlotSize)
      : "022";

    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const startDate = typeof source.startDate === "string" && DATE_PATTERN.test(source.startDate)
      ? source.startDate
      : today;
    const planId = source.planId === undefined || source.planId === null ? null : positiveId(source.planId);
    if (source.planId !== undefined && source.planId !== null && planId === null) {
      throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "الخطة المختارة غير صالحة.");
    }

    const { identity } = await lockPatientAndAssertOrthoScope(
      client,
      handle,
      "clinical.ortho.edit",
      patientId,
      "patient_not_found",
      "لا يوجد مريض بهذا الرقم.",
    );

    if (planId !== null) {
      const granted = await staffOperationCapabilities(client, handle, "clinical.ortho.edit", ["clinical.plans.view"] as const);
      if (!granted.has("clinical.plans.view")) {
        throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "عرض خطط العلاج غير مفعّل لحسابك.");
      }
    }

    const created = await createOrthoCaseWith(client, {
      patientId,
      appliance,
      arches,
      slot,
      bracketSystem: typeof source.bracketSystem === "string" ? source.bracketSystem.slice(0, 80) : null,
      startDate,
      plannedMonths,
      planId,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      createdBy: identity.username,
    });
    if (!created.ok) {
      throw new CanonicalOrthoRefusal("ortho_conflict", 409, created.message);
    }
    await insertAuditRow(client, {
      action: "ortho.case_create",
      entity: "ortho_case",
      entityId: created.id,
      details: { المريض: patientId, الجهاز: appliance, الفكان: arches, الخطة: planId ?? null, البداية: startDate },
      actor: identity.username,
      actorRole: identity.role,
    });
    return { id: created.id };
  });
}

export async function commandCanonicalOrthoRecordAdjustment(
  session: VerifiedDurableSession,
  rawCaseId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ id: number; created: boolean; visitId: number | null; attachedToToday: boolean }> {
  const caseId = positiveId(rawCaseId);
  if (!caseId) throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "رقم الحالة غير صالح.");

  return withStaffOperation(pool, session, "clinical.ortho.edit", async (client, handle) => {
    const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const doneOn = typeof source.doneOn === "string" && DATE_PATTERN.test(source.doneOn) ? source.doneOn : today;
    const checked = checkOrthoSessionDraft({ ...source, caseId });
    if (!checked.ok || !checked.value) {
      throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, checked.ok ? "بيانات جلسة التقويم غير صالحة." : checked.message);
    }
    const visitId = source.visitId === undefined || source.visitId === null ? null : positiveId(source.visitId);

    const { rows: [owner] } = await client.query<{ patient_id: number }>(
      `SELECT patient_id FROM ortho_cases WHERE id = $1`,
      [caseId],
    );
    if (!owner) {
      const patientScope = await staffOperationPatientScope(client, handle, "clinical.ortho.edit");
      if (patientScope.kind === "none") {
        throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
      }
      throw new CanonicalOrthoRefusal("ortho_case_not_found", 404, "الحالة غير موجودة.");
    }

    const { identity } = await lockPatientAndAssertOrthoScope(
      client,
      handle,
      "clinical.ortho.edit",
      owner.patient_id,
      "ortho_case_not_found",
      "الحالة غير موجودة.",
    );

    const result = await recordAdjustmentWith(client, {
      visitId,
      ...checked.value,
      doneOn,
      recordedBy: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      throw new CanonicalOrthoRefusal("ortho_conflict", 409, result.message);
    }
    return {
      id: result.id,
      created: result.created,
      visitId: result.visitId,
      attachedToToday: result.attachedToToday,
    };
  });
}

export async function commandCanonicalOrthoPatch(
  session: VerifiedDurableSession,
  rawCaseId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true; changed?: boolean; funded?: boolean }> {
  const caseId = positiveId(rawCaseId);
  if (!caseId) throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "رقم الحالة غير صالح.");

  return withStaffOperation(pool, session, "clinical.ortho.edit", async (client, handle) => {
    const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
    const wantsPlan = "planId" in source;
    if (wantsPlan) {
      const granted = await staffOperationCapabilities(client, handle, "clinical.ortho.edit", ["clinical.plans.edit"] as const);
      if (!granted.has("clinical.plans.edit")) {
        throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "غير مصرّح لك بتعديل خطط العلاج.");
      }
      const planId = source.planId === null ? null : positiveId(source.planId);
      if (source.planId !== null && planId === null) {
        throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "الخطة المختارة غير صالحة.");
      }

      const { rows: [owner] } = await client.query<{ patient_id: number }>(`SELECT patient_id FROM ortho_cases WHERE id = $1`, [caseId]);
      if (!owner) {
        const patientScope = await staffOperationPatientScope(client, handle, "clinical.ortho.edit");
        if (patientScope.kind === "none") throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
        throw new CanonicalOrthoRefusal("ortho_case_not_found", 404, "الحالة غير موجودة.");
      }
      const { identity } = await lockPatientAndAssertOrthoScope(
        client,
        handle,
        "clinical.ortho.edit",
        owner.patient_id,
        "ortho_case_not_found",
        "الحالة غير موجودة.",
      );
      const linked = await linkOrthoCasePlanWith(client, {
        caseId,
        planId,
        actor: identity.username,
        actorRole: identity.role,
      });
      if (!linked.ok) {
        throw new CanonicalOrthoRefusal(
          linked.status === 404 ? "ortho_case_not_found" : "ortho_conflict",
          linked.status,
          linked.message,
        );
      }
      return linked;
    }

    if (typeof source.phase === "string") {
      if (!Object.prototype.hasOwnProperty.call(PHASE_LABEL, source.phase)) {
        throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "مرحلة غير معروفة.");
      }
      const { rows: [owner] } = await client.query<{ patient_id: number }>(`SELECT patient_id FROM ortho_cases WHERE id = $1`, [caseId]);
      if (!owner) {
        const patientScope = await staffOperationPatientScope(client, handle, "clinical.ortho.edit");
        if (patientScope.kind === "none") throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
        throw new CanonicalOrthoRefusal("ortho_case_not_found", 404, "الحالة غير موجودة.");
      }
      const { identity } = await lockPatientAndAssertOrthoScope(client, handle, "clinical.ortho.edit", owner.patient_id, "ortho_case_not_found", "الحالة غير موجودة.");
      const phase = source.phase as OrthoPhase;
      const changed = await setOrthoPhaseWith(client, caseId, phase);
      if (!changed) throw new CanonicalOrthoRefusal("ortho_conflict", 409, "الحالة مغلقة أو غير موجودة.");
      await insertAuditRow(client, {
        action: "ortho.phase_change",
        entity: "ortho_case",
        entityId: caseId,
        details: { المريض: owner.patient_id, المرحلة: phase },
        actor: identity.username,
        actorRole: identity.role,
      });
      return { ok: true };
    }

    if (typeof source.retainer === "string") {
      if (!Object.prototype.hasOwnProperty.call(RETAINER_LABEL, source.retainer)) {
        throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "نوع مثبّت غير معروف.");
      }
      const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
      const explicitOn = typeof source.retainerOn === "string" && DATE_PATTERN.test(source.retainerOn) ? source.retainerOn : null;
      const retainer = source.retainer as RetainerType;
      const deliveredOn = retainer === "none" ? null : explicitOn ?? today;

      const { rows: [owner] } = await client.query<{ patient_id: number }>(`SELECT patient_id FROM ortho_cases WHERE id = $1`, [caseId]);
      if (!owner) {
        const patientScope = await staffOperationPatientScope(client, handle, "clinical.ortho.edit");
        if (patientScope.kind === "none") throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
        throw new CanonicalOrthoRefusal("ortho_case_not_found", 404, "الحالة غير موجودة.");
      }
      const { identity } = await lockPatientAndAssertOrthoScope(client, handle, "clinical.ortho.edit", owner.patient_id, "ortho_case_not_found", "الحالة غير موجودة.");
      const saved = await setRetainerWith(client, {
        id: caseId,
        retainer,
        deliveredOn,
        preserveExistingDeliveryDate: explicitOn === null,
      });
      if (!saved) throw new CanonicalOrthoRefusal("ortho_conflict", 409, "الحالة مغلقة أو غير موجودة.");
      await insertAuditRow(client, {
        action: "ortho.retainer",
        entity: "ortho_case",
        entityId: caseId,
        details: { المريض: owner.patient_id, المثبت: retainer, التسليم: deliveredOn },
        actor: identity.username,
        actorRole: identity.role,
      });
      return { ok: true };
    }

    if (source.status === "completed" || source.status === "discontinued") {
      const { rows: [owner] } = await client.query<{ patient_id: number }>(`SELECT patient_id FROM ortho_cases WHERE id = $1`, [caseId]);
      if (!owner) {
        const patientScope = await staffOperationPatientScope(client, handle, "clinical.ortho.edit");
        if (patientScope.kind === "none") throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
        throw new CanonicalOrthoRefusal("ortho_case_not_found", 404, "الحالة غير موجودة.");
      }
      const { identity } = await lockPatientAndAssertOrthoScope(client, handle, "clinical.ortho.edit", owner.patient_id, "ortho_case_not_found", "الحالة غير موجودة.");
      const note = typeof source.note === "string" ? source.note.slice(0, 300) : null;
      const closed = await closeOrthoCaseWith(client, {
        id: caseId,
        status: source.status,
        actor: identity.username,
        note,
      });
      if (!closed.ok) throw new CanonicalOrthoRefusal("ortho_conflict", 409, closed.message);
      await insertAuditRow(client, {
        action: "ortho.case_close",
        entity: "ortho_case",
        entityId: caseId,
        details: { المريض: owner.patient_id, الحالة: source.status, ملاحظة: note },
        actor: identity.username,
        actorRole: identity.role,
      });
      return { ok: true };
    }

    throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "إجراء غير معروف.");
  });
}

const BASELINE_REFUSALS: Record<OrthoBaselineRefusal, readonly [CanonicalOrthoRefusalCode, 400 | 404 | 409, string]> = {
  no_patient: ["patient_not_found", 404, "لا يوجد مريض بهذا الرقم."],
  open_case: ["ortho_conflict", 409, "للمريض حالة تقويم مفتوحة سلفًا — اللقطة السابقة تُسجَّل لمريضٍ بلا حالة جارية."],
  bad_doctor: ["invalid_ortho_input", 400, "الطبيب المسؤول يجب أن يكون طبيبًا مسجّلًا نشطًا."],
  bad_plan: ["invalid_ortho_input", 400, "الخطة لا تخص هذا المريض."],
  bridge_conflict: ["ortho_conflict", 409, "للمريض حالة تقويم أولية (فاتورة أو علاج بدأ قبل النظام) بموضعٍ مختلف أو متعدّدة — راجعها قبل تسجيل اللقطة السابقة."],
};

export async function commandCanonicalOrthoBaseline(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ id: number }> {
  return withStaffOperation(pool, session, "clinical.ortho.edit", async (client, handle) => {
    const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
    const patientId = positiveId(source.patientId);
    if (!patientId) throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "اختر المريض أولًا.");

    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const draft = checkBaselineDraft(source, today);
    if (!draft.ok) throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, draft.message);

    const { identity, patientScope } = await lockPatientAndAssertOrthoScope(
      client,
      handle,
      "clinical.ortho.edit",
      patientId,
      "patient_not_found",
      "لا يوجد مريض بهذا الرقم.",
    );

    if (draft.value.planId !== null) {
      const granted = await staffOperationCapabilities(client, handle, "clinical.ortho.edit", ["clinical.plans.view"] as const);
      if (!granted.has("clinical.plans.view")) {
        throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "عرض خطط العلاج غير مفعّل لحسابك.");
      }
    }

    const clinicianPartyId = await staffOperationClinician(client, handle, "clinical.ortho.edit");
    const responsibleDoctorId = draft.value.responsibleDoctorId ?? clinicianPartyId ?? null;
    if (
      patientScope.kind === "own"
      && responsibleDoctorId !== null
      && responsibleDoctorId !== patientScope.clinicianPartyId
    ) {
      throw new CanonicalOrthoRefusal(
        "ortho_forbidden",
        403,
        "لا يمكن للطبيب المقيّد بنطاق مرضاه إسناد المسؤولية الأولية لطبيب آخر.",
      );
    }

    const result = await recordOrthoBaselineWith(client, {
      ...draft.value,
      responsibleDoctorId,
      patientId,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      const [code, status, message] = BASELINE_REFUSALS[result.reason];
      throw new CanonicalOrthoRefusal(code, status, message);
    }
    return { id: result.id };
  });
}

export async function commandCanonicalOrthoBillingDecision(
  session: VerifiedDurableSession,
  rawAdjustmentId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true; decision: OutsideContractDecision }> {
  const adjustmentId = positiveId(rawAdjustmentId);
  if (!adjustmentId) throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "رقم الشدّة غير صالح.");

  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  if (!isOutsideContractDecision(source.decision)) {
    throw new CanonicalOrthoRefusal("invalid_ortho_input", 400, "القرار: «فوتِرت» أو «بلا رسوم».");
  }
  const decision: OutsideContractDecision = source.decision;
  const action: StaffRuntimeAction = decision === "billed" ? "finance.invoices.create" : "clinical.ortho.edit";

  return withStaffOperation(pool, session, action, async (client, handle) => {
    const { rows: [owner] } = await client.query<{
      patient_id: number;
      responsible_doctor_id: number | null;
      visit_doctor_id: number | null;
    }>(
      `SELECT c.patient_id, c.responsible_doctor_id, v.doctor_id AS visit_doctor_id
         FROM ortho_adjustments a
         JOIN ortho_cases c ON c.id = a.case_id
         LEFT JOIN visits v ON v.id = a.visit_id
        WHERE a.id = $1`,
      [adjustmentId],
    );
    if (!owner) {
      const patientScope = await staffOperationPatientScope(client, handle, action);
      if (patientScope.kind === "none") throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
      throw new CanonicalOrthoRefusal("adjustment_not_found", 404, "الشدّة غير موجودة.");
    }

    const { rows: [lockedPatient] } = await client.query<{ id: number }>(
      `SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`,
      [owner.patient_id],
    );
    const identity = await staffOperationIdentity(client, handle, action);
    const patientScope = await staffOperationPatientScope(client, handle, action);
    if (patientScope.kind === "none") {
      throw new CanonicalOrthoRefusal("ortho_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
    }
    if (!lockedPatient) {
      throw new CanonicalOrthoRefusal("adjustment_not_found", 404, "الشدّة غير موجودة.");
    }
    if (patientScope.kind === "own") {
      const inOwnScope =
        owner.responsible_doctor_id === patientScope.clinicianPartyId
        || owner.visit_doctor_id === patientScope.clinicianPartyId
        || (await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, owner.patient_id));
      if (!inOwnScope) {
        throw new CanonicalOrthoRefusal("adjustment_not_found", 404, "الشدّة غير موجودة.");
      }
    }

    const result = await decideOrthoAdjustmentBillingWith(client, {
      adjustmentId,
      decision,
      reason: typeof source.reason === "string" ? source.reason : null,
      invoiceNumber: typeof source.invoiceNumber === "string" ? source.invoiceNumber : null,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      throw new CanonicalOrthoRefusal(
        result.status === 404 ? "adjustment_not_found" : result.status === 400 ? "invalid_ortho_input" : "ortho_conflict",
        result.status,
        result.message,
      );
    }
    return result;
  });
}
