import "server-only";
import { NextResponse } from "next/server";
import {
  deletePatientCascadeOn, getPool, insertAuditRow, mergeDuplicatePatientOn, patientInDoctorScopeWith, type DbClient,
} from "./db";
import { PATIENT_CARE_CAPABILITIES } from "./canonical-patient-reads";
import { projectWritten } from "./canonical-patient-writes";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import type { VerifiedDurableSession } from "./staff-durable-session";
import type { StaffCapability } from "./staff-capability-catalogue";
import {
  staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle,
} from "./staff-operation-runtime";

/**
 * Canonical patient merge and delete (M2 slice 79): POST /api/patients/[id]/merge and
 * DELETE /api/patients/[id].
 *
 * - One admitted `patients.merge` / `patients.delete` operation (the legacy admin label),
 *   with every patient involved inside the actor's patient scope; outside reads as missing.
 * - The legacy bodies run unchanged on that transaction (`mergeDuplicatePatientOn`,
 *   `deletePatientCascadeOn`): their row locks, financial and clinical guards, the
 *   all-or-nothing merge and the cascade. Their audit row — written after the commit on the
 *   legacy path — commits with the change here. A refusal rolls everything back.
 * - Money (owner rule 6615124926): a refusal for financial history says so in words; the
 *   counts of payments, invoices and other financial records are returned only to an
 *   actor holding `finance.patient-ledger.view` (or the protected owner).
 * - The merged record is returned with the file's projection (care fields by a clinical
 *   grant, coordination flags by the operational grant).
 */
export class CanonicalPatientLifecycleRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string, readonly counts?: Record<string, number>) {
    super(message);
    this.name = "CanonicalPatientLifecycleRefusal";
  }
}
const refuse = (code: string, status: 400 | 403 | 404 | 409, message: string, counts?: Record<string, number>) =>
  new CanonicalPatientLifecycleRefusal(code, status, message, counts);
const missing = (message = "لا يوجد مريض بهذا الرقم.") => refuse("patient_not_found", 404, message);

/** Counts of financial records: shown only with the ledger grant. */
const FINANCIAL_COUNT_KEYS = new Set(["payments", "invoices", "openingBalances", "inventoryMovements", "legacyTreatments", "legacyPayments", "collectionAttempts", "payables", "financialLinks"]);

function positiveId(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw refuse("invalid_patient_input", 400, "رقم المريض غير صالح.");
  return Number(raw);
}

async function inScope(client: DbClient, handle: StaffOperationHandle, action: "patients.merge" | "patients.delete", patientId: number): Promise<boolean> {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  return scope.kind === "all" || patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
}

export interface CanonicalMergeInput { duplicateNumber: string; reason: string | null }
export function parseCanonicalMerge(body: Record<string, unknown>): CanonicalMergeInput {
  const duplicateNumber = typeof body.duplicatePatientNumber === "string" ? body.duplicatePatientNumber.trim() : "";
  const confirmNumber = typeof body.confirmDuplicateNumber === "string" ? body.confirmDuplicateNumber.trim() : "";
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;
  if (!duplicateNumber) throw refuse("invalid_patient_input", 400, "اكتب رقم الملف المكرر.");
  if (confirmNumber.toUpperCase() !== duplicateNumber.toUpperCase()) throw refuse("invalid_patient_input", 400, "أعد كتابة رقم الملف المكرر نفسه للتأكيد.");
  return { duplicateNumber, reason };
}

export async function commandCanonicalPatientMerge(session: VerifiedDurableSession, rawTargetId: string, input: CanonicalMergeInput, pool = getPool()) {
  const targetId = positiveId(rawTargetId);
  try {
    return await withStaffOperation(pool, session, "patients.merge", async (client, handle) => {
      const { rows: [target] } = await client.query<{ id: number; full_name: string }>("SELECT id, full_name FROM patients WHERE id = $1", [targetId]);
      if (!target || !await inScope(client, handle, "patients.merge", targetId)) throw missing();
      const { rows: [source] } = await client.query<{ id: number }>("SELECT id FROM patients WHERE UPPER(patient_number) = UPPER($1) LIMIT 1", [input.duplicateNumber]);
      if (!source || !await inScope(client, handle, "patients.merge", source.id)) throw missing("لا يوجد ملف بهذا الرقم.");
      const identity = await staffOperationIdentity(client, handle, "patients.merge");
      const held = await staffOperationCapabilities(client, handle, "patients.merge", [...PATIENT_CARE_CAPABILITIES, "patients.operational-summary.view", "finance.patient-ledger.view"] as StaffCapability[]);
      const result = await mergeDuplicatePatientOn(client, source.id, targetId, { actor: identity.username, actorRole: identity.role, reason: input.reason });
      if (!result.ok) {
        if (result.reason === "same_patient") throw refuse("merge_same_patient", 400, "لا يُدمج الملف في نفسه.");
        if (result.reason === "not_found") throw missing("لا يوجد ملف بهذا الرقم.");
        if (result.reason === "source_has_financial_history") {
          throw refuse("merge_source_has_financial_history", 409,
            "الملف المكرر له أثر مالي (دفعات أو حركات مخزون أو رصيد افتتاحي أو سجل مالي سابق، ولو كان مسدّدًا بالكامل). لا يمكن نقل هذه السجلات بالدمج. راجع الملفين واختيار الملف الأساسي قبل المحاولة.",
            held.has("finance.patient-ledger.view") ? result.counts : undefined);
        }
        throw refuse("merge_conflict", 409, "تعارضٌ يمنع الدمج (سجلٌّ لا يتكرر لكل مريض موجودٌ في الملفين). لم يُغيَّر شيء.");
      }
      await insertAuditRow(client, result.audit);
      const care = PATIENT_CARE_CAPABILITIES.some(capability => held.has(capability));
      const operational = care || held.has("patients.operational-summary.view");
      return {
        message: `دُمج الملف ${input.duplicateNumber} في ملف «${target.full_name}» وحُذف المكرر.`,
        moved: result.moved,
        patient: projectWritten(result.target, care, operational),
      };
    });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "23505" || code === "23P01") throw refuse("merge_conflict", 409, "تعارضٌ يمنع الدمج (سجلٌّ لا يتكرر لكل مريض موجودٌ في الملفين). لم يُغيَّر شيء.");
    throw error;
  }
}

