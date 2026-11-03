import "server-only";
import { CLINIC_TIME_ZONE, PATIENT_CREATE_SHARED_LOCK_SQL, createPatientWith, duplicateCandidatesWith, getPatientWith, getPool, getSettingsWith, insertAuditRow, patientInDoctorScopeWith, recordContactConsentWith, updatePatientWith, type DbClient } from "./db";
import { PATIENT_AUDIT_FIELDS, auditChanges, auditSnapshot } from "./audit-diff";
import { duplicateWarning, findDuplicates, type DuplicateMatch } from "./duplicates";
import { validatePatient, type Patient, type PatientInput } from "./patient";
import { CONSENT_CHANNEL_LABEL, MANUAL_CONSENT_SOURCES, isConsentChannel, isPreferredChannel, normalizePatientEmail, normalizePatientFlags, parseFlagList, type ConsentChannel, type ConsentSource } from "./patient-identity";
import { clinicDateString } from "./schedule";
import { PATIENT_CARE_CAPABILITIES } from "./canonical-patient-reads";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";

/**
 * Canonical patient creation (M2 slice 1b, POST /api/patients).
 *
 * One admitted operation for the exact capability `patients.create` (withStaffOperation:
 * READ COMMITTED, shared identity fence, FOR SHARE proof). In that same transaction:
 *  1. the shared patient-import lock (a running import is never interleaved);
 *  2. duplicate detection against the rows as they are at that moment;
 *  3. the INSERT;
 *  4. the audit row, written atomically with the patient: no create without its audit.
 * Duplicate candidates are other patients' identities. They are disclosed only to an
 * actor whose CURRENT patient scope is `all`; any other actor gets the bounded warning
 * (how many, never who), and may still confirm the creation.
 * The previous-balance step is a finance operation outside this capability and is not
 * canonical yet (`finance.opening-balances.manage` is a proposed name), so the route
 * refuses it rather than silently dropping it.
 */
export type CanonicalPatientCreateResult =
  | { readonly kind: "created"; readonly patient: { id: number; patientNumber: string; fullName: string } }
  | { readonly kind: "duplicates"; readonly message: string; readonly duplicates: readonly DuplicateMatch[]; readonly disclosed: boolean };

export async function commandCanonicalPatientCreate(
  session: VerifiedDurableSession,
  input: PatientInput,
  confirmDuplicate: boolean,
  pool = getPool(),
): Promise<CanonicalPatientCreateResult> {
  return withStaffOperation(pool, session, "patients.create", async (client, handle) => {
    await client.query(PATIENT_CREATE_SHARED_LOCK_SQL);
    if (!confirmDuplicate) {
      const matches = findDuplicates(input, await duplicateCandidatesWith(client, input));
      if (matches.length > 0) {
        const disclosed = (await staffOperationPatientScope(client, handle, "patients.create")).kind === "all";
        return { kind: "duplicates", message: duplicateWarning(matches), duplicates: disclosed ? matches : [], disclosed };
      }
    }
    const created = await createPatientWith(client, input);
    const actor = await staffOperationIdentity(client, handle, "patients.create");
    await insertAuditRow(client, {
      action: "patient.create",
      entity: "patient", entityId: created.id, entityLabel: `${created.fullName} (${created.patientNumber})`,
      details: { ...auditSnapshot(created as unknown as Record<string, unknown>, PATIENT_AUDIT_FIELDS), تأكيد_رغم_التكرار: confirmDuplicate },
      actor: actor.username, actorRole: actor.role,
    });
    return { kind: "created", patient: { id: created.id, patientNumber: created.patientNumber, fullName: created.fullName } };
  });
}

/* ---------------------------------------------------------------------------
 * M2 slice 8: patient edit (PATCH /api/patients/[id]) and contact consent
 * (POST /api/patients/[id]/contact), both on the exact capability `patients.edit`.
 *
 * One admitted transaction each. In it: the patient row is locked and must be inside the
 * actor's CURRENT patient scope (outside reads exactly like missing: 404); the audit row
 * commits with the change. Field groups follow the read projection, so nobody writes
 * what it cannot see:
 *  - identity and contact fields: `patients.edit`;
 *  - clinical fields (medical alert, note, referral source, referred by): also one of
 *    the clinical grants (care summary);
 *  - coordination flags: the care summary or `patients.operational-summary.view`.
 * A field outside the actor's groups refuses the whole request, naming the field. Only
 * the fields sent are written, so a concurrent change to another field is never
 * overwritten with a stale value.
 * ------------------------------------------------------------------------- */
