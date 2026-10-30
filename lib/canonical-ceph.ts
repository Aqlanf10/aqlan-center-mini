import "server-only";
import { NextResponse } from "next/server";
import { isCephLandmarkCode, type LandmarkCode } from "./ceph";
import { chronologicalOrder, compareAnalyses, comparisonSummary } from "./cephCompare";
import { referenceLines, superimposeOnSN } from "./cephSuperimpose";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import {
  completeCephAnalysisWith,
  createCephAnalysisWith,
  discardCephAnalysisWith,
  duplicateCephAnalysisWith,
  getCephAnalysisForCompareWith,
  getCephStudyWith,
  getPool,
  insertAuditRow,
  listCephReferenceSetsWith,
  listPatientCephAnalysesWith,
  patientInDoctorScopeWith,
  updateCephCalibrationWith,
  updateCephDiagnosisWith,
  updateCephLandmarksWith,
  type CephAnalysisRow,
  type CephCalibrationInput,
  type CephPhase,
  type DbClient,
  type DbPool,
} from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
  type StaffOperationHandle,
} from "./staff-operation-runtime";

/**
 * Canonical Cephalometrics (M2 slice 30).
 *
 * Reads run inside one owning REPEATABLE READ READ ONLY snapshot (`runCanonicalReadSnapshot`):
 *  - `GET /api/ceph-reference-sets`: exact capability `clinical.xrays.view` (no patient scope).
 *  - `GET /api/patients/[id]/ceph`: registered record read `read:ceph` (`clinical.xrays.view` +
 *    patient scope); outside scope reads identically to a missing patient (`404`).
 *  - `GET /api/ceph/[id]`: registered record read `read:ceph`; study outside the actor's
 *    patient scope reads identically to a missing or discarded study (`404`).
 *  - `GET /api/ceph/compare` & `GET /api/ceph/superimpose`: registered record read `read:ceph`;
 *    BOTH analyses are checked against the actor's patient scope BEFORE cross-patient equality
 *    is checked, so an `own`-scoped clinician can never probe whether an analysis ID exists on
 *    another patient's file.
 *
 * Writes run inside `withStaffOperation` (READ COMMITTED, shared identity lifecycle fence,
 * FOR SHARE authority proof, atomic `insertAuditRow`):
 *  - `POST /api/patients/[id]/ceph`: `clinical.xrays.upload` + patient scope.
 *  - `PATCH /api/ceph/[id]`, `DELETE /api/ceph/[id]`, `POST /api/ceph/[id]/complete`,
 *    `POST /api/ceph/[id]/duplicate`: `clinical.ceph.analyze` + patient scope.
 *  - Fixed lock order `patients (FOR NO KEY UPDATE)` -> `ceph_analyses (FOR UPDATE)` matches
 *    `ortho-assessment-store.ts`, with fresh `staffOperationIdentity` + scope re-verification
 *    after acquiring the patient lock.
 */

const CEPH_SNAPSHOT_MAX_BYTES = 1024 * 1024;
const PHASES: readonly CephPhase[] = Object.freeze(["pretreatment", "during", "posttreatment", "followup"]);

export type CanonicalCephRefusalCode =
  | "invalid_ceph_input"
  | "ceph_not_found"
  | "patient_not_found"
  | "ceph_conflict";

export class CanonicalCephRefusal extends Error {
  constructor(
    readonly code: CanonicalCephRefusalCode,
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "CanonicalCephRefusal";
  }
}

export function canonicalCephFailure(error: unknown, fallback: string): NextResponse {
  if (error instanceof CanonicalCephRefusal) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  }
  return canonicalPatientReadFailure(error, fallback);
}

function positiveId(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return typeof value !== "boolean" && value !== null && value !== "" && Number.isFinite(n) ? n : null;
}

function dateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function textOrNull(value: unknown, cap: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, cap) : null;
}

/* ---------------------------------------------------------------------------
 * Canonical Reads
 * ------------------------------------------------------------------------- */

