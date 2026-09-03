import { NextResponse } from "next/server";
import { recordPlanInstallmentReminder } from "@/lib/db";
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
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;

  // Bulk update
  if (Array.isArray(source.planIds)) {
    const planIds = source.planIds.filter((id) => Number.isInteger(id) && Number(id) > 0);
    if (planIds.length === 0) {
      return NextResponse.json({ message: "حدد الخطط أولاً." }, { status: 400 });
    }

    const results = await Promise.all(
      planIds.map((id) => recordPlanInstallmentReminder(Number(id))),
    );
    const lastReminderAt = results[0]?.lastReminderAt || new Date().toISOString();

    return NextResponse.json({
      success: true,
      updatedCount: planIds.length,
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
