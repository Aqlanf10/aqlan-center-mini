import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, listVitals, recordAudit, recordVitals } from "@/lib/db";
import { normalizeVitals } from "@/lib/medical-history";
import { clinicDateString } from "@/lib/schedule";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const patientIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const value = Number((await context.params).id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/** (PAT-2) العلامات الحيوية — سجلٌّ بتواريخه لا سطرٌ داخل نص التنبيه. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }
  try {
    return NextResponse.json({ vitals: await listVitals(patientId, 30) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل العلامات الحيوية." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId, "canEditPatient"))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const parsed = normalizeVitals(body);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });
  const source = body as Record<string, unknown>;
  const recordedDate = source.recordedAt;
  const parsedDate = typeof recordedDate === "string" ? new Date(`${recordedDate}T00:00:00Z`) : null;
  if (recordedDate !== undefined && (typeof recordedDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(recordedDate)
    || !parsedDate || !Number.isFinite(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== recordedDate
    || recordedDate < "0001-01-01"
    || recordedDate > clinicDateString(new Date(), CLINIC_TIME_ZONE))) {
    return NextResponse.json({ message: "تاريخ القياس غير صالح أو في المستقبل." }, { status: 400 });
  }
  const medicalAlert = source.medicalAlert;
  if (medicalAlert !== undefined && medicalAlert !== null
    && (typeof medicalAlert !== "string" || medicalAlert.length > 800)) {
    return NextResponse.json({ message: "التنبيه الطبي غير صالح أو طويل جدًا." }, { status: 400 });
  }
  try {
    const saved = await recordVitals(patientId, parsed.value, session.username, {
      recordedDate: recordedDate as string | undefined,
      medicalAlert: medicalAlert as string | null | undefined,
    });
    if (!saved) return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
    await recordAudit({
      action: "patient.vitals", entity: "patient", entityId: patientId,
      details: { القراءة: saved.id, الزيارة: saved.visitId },
      actor: session.username, actorRole: session.role,
    });
    // recordVitals commits this exact validated value in the same transaction;
    // it does not normalize it. Omission must not imply an alert removal.
    return NextResponse.json({ ...saved, ...(medicalAlert !== undefined ? { medicalAlert } : {}) }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ العلامات الحيوية." }, { status: 500 });
  }
}