export async function readCanonicalCephReferenceSets(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(
    session,
    "clinical.xrays.view",
    async query => ({ sets: await listCephReferenceSetsWith(query) }),
    { errorPrefix: "STAFF_READ", maxBytes: CEPH_SNAPSHOT_MAX_BYTES },
  );
}

export async function readCanonicalPatientCephAnalyses(
  session: VerifiedDurableSession,
  patientId: number,
): Promise<{ analyses: CephAnalysisRow[] }> {
  return readCanonicalPatientRecord(
    session,
    "read:ceph",
    patientId,
    async query => ({ analyses: await listPatientCephAnalysesWith(query, patientId) }),
    CEPH_SNAPSHOT_MAX_BYTES,
  );
}

export async function readCanonicalCephStudy(session: VerifiedDurableSession, analysisId: number) {
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) {
    throw new CanonicalCephRefusal("invalid_ceph_input", 400, "رقم التحليل غير صالح.");
  }
  return runCanonicalReadSnapshot(
    session,
    "read:ceph",
    async (query, scope) => {
      const study = await getCephStudyWith(query, analysisId);
      if (!study) throw new CanonicalCephRefusal("ceph_not_found", 404, "التحليل غير موجود.");
      const inside = scope.patientScope.kind === "all"
        || (scope.patientScope.kind === "own"
          && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, study.analysis.patientId));
      if (!inside) throw new CanonicalCephRefusal("ceph_not_found", 404, "التحليل غير موجود.");
      return study;
    },
    { errorPrefix: "STAFF_READ", maxBytes: CEPH_SNAPSHOT_MAX_BYTES },
  );
}

function parsePairParams(params: URLSearchParams, emptyMessage: string): [number, number] {
  const first = positiveId(params.get("first"));
  const second = positiveId(params.get("second"));
  if (!first || !second) {
    throw new CanonicalCephRefusal("invalid_ceph_input", 400, emptyMessage);
  }
  if (first === second) {
    throw new CanonicalCephRefusal("invalid_ceph_input", 400, "التحليلان واحد — اختر آخر.");
  }
  return [first, second];
}

export async function readCanonicalCephCompare(session: VerifiedDurableSession, params: URLSearchParams) {
  const [first, second] = parsePairParams(params, "اختر تحليلين للمقارنة.");
  return runCanonicalReadSnapshot(
    session,
    "read:ceph",
    async (query, scope) => {
      const one = await getCephAnalysisForCompareWith(query, first);
      const two = await getCephAnalysisForCompareWith(query, second);
      if (!one || !two) {
        throw new CanonicalCephRefusal("ceph_not_found", 404, "أحد التحليلين غير موجود.");
      }
      // Scope check precedes cross-patient equality check: outside-scope IDs never reveal existence.
      const oneInside = scope.patientScope.kind === "all"
        || (scope.patientScope.kind === "own" && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, one.patientId));
      const twoInside = one.patientId === two.patientId
        ? oneInside
        : (scope.patientScope.kind === "all"
          || (scope.patientScope.kind === "own" && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, two.patientId)));
      if (!oneInside || !twoInside) {
        throw new CanonicalCephRefusal("ceph_not_found", 404, "أحد التحليلين غير موجود.");
      }
      if (one.patientId !== two.patientId) {
        throw new CanonicalCephRefusal("invalid_ceph_input", 400, "التحليلان لمريضين مختلفين.");
      }
      const [before, after] = chronologicalOrder(one, two);
      const comparison = compareAnalyses(before.measurements, after.measurements);
      return {
        before,
        after,
        comparison,
        summary: comparisonSummary(comparison),
      };
    },
    { errorPrefix: "STAFF_READ", maxBytes: CEPH_SNAPSHOT_MAX_BYTES },
  );
}

