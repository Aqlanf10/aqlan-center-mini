import { medicationDoseProvenanceProblem } from "./patient-dose-provenance";
import { MEDICATION_CATALOG_KEY, EMPTY_MEDICATION_CATALOG, parseMedicationCatalog, catalogSelectionProblem } from "./medication-catalog";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureSchema, getPool, findUserByUsername, getPrescription, savePrescription, type DbClient } from "./db";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";
import { canAccessPatient } from "./patient-access";
import { clinicalCapabilityOf } from "./clinical-identity";
import { admitPrescriptionOwnerInTransaction } from "./prescription-owner-transaction";
import type { PrescriptionDraft } from "./prescription";
import { canonicalPrescriptionCommand } from "./prescription-command";
import { withTransaction } from "./transactions";
import { warningFingerprint } from "./prescription-safety-ack";
import type { DrugSafetyAlert } from "./medication-safety";

class RollbackResponse { constructor(readonly response: NextResponse) {} }
function refuse(status: number, message: string, code = "issuance_refused"): never {
  throw new RollbackResponse(NextResponse.json({ message, code }, { status }));
}
type Receipt = { actor_user_id: number; actor_username: string; patient_id: number; visit_id: number | null; payload_sha256: string; prescription_id: number | null };
type Scope = { patientId: number; visitId: number | null; prescribingDoctorPartyId: number };
/** All downstream locks are NOWAIT: visit writers may already hold patient or
 * party rows in the opposite order. Fail/retry the SAME command, never reissue. */
async function authorize(client: DbClient, admitted: SessionPayload, scope: Scope) {
  const session = await revalidateSessionInTransaction(admitted, client);
  if (!session) refuse(403, "تغيّرت صلاحية الجلسة؛ أعد تسجيل الدخول.");
  const user = await findUserByUsername(session.username, client);
  if (!user) refuse(403, "الحساب غير نشط.");
  const capability = clinicalCapabilityOf({ role: user.role, doctorPartyId: user.partyId });
  if (!capability.ok || !capability.partyId) refuse(403, "الهوية السريرية غير صالحة.");
  const doctorIds = [...new Set([capability.partyId, scope.prescribingDoctorPartyId])].sort((a, b) => a - b);
  const { rows: doctors } = await client.query<{ id: number; kind: string; is_active: boolean; name: string }>(
    "SELECT id, kind, is_active, name FROM parties WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE NOWAIT", [doctorIds]);
  if (doctors.length !== doctorIds.length || doctors.some(doctor => doctor.kind !== "doctor" || !doctor.is_active || !doctor.name.trim())) refuse(403, "هوية الطبيب غير نشطة أو غير صالحة.");
  if (scope.prescribingDoctorPartyId !== capability.partyId) {
    const unavailable = await admitPrescriptionOwnerInTransaction({ client, session, actor: user, prescribingDoctorPartyId: scope.prescribingDoctorPartyId });
    refuse(403, unavailable.message, unavailable.code);
  }
  const ownerAuthority = null;
  if (scope.visitId !== null) {
    const { rows: visits } = await client.query<{ patient_id: number }>("SELECT patient_id FROM visits WHERE id=$1 FOR SHARE NOWAIT", [scope.visitId]);
    if (visits[0]?.patient_id !== scope.patientId) refuse(404, "الزيارة لا تطابق المريض.");
  }
  const { rows: patients } = await client.query<{ medical_alert: string | null }>("SELECT medical_alert FROM patients WHERE id=$1 FOR SHARE NOWAIT", [scope.patientId]);
  if (!patients[0]) refuse(404, "المريض غير موجود.");
  if (!await canAccessPatient(session, scope.patientId, undefined, client, "nowait")) refuse(403, "غير مصرح بالوصول إلى المريض.");
  if (session.expiresAt < Date.now()) refuse(403, "انتهت الجلسة؛ أعد تسجيل الدخول.");
  return { session, issuerId: capability.partyId, ownerAuthority, doctorName: doctors.find(doctor => doctor.id === scope.prescribingDoctorPartyId)!.name, patient: { medicalAlert: patients[0].medical_alert } };
}

export type IssuanceContext = {
  draft: PrescriptionDraft; patient: { medicalAlert: string | null };
  persist: (warnings?: DrugSafetyAlert[]) => Promise<{ id: number; createdAt: string }>;
};
/** The only API issuance transaction: reserve -> fresh authority -> replay OR
 * current safety callback -> Rx+audit+receipt -> commit. No lease or cleanup. */
