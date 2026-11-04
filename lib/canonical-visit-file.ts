import "server-only";
import { NextResponse } from "next/server";
import { deleteVisitOn, getPool, insertAuditRow, linkVisitToPatientOn, openVisitPatientFileOn, patientInDoctorScopeWith, type DbClient } from "./db";
import { NO_STORE, canonicalVisitFailure } from "./canonical-patient-http";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle,
} from "./staff-operation-runtime";

/**
 * Canonical visit ↔ file actions (M2 slice 81): PATCH /api/visits/[id] `link` and
 * `open_file`, and DELETE /api/visits/[id].
 *
 * - `link` (a walk-in visit to an existing file): one admitted `visits.manage`
 *   transaction; the visit inside the scope (the queue read's condition) and the target
 *   file inside the patient scope — a walk-in never opens a door to a guarded file.
 *   `linkVisitToPatientOn` is the legacy body (signed visits, chart and lab links refuse);
 *   the canonical path writes a `visit.link` audit row (the legacy path wrote none).
 * - `open_file`: `visits.manage` plus `patients.create` (it may create a file);
 *   `openVisitPatientFileOn` is the legacy body (a matching phone links the existing file,
 *   otherwise a new file). A matched file outside the actor's scope is refused and rolled
 *   back without naming it. A created file writes `patient.create` in the same transaction.
 * - DELETE: `visits.delete` (the legacy admin label); `deleteVisitOn` (signed, invoiced and
 *   lab-linked visits refuse); `visit.delete` in the same transaction.
 * - Outside the scope reads as missing (404). Deferring payment stays with the financial
 *   group (refused here, 409).
 */
export class CanonicalVisitFileRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "CanonicalVisitFileRefusal";
  }
}
const VISIT_MISSING = "لا توجد زيارة بهذا الرقم ضمن مرضاك.";
const refuse = (code: string, status: 400 | 403 | 404 | 409, message: string) => new CanonicalVisitFileRefusal(code, status, message);

async function scopeOf(client: DbClient, handle: StaffOperationHandle, action: "visits.manage" | "visits.delete") {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  return scope;
}
async function requireVisit(client: DbClient, handle: StaffOperationHandle, action: "visits.manage" | "visits.delete", visitId: number) {
  const scope = await scopeOf(client, handle, action);
  const { rows: [visit] } = await client.query<{ patient_id: number | null; doctor_id: number | null }>("SELECT patient_id, doctor_id FROM visits WHERE id = $1", [visitId]);
  const inside = visit !== undefined && (scope.kind === "all" || visit.doctor_id === scope.clinicianPartyId
    || (visit.patient_id !== null && await patientInDoctorScopeWith(client, scope.clinicianPartyId, visit.patient_id)));
  if (!inside) throw refuse("visit_not_found", 404, VISIT_MISSING);
  return { scope, previousPatientId: visit!.patient_id };
}
async function patientInside(client: DbClient, scope: Awaited<ReturnType<typeof scopeOf>>, patientId: number) {
  return scope.kind === "all" || patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
}
const visitIdOf = (raw: string) => {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw refuse("invalid_visit_input", 400, "رقم الزيارة غير صالح.");
  return Number(raw);
};

export async function commandCanonicalVisitLink(session: VerifiedDurableSession, rawVisitId: string, rawPatientId: unknown, pool = getPool()) {
  const visitId = visitIdOf(rawVisitId);
  const patientId = Number(rawPatientId);
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || patientId > 2147483647) throw refuse("invalid_visit_input", 400, "رقم الملف غير صالح.");
  return withStaffOperation(pool, session, "visits.manage", async (client, handle) => {
    const { scope, previousPatientId } = await requireVisit(client, handle, "visits.manage", visitId);
    const { rows } = await client.query("SELECT 1 FROM patients WHERE id = $1", [patientId]);
    if (rows.length !== 1 || !await patientInside(client, scope, patientId)) throw refuse("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    const linked = await linkVisitToPatientOn(client, visitId, patientId);
    if (!linked.ok) throw refuse("visit_link_refused", 409, linked.message);
    const identity = await staffOperationIdentity(client, handle, "visits.manage");
    await insertAuditRow(client, {
      action: "visit.link", entity: "visit", entityId: visitId, entityLabel: linked.patientName,
      details: { المريض: patientId, السابق: previousPatientId ?? "—" }, actor: identity.username, actorRole: identity.role,
    });
    return { ok: true as const, patientName: linked.patientName };
  });
}

