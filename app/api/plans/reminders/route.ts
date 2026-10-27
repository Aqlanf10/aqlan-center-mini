import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { recordPlanInstallmentReminders } from "@/lib/db";
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
    const planIds = source.planIds.filter((id) => Number.isSafeInteger(id) && Number(id) > 0 && Number(id) <= 2147483647);
    if (planIds.length === 0 || planIds.length !== source.planIds.length) {
      return NextResponse.json({ message: "حدد الخطط أولاً." }, { status: 400 });
    }

    if (planIds.length > 500) {
      return NextResponse.json({ message: "اختر 500 خطة كحد أقصى." }, { status: 400 });
    }
    try {
      const result = await recordPlanInstallmentReminders({ planIds: planIds.map(Number), bulk: true, actor: session.username, actorRole: session.role });
      return NextResponse.json({ success: true, ...result });
    } catch {
      return NextResponse.json({ message: "تعذّر تسجيل تاريخ التذكير." }, { status: 500 });
    }

  }

  // Single plan update
  const planId = Number(source.planId);
  if (!Number.isSafeInteger(planId) || planId <= 0 || planId > 2147483647) {
    return NextResponse.json({ message: "معرف الخطة غير صحيح." }, { status: 400 });
  }

  const installmentNumber = source.installmentNumber === undefined ? undefined : Number(source.installmentNumber);
  if (installmentNumber !== undefined && (!Number.isSafeInteger(installmentNumber) || installmentNumber <= 0 || installmentNumber > 2147483647)) {
    return NextResponse.json({ message: "رقم القسط غير صحيح." }, { status: 400 });
  }

  try {
    const res = await recordPlanInstallmentReminders({ planIds: [planId], installmentNumber, bulk: false, actor: session.username, actorRole: session.role });
    if (res.updatedCount === 0) {
      return NextResponse.json({ message: "الخطة أو القسط غير موجود." }, { status: 404 });
    }
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
