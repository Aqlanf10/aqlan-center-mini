import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { openingBalanceAccess } from "@/lib/opening-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (DAY1 review) هل يضيف هذا المستخدم الرصيد السابق أو يعدّله؟ — نموذج التسجيل يسأل
 * فيُخفي الحقل حين يُطفئ المدير الإعداد، بدل أن يُرفض التسجيل كله بعد تعبئته.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const settings = await getSettings().catch(() => null);
  return NextResponse.json(
    openingBalanceAccess(session.role, settings?.["finance.reception_adds_opening_balance"] === "true"),
    { headers: { "Cache-Control": "no-store" } },
  );
}