export async function issuePrescriptionTransaction(input: { session: SessionPayload; key: string; draft: PrescriptionDraft }, issue: (context: IssuanceContext) => Promise<NextResponse>): Promise<NextResponse> {
  const { session, draft, key } = input;
  const fingerprint = createHash("sha256").update(JSON.stringify([1, session.userId, session.username, canonicalPrescriptionCommand(draft)])).digest("hex");
  try {
    await ensureSchema();
    return await withTransaction(getPool(), async client => {
      // Uniqueness waits for another attempt, including an uncertain COMMIT.
      await client.query(`INSERT INTO prescription_issuance_commands(command_key,actor_user_id,actor_username,patient_id,visit_id,payload_sha256)
        VALUES($1::uuid,$2,$3,$4,$5,$6) ON CONFLICT(command_key) DO NOTHING`, [key, session.userId, session.username, draft.patientId, draft.visitId, fingerprint]);
      const { rows: [receipt] } = await client.query<Receipt>("SELECT * FROM prescription_issuance_commands WHERE command_key=$1::uuid FOR UPDATE", [key]);
      // Must run AFTER the uniqueness wait, never reuse pre-wait authority.
      const authority = await authorize(client, session, { patientId: draft.patientId, visitId: draft.visitId, prescribingDoctorPartyId: draft.prescribingDoctorPartyId! });
      if (!receipt || receipt.actor_user_id !== session.userId || receipt.actor_username !== session.username || receipt.patient_id !== draft.patientId || receipt.visit_id !== draft.visitId || receipt.payload_sha256 !== fingerprint)
        refuse(409, "مفتاح الإصدار لا يطابق هذا الطلب. راجع السجل قبل بدء وصفة جديدة.", "issuance_command_conflict");
      if (receipt.prescription_id !== null) {
        const record = await getPrescription(receipt.prescription_id, client);
        if (!record || record.patientId !== draft.patientId) refuse(409, "تعذر مطابقة الإصدار المحفوظ.");
        return NextResponse.json({ id: record.id, createdAt: record.createdAt, status: record.status, replayed: true }, { status: 201 });
      }
      if (draft.items.some(item => item.selection?.catalog)) {
        const { rows } = await client.query<{ value: string }>("SELECT value FROM settings WHERE key=$1 FOR SHARE NOWAIT", [MEDICATION_CATALOG_KEY]);
        const catalog = parseMedicationCatalog(rows[0]?.value ?? EMPTY_MEDICATION_CATALOG);
        if (!catalog.ok) refuse(409, "تعذر التحقق من دليل الأدوية.", "medication_catalog_unavailable");
        const problem = catalogSelectionProblem(draft.items, catalog.value);
        if (problem) refuse(409, problem, "medication_catalog_changed");
      }
      for (const item of draft.items) {
        if (item.selection?.doseReview) {
          const problem = medicationDoseProvenanceProblem(item.selection.doseReview, item as unknown as Record<string, unknown>);
          if (problem) refuse(409, problem, "dose_review_changed");
        }
      }
      const currentDraft = { ...draft, prescribingDoctorName: authority.doctorName, ownerAuthority: authority.ownerAuthority };
      let completed = false;
      const response = await issue({ draft: currentDraft, patient: authority.patient, persist: async (warnings = []) => {
        if (completed) throw new Error("PRESCRIPTION_COMMAND_ALREADY_COMPLETED");
        if (authority.session.expiresAt < Date.now()) refuse(403, "انتهت الجلسة؛ أعد تسجيل الدخول.");
        for (const item of currentDraft.items) {
          if (item.selection?.doseReview) {
            const problem = medicationDoseProvenanceProblem(item.selection.doseReview, item as unknown as Record<string, unknown>);
            if (problem) refuse(409, problem, "dose_review_changed");
          }
        }
        const record = await savePrescription(currentDraft, authority.session.username, authority.issuerId, client);
        await client.query("UPDATE prescription_issuance_commands SET prescription_id=$2, warning_fingerprint=$3 WHERE command_key=$1::uuid", [key, record.id, warningFingerprint(warnings)]);
        completed = true;
        return record;
      } });
      if (!completed || response.status !== 201) throw new RollbackResponse(response);
      // Rx, audit and receipt writes all await I/O. Recheck expiry after those
      // waits at the final transaction boundary, so an expired issuance rolls back.
      if (authority.session.expiresAt <= Date.now()) refuse(403, "انتهت الجلسة؛ أعد تسجيل الدخول.");
      return response;
    });
  } catch (error) {
    if (error instanceof RollbackResponse) return error.response;
    const code = (error as { code?: string }).code;
    return NextResponse.json({ code: "issuance_outcome_unknown", retrySameCommand: true,
      message: code === "55P03" || code === "40P01" ? "الملف قيد التحديث؛ أعد المحاولة بمفتاح الإصدار نفسه." : "لم تتأكد نتيجة الإصدار. أعد المحاولة بالمفتاح نفسه أو تحقق من السجل؛ لا تبدأ إصدارًا جديدًا." }, { status: 503 });
  }
}

/** Refresh/lost-response recovery is read-only and never issues or prints. */
export async function recoverPrescriptionCommand(session: SessionPayload, key: string, scope: Scope): Promise<NextResponse> {
  try {
    return await withTransaction(getPool(), async client => {
      const { rows: [receipt] } = await client.query<Receipt>("SELECT * FROM prescription_issuance_commands WHERE command_key=$1::uuid FOR SHARE NOWAIT", [key]);
      await authorize(client, session, scope);
      if (!receipt) return NextResponse.json({ state: "unknown", message: "لم يتأكد الإصدار بعد؛ احتفظ بالمفتاح ولا تبدأ إصدارًا جديدًا." }, { status: 202 });
      if (receipt.actor_user_id !== session.userId || receipt.actor_username !== session.username || receipt.patient_id !== scope.patientId || receipt.visit_id !== scope.visitId)
        refuse(409, "مفتاح الإصدار لا يطابق هذا السياق.", "issuance_command_conflict");
      const record = receipt.prescription_id ? await getPrescription(receipt.prescription_id, client) : null;
      if (!record || record.prescribingDoctorPartyId !== scope.prescribingDoctorPartyId) refuse(409, "تعذر مطابقة الإصدار المحفوظ.");
      return NextResponse.json({ state: "completed", id: record.id, createdAt: record.createdAt, status: record.status }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    if (error instanceof RollbackResponse) return error.response;
    return NextResponse.json({ state: "unknown", message: "تعذر التحقق من نتيجة الإصدار؛ احتفظ بالمفتاح." }, { status: 503 });
  }
}
