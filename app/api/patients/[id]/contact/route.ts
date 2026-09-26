import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettingsSafe, listContactConsents, recordAudit, recordContactConsent } from "@/lib/db";
import {
  CONSENT_CHANNEL_LABEL, MANUAL_CONSENT_SOURCES, consentStates, isConsentChannel, parseConsentMode, type ConsentSource,
} from "@/lib/patient-identity";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** تسجيل الموافقة للإدارة والاستقبال — من يتعامل مع المريض على الهاتف وفي الاستقبال. */
const RECORDERS = new Set(["admin", "reception"]);

const patientIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const value = Number((await context.params).id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/** (PAT-3) موافقات التواصل: الحالة لكل قناة، ووضع المركز، والسجل المؤرَّخ. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }
  try {
    const [history, settings] = await Promise.all([listContactConsents(patientId), getSettingsSafe()]);
    return NextResponse.json({
      mode: parseConsentMode(settings["messaging.consent_mode"]),
      states: consentStates(history),
      history,
      canRecord: RECORDERS.has(session.role),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل موافقات التواصل." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!RECORDERS.has(session.role)) {
    return NextResponse.json({ message: "تسجيل موافقة التواصل للإدارة والاستقبال." }, { status: 403 });
  }
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  if (!isConsentChannel(body.channel)) {
    return NextResponse.json({ message: "اختر القناة: واتساب أو رسائل نصية أو بريد." }, { status: 400 });
  }
  if (typeof body.granted !== "boolean") {
    return NextResponse.json({ message: "حدّد: موافق أو غير موافق." }, { status: 400 });
  }
  if (!MANUAL_CONSENT_SOURCES.includes(body.source as ConsentSource)) {
    return NextResponse.json({ message: "حدّد كيف أُخذت الموافقة: في المركز، هاتفيًّا، إقرار مكتوب، أو البوابة." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) || null : null;
  try {
    const saved = await recordContactConsent({
      patientId, channel: body.channel, granted: body.granted, source: body.source as ConsentSource,
      note, actor: session.username,
    });
    if (!saved) return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
    await recordAudit({
      action: "patient.contact_consent", entity: "patient", entityId: patientId,
      details: { القناة: CONSENT_CHANNEL_LABEL[saved.channel], الموافقة: saved.granted ? "منح" : "سحب", المصدر: saved.source },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(saved, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الموافقة." }, { status: 500 });
  }
}
