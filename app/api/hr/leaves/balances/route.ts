import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  listLeaveBalances,
  adjustLeaveBalance,
} from "@/lib/hr-contracts-attendance";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId");
  const yearStr = url.searchParams.get("year");
  const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

  if (!staffId) {
    return NextResponse.json({ message: "يرجى تحديد الموظف لجلب أرصدة إجازاته." }, { status: 400 });
  }

  try {
    const balances = await listLeaveBalances(staffId, year);
    return NextResponse.json(balances);
  } catch (error) {
    console.error("Failed to list balances:", error);
    return NextResponse.json({ message: "تعذّر جلب أرصدة الإجازات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) {
    return NextResponse.json({ message: "تعديل أرصدة الإجازات للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    staffId?: string;
    leaveTypeId?: string;
    year?: number;
    allocatedDays?: number;
    reason?: string;
  };

  if (!payload.staffId || !payload.leaveTypeId || payload.allocatedDays === undefined) {
    return NextResponse.json(
      { message: "يرجى تحديد الموظف ونوع الإجازة وعدد الأيام المخصصة." },
      { status: 400 }
    );
  }

  const year = payload.year || new Date().getFullYear();

  try {
    const updated = await adjustLeaveBalance(
      payload.staffId,
      payload.leaveTypeId,
      year,
      Number(payload.allocatedDays),
      payload.reason || "تعديل رصيد",
      session
    );
    return NextResponse.json(updated, { status: 201 });
  } catch (error: any) {
    console.error("Failed to adjust balance:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر تعديل الرصيد." },
      { status: 400 }
    );
  }
}