export async function readCanonicalCephSuperimpose(session: VerifiedDurableSession, params: URLSearchParams) {
  const [first, second] = parsePairParams(params, "اختر تحليلين للتراكب.");
  return runCanonicalReadSnapshot(
    session,
    "read:ceph",
    async (query, scope) => {
      const one = await getCephAnalysisForCompareWith(query, first);
      const two = await getCephAnalysisForCompareWith(query, second);
      if (!one || !two) {
        throw new CanonicalCephRefusal("ceph_not_found", 404, "أحد التحليلين غير موجود.");
      }
      const oneInside = scope.patientScope.kind === "all"
        || (scope.patientScope.kind === "own" && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, one.patientId));
      const twoInside = one.patientId === two.patientId
        ? oneInside
        : (scope.patientScope.kind === "all"
          || (scope.patientScope.kind === "own" && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, two.patientId)));
      if (!oneInside || !twoInside) {
        throw new CanonicalCephRefusal("ceph_not_found", 404, "أحد التحليلين غير موجود.");
      }
      if (one.patientId !== two.patientId) {
        throw new CanonicalCephRefusal("invalid_ceph_input", 400, "التحليلان لمريضين مختلفين.");
      }
      const [before, after] = chronologicalOrder(one, two);
      const placed = superimposeOnSN(
        { points: before.points, mmPerPixel: before.mmPerPixel },
        { points: after.points, mmPerPixel: after.mmPerPixel },
      );
      if (!placed.ok) {
        throw new CanonicalCephRefusal("ceph_conflict", 409, placed.message);
      }
      return {
        before: {
          id: before.id,
          phase: before.phase,
          xrayDate: before.xrayDate,
          documentId: before.documentId,
          documentWidth: before.documentWidth,
          documentHeight: before.documentHeight,
          lines: referenceLines(before.points),
        },
        after: {
          id: after.id,
          phase: after.phase,
          xrayDate: after.xrayDate,
          documentId: after.documentId,
          lines: referenceLines(placed.value.points),
        },
        rotationDegrees: placed.value.rotationDegrees,
        cranialBaseBefore: placed.value.cranialBaseBefore,
        cranialBaseAfter: placed.value.cranialBaseAfter,
      };
    },
    { errorPrefix: "STAFF_READ", maxBytes: CEPH_SNAPSHOT_MAX_BYTES },
  );
}

/* ---------------------------------------------------------------------------
 * Canonical Writes (Lock Order: patients FOR NO KEY UPDATE -> ceph_analyses FOR UPDATE)
 * ------------------------------------------------------------------------- */

type CephWriteAction = "clinical.xrays.upload" | "clinical.ceph.analyze";

async function lockPatientInScopeForCeph(
  client: DbClient,
  handle: StaffOperationHandle,
  action: CephWriteAction,
  patientId: number,
  notFoundCode: "patient_not_found" | "ceph_not_found",
  notFoundMessage: string,
) {
  const preScope = await staffOperationPatientScope(client, handle, action);
  if (preScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows } = await client.query<{ id: number }>(
    "SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE",
    [patientId],
  );
  // Re-assert authority and scope after waiting on the patient row lock.
  const actor = await staffOperationIdentity(client, handle, action);
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const inside = rows.length === 1
    && (scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId));
  if (!inside) throw new CanonicalCephRefusal(notFoundCode, 404, notFoundMessage);
  return actor;
}

async function lockAnalysisAndPatientForCeph(
  client: DbClient,
  handle: StaffOperationHandle,
  action: "clinical.ceph.analyze",
  analysisId: number,
) {
  const preScope = await staffOperationPatientScope(client, handle, action);
  if (preScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows: lookup } = await client.query<{ patient_id: number }>(
    "SELECT patient_id FROM ceph_analyses WHERE id = $1 AND status <> 'discarded'",
    [analysisId],
  );
  if (!lookup[0]) throw new CanonicalCephRefusal("ceph_not_found", 404, "التحليل غير موجود.");
  const actor = await lockPatientInScopeForCeph(
    client,
    handle,
    action,
    Number(lookup[0].patient_id),
    "ceph_not_found",
    "التحليل غير موجود.",
  );
  const { rows: locked } = await client.query<{ id: number }>(
    "SELECT id FROM ceph_analyses WHERE id = $1 AND status <> 'discarded' FOR UPDATE",
    [analysisId],
  );
  if (!locked[0]) throw new CanonicalCephRefusal("ceph_not_found", 404, "التحليل غير موجود.");
  return actor;
}