export class CanonicalPatientWriteRefusal extends Error {
  constructor(readonly code: "patient_not_found" | "patient_field_not_granted" | "invalid_patient_input", readonly status: 400 | 403 | 404, message: string, readonly field?: string) {
    super(message);
  }
}
const IDENTITY_WRITE_FIELDS = ["fullName", "phone", "altPhone", "gender", "birthYear", "birthDate", "address", "guardianName", "guardianPhone", "nationalId", "email", "preferredChannel"] as const;
const CARE_WRITE_FIELDS = ["medicalAlert", "note", "referralSource", "referredBy"] as const;
const ALL_WRITE_FIELDS = new Set<string>([...IDENTITY_WRITE_FIELDS, ...CARE_WRITE_FIELDS, "flags"]);

async function lockPatientInScope(client: DbClient, handle: StaffOperationHandle, action: "patients.edit", patientId: number): Promise<void> {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows } = await client.query("SELECT id FROM patients WHERE id = $1 FOR UPDATE", [patientId]);
  const inside = rows.length === 1 && (scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId));
  if (!inside) throw new CanonicalPatientWriteRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
}

export async function commandCanonicalPatientUpdate(session: VerifiedDurableSession, patientId: number, body: Record<string, unknown>, pool = getPool()) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, "رقم المريض غير صالح.");
  const sent = Object.keys(body).filter(key => body[key] !== undefined);
  const unknown = sent.find(key => !ALL_WRITE_FIELDS.has(key));
  if (unknown) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, "حقل غير معروف في بيانات المريض.", unknown);
  if (sent.length === 0) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, "لا يوجد ما يُحدَّث.");
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    await lockPatientInScope(client, handle, "patients.edit", patientId);
    const held = await staffOperationCapabilities(client, handle, "patients.edit", [...PATIENT_CARE_CAPABILITIES, "patients.operational-summary.view"]);
    const care = PATIENT_CARE_CAPABILITIES.some(capability => held.has(capability));
    const operational = care || held.has("patients.operational-summary.view");
    for (const field of sent) {
      if ((CARE_WRITE_FIELDS as readonly string[]).includes(field) && !care) throw new CanonicalPatientWriteRefusal("patient_field_not_granted", 403, "لا تملك صلاحية تعديل هذا الحقل السريري.", field);
      if (field === "flags" && !operational) throw new CanonicalPatientWriteRefusal("patient_field_not_granted", 403, "لا تملك صلاحية تعديل أعلام التنسيق.", field);
    }
    const current = await getPatientWith(client, patientId);
    if (!current) throw new CanonicalPatientWriteRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    // The same validation as creation, on the merged record; only sent fields are written.
    const merged = {
      fullName: body.fullName ?? current.fullName, phone: body.phone ?? current.phone ?? "", altPhone: body.altPhone ?? current.altPhone ?? "",
      gender: body.gender ?? current.gender, birthYear: body.birthYear ?? current.birthYear ?? "", address: body.address ?? current.address ?? "",
      medicalAlert: body.medicalAlert ?? current.medicalAlert ?? "", note: body.note ?? current.note ?? "",
      birthDate: body.birthDate !== undefined ? body.birthDate
        : body.birthYear !== undefined && current.birthDate && Number(current.birthDate.slice(0, 4)) !== Number(body.birthYear) ? "" : current.birthDate ?? "",
      guardianName: body.guardianName ?? current.guardianName ?? "", guardianPhone: body.guardianPhone ?? current.guardianPhone ?? "",
      nationalId: body.nationalId ?? current.nationalId ?? "", referralSource: body.referralSource ?? current.referralSource ?? "",
      referredBy: body.referredBy ?? current.referredBy ?? "",
    };
    const validation = validatePatient(merged, clinicDateString(new Date(), CLINIC_TIME_ZONE));
    if (!validation.ok) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, validation.message, validation.field);
    const input: Partial<PatientInput> & { email?: string | null; preferredChannel?: "whatsapp" | "sms" | "email" | "call" | null; flags?: string[] } = {};
    const value = validation.value as unknown as Record<string, unknown>;
    for (const field of sent) if (field in value) (input as Record<string, unknown>)[field] = value[field];
    // A birth year that no longer matches the stored full date clears that date (legacy rule).
    if (body.birthYear !== undefined && body.birthDate === undefined && merged.birthDate === "" && current.birthDate) (input as Record<string, unknown>).birthDate = value.birthDate ?? null;
    if (body.email !== undefined) {
      const email = normalizePatientEmail(body.email);
      if (!email.ok) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, email.message, "email");
      input.email = email.email;
    }
    if (body.preferredChannel !== undefined) {
      if (body.preferredChannel !== null && body.preferredChannel !== "" && !isPreferredChannel(body.preferredChannel)) {
        throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, "القناة المفضّلة: واتساب أو رسالة نصية أو بريد أو اتصال.", "preferredChannel");
      }
      input.preferredChannel = isPreferredChannel(body.preferredChannel) ? body.preferredChannel : null;
    }
    if (body.flags !== undefined) {
      const settings = await getSettingsWith(client);
      const flags = normalizePatientFlags(body.flags, parseFlagList(settings["patients.flags"]), current.flags ?? []);
      if (!flags.ok) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, flags.message, "flags");
      input.flags = flags.flags;
    }
    const updated = await updatePatientWith(client, patientId, input);
    if (!updated) throw new CanonicalPatientWriteRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    const changes = auditChanges(current as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>, PATIENT_AUDIT_FIELDS);
    if (Object.keys(changes).length > 0) {
      const actor = await staffOperationIdentity(client, handle, "patients.edit");
      await insertAuditRow(client, {
        action: "patient.update", entity: "patient", entityId: patientId, entityLabel: `${updated.fullName} (${updated.patientNumber})`,
        details: changes, actor: actor.username, actorRole: actor.role,
      });
    }
    return projectWritten(updated, care, operational);
  });
}
/** The saved record as the actor may see it (same groups as the file read). */
function projectWritten(patient: Patient, care: boolean, operational: boolean) {
  const out: Record<string, unknown> = {};
  for (const field of ["id", "patientNumber", ...IDENTITY_WRITE_FIELDS, "createdAt"] as const) out[field] = (patient as unknown as Record<string, unknown>)[field] ?? null;
  if (care) for (const field of CARE_WRITE_FIELDS) out[field] = (patient as unknown as Record<string, unknown>)[field] ?? null;
  if (operational) out.flags = patient.flags ?? [];
  return out;
}

