import { NextResponse } from "next/server";
import { listStaffDirectory } from "@/lib/hr";
import { canAssignTasks } from "@/lib/hr";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "دليل الإسناد للإدارة المخولة وحدها." }, { status: 403 });

/**
 * دليل الإسناد الآمن — للمدير والاستقبال: اسمٌ ومسمًّى وقسمٌ وحسابٌ موجود؟
 * فقط. لا رواتب ولا عملات ولا شروط اتفاق: قائمة اختيار الموظفين بلا مال،
 * وusers الإدارية تبقى في مسارها المحروس.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!canAssignTasks(session.role)) return forbidden();
  try {
    return NextResponse.json(await listStaffDirectory());
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل دليل الموظفين." }, { status: 500 });
  }
}