export async function commandCanonicalVisitOpenFile(session: VerifiedDurableSession, rawVisitId: string, pool = getPool()) {
  const visitId = visitIdOf(rawVisitId);
  return withStaffOperation(pool, session, "visits.manage", async (client, handle) => {
    const held = await staffOperationCapabilities(client, handle, "visits.manage", ["patients.create"] as const);
    if (!held.has("patients.create")) throw refuse("visit_open_file_denied", 403, "فتح ملف من الزيارة يتطلب صلاحية إنشاء ملفات المرضى.");
    const { scope } = await requireVisit(client, handle, "visits.manage", visitId);
    // The matched file is checked before the visit is linked: the link must never be its own
    // scope witness (an assigned visit would otherwise bring the file into a clinician's scope).
    const opened = await openVisitPatientFileOn(client, visitId, async patientId => {
      if (patientId !== null && !await patientInside(client, scope, patientId)) {
        throw refuse("visit_open_file_outside_scope", 409, "تعذّر فتح الملف من هذه الزيارة ضمن نطاقك. اطلب من المسؤول ربطها.");
      }
    });
    if (!opened.ok) {
      if (opened.reason === "signed") throw refuse("visit_signed", 409, "الزيارة موقَّعة — ملفّها فُتح عند توقيعها.");
      throw refuse("visit_not_found", 404, VISIT_MISSING);
    }
    const identity = await staffOperationIdentity(client, handle, "visits.manage");
    if (opened.created) {
      await insertAuditRow(client, {
        action: "patient.create", entity: "patient", entityId: opened.patientId,
        details: { المصدر: "زيارة سريرية", الزيارة: visitId }, actor: identity.username, actorRole: identity.role,
      });
    }
    return { ok: true as const, patientId: opened.patientId, created: opened.created };
  });
}

export async function commandCanonicalVisitDelete(session: VerifiedDurableSession, rawVisitId: string, reason: string | null, pool = getPool()) {
  const visitId = visitIdOf(rawVisitId);
  return withStaffOperation(pool, session, "visits.delete", async (client, handle) => {
    await requireVisit(client, handle, "visits.delete", visitId);
    const identity = await staffOperationIdentity(client, handle, "visits.delete");
    const result = await deleteVisitOn(client, visitId, { actor: identity.username, actorRole: identity.role, reason });
    if (!result.ok) {
      if (result.reason === "lab_linked") throw refuse("visit_lab_linked", 409, "هذه الزيارة مرتبطة بهوية مختبر دائمة؛ لا تُحذف دون معالجة سريرية صريحة للروابط.");
      if (result.reason === "signed") throw refuse("visit_signed", 409, "الزيارة موقّعة سريريًا — وثّقت عمل الطبيب ولا تُمحى.");
      if (result.reason === "invoiced") throw refuse("visit_invoiced", 409, "الزيارة مفوترة — دخلت الدفاتر ولا تُمحى. ألغِ الفاتورة أولًا إن كان ذلك الصحيح.");
      throw refuse("visit_not_found", 404, VISIT_MISSING);
    }
    await insertAuditRow(client, result.audit);
    return { message: "حُذفت الزيارة وسُجِّل الحذف في التدقيق." };
  });
}

/** Maps a refusal of this module, else the shared visit failure. */
export function canonicalVisitFileFailure(error: unknown, fallback: string): NextResponse {
  if (error instanceof CanonicalVisitFileRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  return canonicalVisitFailure(error, fallback);
}