export async function commandCanonicalCephCreate(
  session: VerifiedDurableSession,
  patientId: number,
  body: unknown,
  pool: DbPool = getPool(),
): Promise<{ id: number; duplicateWarning: string | null }> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new CanonicalCephRefusal("invalid_ceph_input", 400, "رقم الملف غير صالح.");
  }
  return withStaffOperation(pool, session, "clinical.xrays.upload", async (client, handle) => {
    const preScope = await staffOperationPatientScope(client, handle, "clinical.xrays.upload");
    if (preScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new CanonicalCephRefusal("invalid_ceph_input", 400, "طلب غير صالح.");
    }
    const source = body as Record<string, unknown>;
    const documentId = positiveId(source.documentId);
    if (!documentId) {
      throw new CanonicalCephRefusal("invalid_ceph_input", 400, "اختر الشععة التي سيُرسم عليها.");
    }
    const phase = PHASES.includes(source.phase as CephPhase) ? (source.phase as CephPhase) : "pretreatment";
    const orthoCaseId = positiveId(source.orthoCaseId);
    const xrayDate = dateOrNull(source.xrayDate);
    const device = textOrNull(source.device, 120);
    const refSet = textOrNull(source.refSet, 60);

    const actor = await lockPatientInScopeForCeph(
      client,
      handle,
      "clinical.xrays.upload",
      patientId,
      "patient_not_found",
      "لا يوجد مريض بهذا الرقم ضمن مرضاك.",
    );

    const existing = await listPatientCephAnalysesWith(client, patientId);
    const sameDoc = existing.filter(row => row.documentId === documentId);
    const duplicateWarning = sameDoc.length > 0
      ? `للهذه الشععة ${sameDoc.length} دراسة سابقة (${sameDoc.map(row => `#${row.id}`).join("، ")}) — تابع إن كان ذلك مقصودًا.`
      : null;

    const created = await createCephAnalysisWith(client, {
      patientId,
      documentId,
      createdBy: actor.username,
      orthoCaseId,
      phase,
      xrayDate,
      device,
      refSet,
    });
    if (!created.ok) {
      throw new CanonicalCephRefusal("ceph_conflict", 409, created.message);
    }
    const freshActor = await staffOperationIdentity(client, handle, "clinical.xrays.upload");
    await insertAuditRow(client, {
      action: "ceph.create",
      entity: "ceph_analysis",
      entityId: created.id,
      entityLabel: created.auditLabel,
      actor: freshActor.username,
      actorRole: freshActor.role,
    });
    return { id: created.id, duplicateWarning };
  });
}

