import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { recordPlanInstallmentReminder } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canRecordPlanReminder, parsePlanReminderTarget } from "@/lib/plan-reminders";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canRecordPlanReminder(session.role)) {
    return NextResponse.json(
      { message: "إصدار تنبيهات الأقساط متاح للإدارة والاستقبال والأطباء المصرح لهم." },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const parsed = parsePlanReminderTarget(body);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: parsed.status });
  const target = parsed.target;
  try {
    // Body actor/role/party fields cannot supply authority to the transactional command.
    const result = await recordPlanInstallmentReminder({
      target,
      actor: { userId: session.userId, username: session.username, role: session.role,
        credentialVersion: session.credentialVersion },
    });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: result.status });
    return NextResponse.json(target.kind === "bulk"
      ? { success: true, updatedCount: result.updatedCount, lastReminderAt: result.lastReminderAt }
      : { success: true, planId: target.planId, installmentNumber: target.installmentNumber,
        lastReminderAt: result.lastReminderAt });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل تاريخ التذكير." }, { status: 500 });
  }
}
