import { NextResponse } from "next/server";
import { decideOrthoAdjustmentBilling, getPool } from "@/lib/db";
import { isOutsideContractDecision } from "@/lib/billing-classification";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canAccessPatient } from "@/lib/patient-access";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P1-C) قرار فوترة شدّة خارج العقد بعد التوقيع.
 * «بلا رسوم» للطبيب أو المدير (قرارٌ سريريّ-ماليّ مسبَّب)، و«فوتِرت» برقم فاتورةٍ قائمة للمدير والاستقبال.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const adjustmentId = Number((await context.params).id);
  if (!Number.isInteger(adjustmentId) || adjustmentId <= 0) {
    return NextResponse.json({ message: "رقم الشدّة غير صالح." }, { status: 400 });
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  if (!isOutsideContractDecision(source.decision)) {
    return NextResponse.json({ message: "القرار: «فوتِرت» أو «بلا رسوم»." }, { status: 400 });
  }
  const allowed = source.decision === "no_charge" ? ["admin", "doctor"] : ["admin", "reception"];
  if (!allowed.includes(session.role)) {
    return NextResponse.json({
      message: source.decision === "no_charge" ? "«بلا رسوم» قرار الطبيب أو المدير." : "ربط الشدّة بفاتورتها للإدارة والاستقبال.",
    }, { status: 403 });
  }
  try {
    const { rows: [owner] } = await getPool().query<{ patient_id: number; responsible_doctor_id: number | null }>(
      `SELECT c.patient_id, c.responsible_doctor_id FROM ortho_adjustments a JOIN ortho_cases c ON c.id = a.case_id WHERE a.id = $1`, [adjustmentId]);
    if (!owner) return NextResponse.json({ message: "الشدّة غير موجودة." }, { status: 404 });
    /* الطبيب المسؤول عن الحالة يقرر شدّاتها — كما تعرضها له قائمة المتابعة — ولو لم يكن طبيب الزيارة. */
    const responsible = session.role === "doctor" && typeof session.partyId === "number"
      && owner.responsible_doctor_id === session.partyId;
    if (!responsible && !(await canAccessPatient(session, owner.patient_id))) {
      return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
    }
    const result = await decideOrthoAdjustmentBilling({
      adjustmentId, decision: source.decision,
      reason: typeof source.reason === "string" ? source.reason : null,
      invoiceNumber: typeof source.invoiceNumber === "string" ? source.invoiceNumber : null,
      actor: session.username, actorRole: session.role,
    });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: result.status });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ قرار الشدّة." }, { status: 500 });
  }
}
