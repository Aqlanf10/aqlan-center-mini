import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, getSettings } from "@/lib/db";
import { previewLegacyTreatment } from "@/lib/legacy-treatment-db";
import { LEGACY_TREATMENT_MESSAGE, parseLegacyTreatmentRequest } from "@/lib/legacy-treatment";
import { openingBalanceAccess } from "@/lib/opening-access";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (LEGACY-FIX) معاينة «علاج بدأ قبل النظام» — قراءةٌ فقط، بصلاحية الحفظ نفسها وبمحلّل طلبه وقراره (`decideLegacyTreatment`).
 *
 * كان النموذج يستعير معاينة الفاتورة العادية بسعرٍ مؤقت «1» فيرفضها فحص صلاحية السعر (400) ولا يُحفظ شيء.
 * الاتفاق التاريخي ليس فاتورة: لا سعر بيع ولا صلاحية تسعير هنا، بل المتفق والمدفوع قبل النظام والتاريخ والعملة.
 * الرفض المتوقَّع يعود 200 بسببٍ ورسالة عربية (المعاينة تحذّر؛ الحفظ يرفض فعلًا تحت الأقفال).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const settings = await getSettings().catch(() => null);
  const access = openingBalanceAccess(session.role, settings?.["finance.reception_adds_opening_balance"] === "true");
  if (!access.add) {
    return NextResponse.json({ message: "تسجيل العلاج السابق للنظام ورصيده للمدير والاستقبال المخوَّل." }, { status: 403 });
  }
  const patientId = Number((await context.params).id);
  if (!Number.isInteger(patientId) || patientId <= 0) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const parsed = parseLegacyTreatmentRequest(body as Record<string, unknown>, clinicDateString(new Date(), CLINIC_TIME_ZONE));
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });

  try {
    const result = await previewLegacyTreatment({ patientId, request: parsed.value, canEditOpening: access.edit });
    if (!result.ok) {
      if (result.reason === "no_patient") return NextResponse.json({ message: LEGACY_TREATMENT_MESSAGE.no_patient }, { status: 404 });
      return NextResponse.json({ refusal: result.reason, refusalMessage: LEGACY_TREATMENT_MESSAGE[result.reason], preview: null },
        { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ refusal: null, refusalMessage: null, replayed: result.replayed, preview: result.preview },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّرت معاينة تسجيل العلاج السابق. أعد المحاولة." }, { status: 500 });
  }
}
