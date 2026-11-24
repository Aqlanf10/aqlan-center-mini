import { NextResponse } from "next/server";
import { readOperationalPatient } from "@/lib/patient-operational-read";
import { patientAppointmentsResponse } from "@/lib/patient-appointments-response";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE,
  deletePatientCascade,
  doctorOwnsPatient, patientHasVisitToday,
  findUserByUsername,
  getPatient, getPatientFile,
  getSettings,
  recordAudit,
  updatePatient,
} from "@/lib/db";
import { PATIENT_AUDIT_FIELDS, auditChanges } from "@/lib/audit-diff";
import { validatePatient, type PatientInput } from "@/lib/patient";
import { isPatientAdministrativePatchField } from "@/lib/patient-administrative-edit";
import { isPreferredChannel, normalizePatientEmail, normalizePatientFlags, parseFlagList } from "@/lib/patient-identity";
import { isAdmin } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

function readId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** عزل الطبيب (§٣٩): طبيبٌ مربوطٌ لا يفتح ملفًا ليس من مرضاه — والفحص في الخادم.
 * صلاحيات الوكيل المساعد: منحه المدير «عرض جميع المرضى» يرفع الحجب عنه. */
async function doctorBlocked(patientId: number, skipAllGrant = false): Promise<string | null> {
  const session = await requireSession();
  if (!session) return "انتهت الجلسة. سجّل الدخول من جديد.";
  /* (P0-F) المساعد السريري: ملفات مرضى زيارات اليوم وحدها. */
  if (session.role === "assistant") {
    return (await patientHasVisitToday(patientId).catch(() => false)) ? null : "المساعد السريري يرى مرضى زيارات اليوم وحدهم.";
  }
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!skipAllGrant && user?.permissions?.canViewAllPatients) return null;
    const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
    if (!doctorPartyId) {
      return "حساب الطبيب غير مرتبط بجهة سريرية معتمدة. تواصل مع إدارة المركز.";
    }
    const owns = await doctorOwnsPatient(doctorPartyId, patientId).catch(() => false);
    if (!owns) return "هذا الملف ليس من مرضاك.";
  }
  return null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const { id: rawId } = await context.params;
  const id = readId(rawId);
  if (id === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  // Patient's unrestricted dossier contains clinical and financial data.
  // Reception and other operational roles use bounded appointment/collection APIs,
  // not this full-file reader. Fail before any clinical database lookup.
  const projectionRequested = new URL(_request.url).searchParams.has("projection");
  if (!projectionRequested && session.role !== "admin" && session.role !== "doctor") {
    return NextResponse.json(
      { message: "الملف السريري الكامل متاح فقط للطبيب المخوّل والإدارة؛ استخدم واجهات المواعيد أو التحصيل المصرّح بها." },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const blocked = await doctorBlocked(id);
  if (blocked) {
    return NextResponse.json({ message: blocked }, { status: blocked.includes("جلسة") ? 401 : 403 });
  }

  // Bounded appointments projection deliberately retains its own authorization.
  const projections = new URL(_request.url).searchParams.getAll("projection");
  if (projections.length === 1 && projections[0] === "workspace") {
    if (session.role !== "reception" && session.role !== "assistant") {
      return NextResponse.json({ message: "هذا العرض مخصص للتشغيل اليومي." }, { status: 403 });
    }
    const patient = await readOperationalPatient(id, session.role);
    return NextResponse.json(patient ? { patient, visits: [], appointments: [] } : { message: "الملف غير متاح." },
      { status: patient ? 200 : 404, headers: { "Cache-Control": "private, no-store" } });
  }
  if (projectionRequested) {
    return patientAppointmentsResponse(_request, session, rawId);
  }

  try {
    const file = await getPatientFile(id);
    if (!file) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    return NextResponse.json(file, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل ملف المريض." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  // Defense in depth: the HTTP proxy also restricts PATCH, but the route must
  // never allow non-clinical accounts through if called without that proxy.
  if (!["admin", "doctor", "reception"].includes(session.role)) {
    return NextResponse.json({ message: "تعديل بيانات المريض غير مصرّح لهذا الدور." },
      { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }
  const { id: rawId } = await context.params;
  const id = readId(rawId);
  if (id === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  /* صلاحيات الوكيل المساعد: تعديل بيانات المريض بابٌ يغلقه المدير على من يشاء،
     والعزل يبقى قائمًا حتى على من أُذن له بالعرض — الرؤية شيء والكتابة شيء. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!user) return denied();
    if (user.permissions && user.permissions.canEditPatient === false) {
      return NextResponse.json(
        { message: "تعديل بيانات المرضى مخفي عنك بحسب صلاحياتك." },
        { status: 403 },
      );
    }
  }

  const blocked = await doctorBlocked(id, true);
  if (blocked) {
    return NextResponse.json({ message: blocked }, { status: blocked.includes("جلسة") ? 401 : 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const reception = session.role === "reception";
  const noStore = { "Cache-Control": "private, no-store" };
  if (reception) {
    if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(source).length) {
      return NextResponse.json({ message: "أرسل بيانات إدارية للتعديل." }, { status: 400, headers: noStore });
    }
    if (Object.keys(source).some((key) => !isPatientAdministrativePatchField(key))) {
      return NextResponse.json({ message: "هذا الحقل غير مصرح للاستقبال بتعديله." }, { status: 403, headers: noStore });
    }
  }

  // A reception edit does not need the clinical file, financial rows or documents.
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const current = reception ? await getPatient(id).catch(() => null)
    : (await getPatientFile(id).catch(() => null))?.patient ?? null;
  if (!current) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
  const provided = (key: string) => Object.hasOwn(source, key);
  const inputValue = (key: keyof PatientInput, fallback: unknown) =>
    reception && provided(key) ? source[key] : source[key] ?? fallback;

  // Existing values can support validation, but are not forwarded as receptionist writes.
  // A supplied date drives its year; a year-only update reconciles against the actual database row.
  const merged = {
    fullName: inputValue("fullName", current.fullName),
    phone: inputValue("phone", current.phone ?? ""),
    altPhone: inputValue("altPhone", current.altPhone ?? ""),
    gender: inputValue("gender", current.gender),
    birthYear: reception && provided("birthDate") && !provided("birthYear") ? "" : inputValue("birthYear", current.birthYear ?? ""),
    address: inputValue("address", current.address ?? ""),
    medicalAlert: reception ? "" : inputValue("medicalAlert", current.medicalAlert ?? ""),
    note: reception ? "" : inputValue("note", current.note ?? ""),
    birthDate: source.birthDate !== undefined
      ? source.birthDate
      : reception && provided("birthYear") ? ""
      : source.birthYear !== undefined && current.birthDate
        && Number(current.birthDate.slice(0, 4)) !== Number(source.birthYear)
        ? "" : current.birthDate ?? "",
    guardianName: inputValue("guardianName", current.guardianName ?? ""),
    guardianPhone: inputValue("guardianPhone", current.guardianPhone ?? ""),
    nationalId: reception ? "" : inputValue("nationalId", current.nationalId ?? ""),
    referralSource: inputValue("referralSource", current.referralSource ?? ""),
    referredBy: inputValue("referredBy", current.referredBy ?? ""),
  };

  const validation = validatePatient(merged, today);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message, field: validation.field }, { status: 400 });
  }

  /* (PAT-3) البريد والقناة المفضّلة والأعلام — تُحدَّث فقط إن أُرسلت. */
  const identity: { email?: string | null; preferredChannel?: "whatsapp" | "sms" | "email" | "call" | null; flags?: string[] } = {};
  if (source.email !== undefined) {
    const email = normalizePatientEmail(source.email);
    if (!email.ok) return NextResponse.json({ message: email.message, field: "email" }, { status: 400 });
    identity.email = email.email;
  }
  if (source.preferredChannel !== undefined) {
    if (source.preferredChannel !== null && source.preferredChannel !== "" && !isPreferredChannel(source.preferredChannel)) {
      return NextResponse.json({ message: "القناة المفضّلة: واتساب أو رسالة نصية أو بريد أو اتصال.", field: "preferredChannel" }, { status: 400 });
    }
    identity.preferredChannel = isPreferredChannel(source.preferredChannel) ? source.preferredChannel : null;
  }
  if (source.flags !== undefined) {
    const settings = await getSettings().catch(() => null);
    if (!settings) return NextResponse.json({ message: "تعذّر قراءة قائمة الأعلام. أعد المحاولة." }, { status: 500 });
    const flags = normalizePatientFlags(source.flags, parseFlagList(settings["patients.flags"]), current.flags ?? []);
    if (!flags.ok) return NextResponse.json({ message: flags.message, field: "flags" }, { status: 400 });
    identity.flags = flags.flags;
  }

  try {
    const validated = { ...validation.value, ...identity };
    const writes: Partial<PatientInput> = reception
      ? Object.fromEntries(Object.entries(validated).filter(([key]) => isPatientAdministrativePatchField(key)
        && (provided(key) || (key === "birthYear" && provided("birthDate") && validation.value.birthDate !== null))))
      : validated;
    const yearOnly = reception && provided("birthYear") && !provided("birthDate");
    const updated = yearOnly ? await updatePatient(id, writes, { reconcileYearOnlyBirthDate: true })
      : await updatePatient(id, writes);
    if (!updated) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    // Audit only what this request can have changed, not a concurrent clinician's update.
    const auditFields = reception
      ? Object.fromEntries(Object.entries(PATIENT_AUDIT_FIELDS)
        .filter(([key]) => Object.hasOwn(writes, key) || (yearOnly && key === "birthDate")))
      : PATIENT_AUDIT_FIELDS;
    const changes = auditChanges(
      current as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
      auditFields,
    );
    if (Object.keys(changes).length > 0) {
      await recordAudit({
        action: "patient.update",
        entity: "patient", entityId: id, entityLabel: `${updated.fullName} (${updated.patientNumber})`,
        details: changes,
        actor: session.username, actorRole: session.role,
      });
    }
    // A successful PATCH previously returned the entire updated Patient,
    // including medicalAlert, note and photoDocumentId, to reception.
    // Return an explicit administrative projection, never a spread of the row.
    const responsePatient = reception ? {
      id: updated.id, patientNumber: updated.patientNumber,
      fullName: updated.fullName, phone: updated.phone, altPhone: updated.altPhone,
      gender: updated.gender, birthYear: updated.birthYear, birthDate: updated.birthDate,
      address: updated.address, guardianName: updated.guardianName, guardianPhone: updated.guardianPhone,
      referralSource: updated.referralSource, referredBy: updated.referredBy,
      email: updated.email, preferredChannel: updated.preferredChannel,
      flags: updated.flags, createdAt: updated.createdAt,
    } : updated;
    return NextResponse.json(responsePatient, { headers: noStore });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل. أعد المحاولة." }, { status: 500 });
  }
}

/* حذف ملف المريض نهائيًا بكل سجلاته — المدير وحده: يمحو الزيارات والمواعيد
 * والفواتير والدفعات والخطط والأشعة وأعمال المعمل في معاملة واحدة، ويترك
 * صورةً كاملة في سجل التدقيق. التأكيد بالإجابة برقم الملف نفسه من الواجهة. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json(
      { message: "حذف ملفات المرضى للمدير وحده." },
      { status: 403 },
    );
  }
  const { id: rawId } = await context.params;
  const id = readId(rawId);
  if (id === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  /* عزلة الطبيب تسري حتى على العرض، فتسري على الحذف من باب أولى — لكن الحذف
   * مديريّ أصلًا، والفحص صمّام إضافي. */
  const blocked = await doctorBlocked(id, true);
  if (blocked) {
    return NextResponse.json({ message: blocked }, { status: blocked.includes("جلسة") ? 401 : 403 });
  }

  let reason: string | null = null;
  let confirmNumber: string | null = null;
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const source = (body ?? {}) as Record<string, unknown>;
    if (typeof source.reason === "string" && source.reason.trim()) {
      reason = source.reason.trim().slice(0, 300);
    }
    if (typeof source.confirmPatientNumber === "string") {
      confirmNumber = source.confirmPatientNumber.trim();
    }
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    /* الجسم فارغ — يُرفض التحذير أدناه */
  }

  /* تأكيد صارم: رقم الملف نفسه — حذف سجلٍ كامل بضغطة عابرة كارثةٌ لا تُدار. */
  const file = await getPatientFile(id).catch(() => null);
  if (!file) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
  if (confirmNumber !== file.patient.patientNumber) {
    return NextResponse.json(
      { message: "تأكيد الحذف يتطلب كتابة رقم ملف المريض نفسه." },
      { status: 400 },
    );
  }

  try {
    const result = await deletePatientCascade(id, {
      actor: session.username,
      actorRole: session.role,
      reason,
    });
    if (!result.ok) {
      if (result.reason === "has_financial_history") {
        return NextResponse.json({
          message: "هذا الملف له أثر مالي (دفعات/فواتير/رصيد افتتاحي/حركات مخزون/التزامات أعمال معمل أو صرفها) لا يجوز محوه — السجل المالي يبقى شاهدًا، والتصحيح بأحداث معاكسة، وأي محو قانوني/GDPR مستقبلًا workflow منفصل مصرَّح ومدقَّق.",
          counts: result.counts ?? {},
        }, { status: 409 });
      }
      if (result.reason === "has_clinical_history") {
        return NextResponse.json({
          message: "هذا الملف يحمل سجلًّا طبيًّا (زيارات موقّعة/أشعة ومستندات/سيفالو/تقويم/تشخيصات/وصفات/إحالات/تاريخ طبي وعلامات حيوية) يجب حفظه — لا يُحذف. الحذف متاحٌ فقط لملفٍّ سُجّل خطأً بلا سجلٍّ طبي.",
          counts: result.counts ?? {},
        }, { status: 409 });
      }
      return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    }
    return NextResponse.json({
      message: `حُذف ملف «${file.patient.fullName}» بكل سجلاته وسُجّل الحذف في التدقيق.`,
      counts: result.counts ?? {},
    });
  } catch {
    return NextResponse.json(
      { message: "تعذّر حذف الملف — أعد المحاولة أو راجع سجل التدقيق." },
      { status: 500 },
    );
  }
}
