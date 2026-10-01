import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { recordAudit, recordPlanInstallmentReminder } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canHandleMoney } from "@/lib/roles";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  if (!canHandleMoney(session.role) && session.role !== "doctor") {
    return NextResponse.json(
      { message: "إصدار تنبيهات الأقساط متاح للإدارة والاستقبال والأطباء المصرح لهم." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;

  // Bulk update
  if (Array.isArray(source.planIds)) {
    const planIds = source.planIds.filter((id) => Number.isInteger(id) && Number(id) > 0);
    if (planIds.length === 0) {
      return NextResponse.json({ message: "حدد الخطط أولاً." }, { status: 400 });
    }

    // (TD-06) عطل القاعدة يرد برسالة عربية — كان هذا الفرع بلا معالجة فيسقط 500 بلا رسالة.
    let results: Awaited<ReturnType<typeof recordPlanInstallmentReminder>>[];
    try {
      results = await Promise.all(planIds.map((id) => recordPlanInstallmentReminder(Number(id))));
    } catch {
      return NextResponse.json({ message: "تعذّر تسجيل تاريخ التذكير." }, { status: 500 });
    }
    const lastReminderAt = results[0]?.lastReminderAt || new Date().toISOString();
    // (TD-06) من نبّه المرضى بأقساطهم — سطرٌ لكل خطةٍ موجودة فعلًا؛ المعدود هو ما حُدِّث لا ما طُلب.
    let updatedCount = 0;
    for (const [index, id] of planIds.entries()) {
      if (!results[index]?.found) continue;
      updatedCount += 1;
      await recordAudit({
        action: "plan.installment_reminder", entity: "treatment_plans", entityId: Number(id),
        details: { جماعي: true }, actor: session.username, actorRole: session.role,
      });
    }

    return NextResponse.json({
      success: true,
      updatedCount,
      lastReminderAt,
    });
  }

  // Single plan update
  const planId = Number(source.planId);
  if (!Number.isInteger(planId) || planId <= 0) {
    return NextResponse.json({ message: "معرف الخطة غير صحيح." }, { status: 400 });
  }

  const installmentNumber =
    source.installmentNumber !== undefined && Number.isInteger(Number(source.installmentNumber))
      ? Number(source.installmentNumber)
      : undefined;

  try {
    const res = await recordPlanInstallmentReminder(planId, installmentNumber);
    if (!res.found) {
      return NextResponse.json({ message: "الخطة أو القسط غير موجود." }, { status: 404 });
    }
    await recordAudit({
      action: "plan.installment_reminder", entity: "treatment_plans", entityId: planId,
      details: installmentNumber !== undefined ? { القسط: installmentNumber } : {},
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({
      success: true,
      planId,
      installmentNumber,
      lastReminderAt: res.lastReminderAt,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل تاريخ التذكير." }, { status: 500 });
  }
}
