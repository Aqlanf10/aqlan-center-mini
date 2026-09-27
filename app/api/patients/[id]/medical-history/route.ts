import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, getSettings, listMedicalHistory, listVitals, recordAudit, saveMedicalHistory } from "@/lib/db";
import { deriveAlerts, normalizeMedicalHistory, reviewDue } from "@/lib/medical-history";
import { canAccessPatient } from "@/lib/patient-access";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const patientIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const value = Number((await context.params).id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * (PAT-2) التاريخ الطبي المنظَّم: آخر نسخة وتنبيهاتها، ونسخٌ سابقة، وهل حان وقت المراجعة،
 * وآخر العلامات الحيوية. للطبيب (مرضاه) والاستقبال والمدير — لا للأدوار المالية.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }
  try {
    const [versions, vitals, settings] = await Promise.all([
      listMedicalHistory(patientId), listVitals(patientId), getSettings().catch(() => null),
    ]);
    const latest = versions[0] ?? null;
    const months = Number(settings?.["clinical.medical_history_review_months"]) || 6;
    return NextResponse.json({
      latest,
      versions: versions.map((version) => ({ id: version.id, recordedAt: version.recordedAt, recordedBy: version.recordedBy })),
      alerts: latest ? deriveAlerts(latest) : [],
      review: reviewDue(latest?.recordedAt ?? null, months, clinicDateString(new Date(), CLINIC_TIME_ZONE)),
      vitals,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل التاريخ الطبي." }, { status: 500 });
  }
}

/** نسخةٌ جديدة من التاريخ الطبي — لا يُعدَّل ما قبلها. */
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
  const parsed = normalizeMedicalHistory(body);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });
  try {
    const saved = await saveMedicalHistory(patientId, parsed.value, session.username);
    if (!saved) return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
    await recordAudit({
      action: "patient.medical_history", entity: "patient", entityId: patientId,
      details: {
        النسخة: saved.id,
        الحساسية: saved.allergies.length,
        الأدوية: saved.medications.length,
        التنبيهات: deriveAlerts(saved).map((alert) => alert.label),
        تأكيد_المريض: saved.patientConfirmed,
      },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(saved, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التاريخ الطبي." }, { status: 500 });
  }
}