export interface CanonicalDeleteInput { confirmNumber: string | null; reason: string | null }
export function parseCanonicalDelete(body: Record<string, unknown>): CanonicalDeleteInput {
  return {
    reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : null,
    confirmNumber: typeof body.confirmPatientNumber === "string" ? body.confirmPatientNumber.trim() : null,
  };
}

export async function commandCanonicalPatientDelete(session: VerifiedDurableSession, rawPatientId: string, input: CanonicalDeleteInput, pool = getPool()) {
  const patientId = positiveId(rawPatientId);
  return withStaffOperation(pool, session, "patients.delete", async (client, handle) => {
    if (!await inScope(client, handle, "patients.delete", patientId)) throw missing();
    // The body's own first lock; the confirmation is checked on the locked row.
    const { rows: [patient] } = await client.query<{ patient_number: string; full_name: string }>(
      "SELECT patient_number, full_name FROM patients WHERE id = $1 FOR UPDATE", [patientId]);
    if (!patient) throw missing();
    if (input.confirmNumber !== patient.patient_number) throw refuse("invalid_patient_input", 400, "تأكيد الحذف يتطلب كتابة رقم ملف المريض نفسه.");
    const identity = await staffOperationIdentity(client, handle, "patients.delete");
    const held = await staffOperationCapabilities(client, handle, "patients.delete", ["finance.patient-ledger.view"] as const);
    const result = await deletePatientCascadeOn(client, patientId, { actor: identity.username, actorRole: identity.role, reason: input.reason });
    if (!result.ok) {
      if (result.reason === "not_found") throw missing();
      const ledger = held.has("finance.patient-ledger.view");
      if (result.reason === "has_financial_history") {
        throw refuse("delete_has_financial_history", 409,
          "هذا الملف له أثر مالي (دفعات/فواتير/رصيد افتتاحي/حركات مخزون/التزامات أعمال معمل أو صرفها) لا يجوز محوه — السجل المالي يبقى شاهدًا، والتصحيح بأحداث معاكسة، وأي محو قانوني مستقبلًا مسارٌ منفصل مصرَّح ومدقَّق.",
          ledger ? result.counts : undefined);
      }
      const counts = Object.fromEntries(Object.entries(result.counts ?? {}).filter(([key]) => ledger || !FINANCIAL_COUNT_KEYS.has(key)));
      throw refuse("delete_has_clinical_history", 409,
        "هذا الملف يحمل سجلًّا طبيًّا (زيارات موقّعة/أشعة ومستندات/سيفالو/تقويم/تشخيصات/وصفات/إحالات/تاريخ طبي وعلامات حيوية) يجب حفظه — لا يُحذف. الحذف متاحٌ فقط لملفٍّ سُجّل خطأً بلا سجلٍّ طبي.",
        counts);
    }
    await insertAuditRow(client, result.audit);
    const details = result.audit.details as { counts?: Record<string, number> } | undefined;
    const counts = Object.fromEntries(Object.entries(details?.counts ?? {}).filter(([key]) => held.has("finance.patient-ledger.view") || !FINANCIAL_COUNT_KEYS.has(key)));
    return { message: `حُذف ملف «${patient.full_name}» بكل سجلاته وسُجّل الحذف في التدقيق.`, counts };
  });
}

/** The canonical branch of the merge/delete routes (null for a legacy envelope). */
export async function canonicalPatientLifecycleRoute(
  request: Request,
  run: (handle: VerifiedDurableSession, body: Record<string, unknown>) => Promise<unknown>,
  fallback: string,
  options: { emptyBody?: boolean } = {},
): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  let body: Record<string, unknown> = {};
  try {
    const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    // An empty DELETE body is answered by the confirmation check, as on the legacy path.
    if (!options.emptyBody) return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await run(selected.handle, body), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalPatientLifecycleRefusal) {
      return NextResponse.json({ code: error.code, message: error.message, ...(error.counts ? { counts: error.counts } : {}) }, { status: error.status, headers: NO_STORE });
    }
    return canonicalPatientReadFailure(error, fallback);
  }
}