export interface ContactConsentInput { readonly channel: ConsentChannel; readonly granted: boolean; readonly source: ConsentSource; readonly note: string | null }
export function parseContactConsentInput(body: Record<string, unknown>): ContactConsentInput {
  if (!isConsentChannel(body.channel)) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, "اختر القناة: واتساب أو رسائل نصية أو بريد.", "channel");
  if (typeof body.granted !== "boolean") throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, "حدّد: موافق أو غير موافق.", "granted");
  if (!MANUAL_CONSENT_SOURCES.includes(body.source as ConsentSource)) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, "حدّد كيف أُخذت الموافقة: في المركز، هاتفيًّا، إقرار مكتوب، أو البوابة.", "source");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) || null : null;
  return { channel: body.channel, granted: body.granted, source: body.source as ConsentSource, note };
}
export async function commandCanonicalContactConsent(session: VerifiedDurableSession, patientId: number, input: ContactConsentInput, pool = getPool()) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new CanonicalPatientWriteRefusal("invalid_patient_input", 400, "رقم المريض غير صالح.");
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    await lockPatientInScope(client, handle, "patients.edit", patientId);
    const actor = await staffOperationIdentity(client, handle, "patients.edit");
    const saved = await recordContactConsentWith(client, { patientId, ...input, actor: actor.username });
    if (!saved) throw new CanonicalPatientWriteRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    await insertAuditRow(client, {
      action: "patient.contact_consent", entity: "patient", entityId: patientId,
      details: { القناة: CONSENT_CHANNEL_LABEL[saved.channel], الموافقة: saved.granted ? "منح" : "سحب", المصدر: saved.source },
      actor: actor.username, actorRole: actor.role,
    });
    return saved;
  });
}