export async function commandCanonicalCephPatch(
  session: VerifiedDurableSession,
  analysisId: number,
  body: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) {
    throw new CanonicalCephRefusal("invalid_ceph_input", 400, "رقم التحليل غير صالح.");
  }
  return withStaffOperation(pool, session, "clinical.ceph.analyze", async (client, handle) => {
    const preScope = await staffOperationPatientScope(client, handle, "clinical.ceph.analyze");
    if (preScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new CanonicalCephRefusal("invalid_ceph_input", 400, "طلب غير صالح.");
    }
    const source = body as Record<string, unknown>;

    let parsedCalibration: CephCalibrationInput | null = null;
    if (source.calibration != null) {
      if (typeof source.calibration !== "object" || Array.isArray(source.calibration)) {
        throw new CanonicalCephRefusal("invalid_ceph_input", 400, "المعايرة تحتاج نقطتين ومسافة حقيقية بالمليمتر.");
      }
      const c = source.calibration as Record<string, unknown>;
      const x1 = finiteNumber(c.x1);
      const y1 = finiteNumber(c.y1);
      const x2 = finiteNumber(c.x2);
      const y2 = finiteNumber(c.y2);
      const mm = finiteNumber(c.mm);
      if (x1 == null || y1 == null || x2 == null || y2 == null || mm == null || mm <= 0) {
        throw new CanonicalCephRefusal("invalid_ceph_input", 400, "المعايرة تحتاج نقطتين ومسافة حقيقية بالمليمتر.");
      }
      parsedCalibration = { x1, y1, x2, y2, mm };
    }

    let parsedLandmarks: { code: LandmarkCode; x: number; y: number; source: "manual" | "suggested" }[] | null = null;
    if (source.landmarks != null) {
      if (!Array.isArray(source.landmarks)) {
        throw new CanonicalCephRefusal("invalid_ceph_input", 400, "المعالم تُرسل مصفوفة.");
      }
      parsedLandmarks = source.landmarks
        .filter((raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === "object" && !Array.isArray(raw))
        .map(raw => ({
          code: isCephLandmarkCode(raw.code) ? raw.code : null,
          x: finiteNumber(raw.x),
          y: finiteNumber(raw.y),
          source: raw.source === "suggested" ? ("suggested" as const) : ("manual" as const),
        }))
        .filter((pt): pt is { code: LandmarkCode; x: number; y: number; source: "manual" | "suggested" } =>
          pt.code != null && pt.x != null && pt.y != null);
    }

    let parsedDiagnosis: {
      skeletal: string | null;
      dental: string | null;
      softTissue: string | null;
      note: string | null;
      finalDx: string;
    } | null = null;
    if (source.diagnosis != null) {
      if (typeof source.diagnosis !== "object" || Array.isArray(source.diagnosis)) {
        throw new CanonicalCephRefusal("invalid_ceph_input", 400, "الاستنتاج السيفالومتري لا يُترك فارغًا.");
      }
      const d = source.diagnosis as Record<string, unknown>;
      if (typeof d.finalDx !== "string" || !d.finalDx.trim()) {
        throw new CanonicalCephRefusal("invalid_ceph_input", 400, "الاستنتاج السيفالومتري لا يُترك فارغًا.");
      }
      parsedDiagnosis = {
        skeletal: typeof d.skeletal === "string" ? d.skeletal : null,
        dental: typeof d.dental === "string" ? d.dental : null,
        softTissue: typeof d.softTissue === "string" ? d.softTissue : null,
        note: typeof d.note === "string" ? d.note : null,
        finalDx: d.finalDx,
      };
    }

    const actor = await lockAnalysisAndPatientForCeph(client, handle, "clinical.ceph.analyze", analysisId);
    const auditLabels: string[] = [];

    if (parsedCalibration) {
      const done = await updateCephCalibrationWith(client, analysisId, parsedCalibration);
      if (!done.ok) {
        throw new CanonicalCephRefusal(done.status === 404 ? "ceph_not_found" : "ceph_conflict", done.status, done.message);
      }
      auditLabels.push(done.auditLabel);
    }
    if (parsedLandmarks !== null) {
      const done = await updateCephLandmarksWith(client, analysisId, parsedLandmarks, actor.username);
      if (!done.ok) {
        throw new CanonicalCephRefusal(done.status === 404 ? "ceph_not_found" : "ceph_conflict", done.status, done.message);
      }
      if (done.auditLabel) auditLabels.push(done.auditLabel);
    }
    if (parsedDiagnosis) {
      const done = await updateCephDiagnosisWith(client, analysisId, parsedDiagnosis, actor.username);
      if (!done.ok) {
        throw new CanonicalCephRefusal(done.status === 404 ? "ceph_not_found" : "ceph_conflict", done.status, done.message);
      }
      auditLabels.push(done.auditLabel);
    }

    if (auditLabels.length > 0) {
      const freshActor = await staffOperationIdentity(client, handle, "clinical.ceph.analyze");
      for (const label of auditLabels) {
        await insertAuditRow(client, {
          action: "ceph.update",
          entity: "ceph_analysis",
          entityId: analysisId,
          entityLabel: label,
          actor: freshActor.username,
          actorRole: freshActor.role,
        });
      }
    }
    return { ok: true };
  });
}

