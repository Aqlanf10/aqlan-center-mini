import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  listPayrollPeriods,
  getOrCreatePayrollPeriod,
  closePayrollPeriod,
} from "@/lib/hr-payroll";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إدارة مسير الرواتب للمدير وحده." }, { status: 403 });

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  try {
    const periods = await listPayrollPeriods();
    return NextResponse.json(periods);
  } catch (error) {
    console.error("Failed to list payroll periods:", error);
    return NextResponse.json({ message: "تعذّر تحميل فترات المسير." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    periodMonth?: string;
    action?: "open" | "close";
  };

  if (!payload.periodMonth || !/^\d{4}-\d{2}$/.test(payload.periodMonth)) {
    return NextResponse.json({ message: "صيغة الشهر يجب أن تكون YYYY-MM (مثلاً 2026-10)." }, { status: 400 });
  }

  try {
    if (payload.action === "close") {
      const period = await closePayrollPeriod(payload.periodMonth, session);
      return NextResponse.json(period);
    } else {
      const period = await getOrCreatePayrollPeriod(payload.periodMonth, session);
      return NextResponse.json(period, { status: 201 });
    }
  } catch (error: any) {
    console.error("Failed to handle payroll period:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر معالجة فترة المسير." },
      { status: 400 }
    );
  }
}