export async function commandCanonicalCephDiscard(
  session: VerifiedDurableSession,
  analysisId: number,
  note: string | null,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) {
    throw new CanonicalCephRefusal("invalid_ceph_input", 400, "رقم التحليل غير صالح.");
  }
  return withStaffOperation(pool, session, "clinical.ceph.analyze", async (client, handle) => {
    await lockAnalysisAndPatientForCeph(client, handle, "clinical.ceph.analyze", analysisId);
    const done = await discardCephAnalysisWith(client, analysisId, note);
    if (!done.ok) {
      throw new CanonicalCephRefusal(done.status === 404 ? "ceph_not_found" : "ceph_conflict", done.status, done.message);
    }
    const freshActor = await staffOperationIdentity(client, handle, "clinical.ceph.analyze");
    await insertAuditRow(client, {
      action: "ceph.discard",
      entity: "ceph_analysis",
      entityId: analysisId,
      entityLabel: done.auditLabel,
      actor: freshActor.username,
      actorRole: freshActor.role,
    });
    return { ok: true };
  });
}

export async function commandCanonicalCephComplete(
  session: VerifiedDurableSession,
  analysisId: number,
  pool: DbPool = getPool(),
): Promise<{ ok: true; measurements: { code: string; value: number }[]; summary: string }> {
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) {
    throw new CanonicalCephRefusal("invalid_ceph_input", 400, "رقم التحليل غير صالح.");
  }
  return withStaffOperation(pool, session, "clinical.ceph.analyze", async (client, handle) => {
    const actor = await lockAnalysisAndPatientForCeph(client, handle, "clinical.ceph.analyze", analysisId);
    const done = await completeCephAnalysisWith(client, analysisId, actor.username);
    if (!done.ok) {
      throw new CanonicalCephRefusal(done.status === 404 ? "ceph_not_found" : "ceph_conflict", done.status, done.message);
    }
    const freshActor = await staffOperationIdentity(client, handle, "clinical.ceph.analyze");
    await insertAuditRow(client, {
      action: "ceph.complete",
      entity: "ceph_analysis",
      entityId: analysisId,
      entityLabel: done.auditLabel,
      actor: freshActor.username,
      actorRole: freshActor.role,
    });
    return {
      ok: true,
      measurements: done.measurements,
      summary: done.summary,
    };
  });
}

export async function commandCanonicalCephDuplicate(
  session: VerifiedDurableSession,
  analysisId: number,
  pool: DbPool = getPool(),
): Promise<{ id: number }> {
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) {
    throw new CanonicalCephRefusal("invalid_ceph_input", 400, "رقم التحليل غير صالح.");
  }
  return withStaffOperation(pool, session, "clinical.ceph.analyze", async (client, handle) => {
    const actor = await lockAnalysisAndPatientForCeph(client, handle, "clinical.ceph.analyze", analysisId);
    const done = await duplicateCephAnalysisWith(client, analysisId, actor.username);
    if (!done.ok) {
      throw new CanonicalCephRefusal(done.status === 404 ? "ceph_not_found" : "ceph_conflict", done.status, done.message);
    }
    const freshActor = await staffOperationIdentity(client, handle, "clinical.ceph.analyze");
    await insertAuditRow(client, {
      action: "ceph.create",
      entity: "ceph_analysis",
      entityId: done.id,
      entityLabel: done.auditLabel,
      actor: freshActor.username,
      actorRole: freshActor.role,
    });
    return { id: done.id };
  });
}
