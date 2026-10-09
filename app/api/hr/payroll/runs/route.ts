import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  listPayrollRuns,
  getPayrollRunById,
  calculatePayrollRun,
  approvePayrollRun,
} from "@/lib/hr-payroll";
import type { HrCurrency } from "@/lib/hr-payroll-shared";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إدارة مسير الرواتب للمدير وحده." }, { status: 403 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const periodId = url.searchParams.get("periodId");

  try {
    if (id) {
      const run = await getPayrollRunById(id);
      if (!run) {
        return NextResponse.json({ message: "المسير غير موجود." }, { status: 404 });
      }
      return NextResponse.json(run);
    }

    if (!periodId) {
      return NextResponse.json({ message: "يرجى تحديد فترة المسير." }, { status: 400 });
    }

    const runs = await listPayrollRuns(periodId);
    return NextResponse.json(runs);
  } catch (error) {
    console.error("Failed to get payroll runs:", error);
    return NextResponse.json({ message: "تعذّر تحميل مسيرات الرواتب." }, { status: 500 });
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
    action?: "calculate" | "approve";
    periodId?: string;
    currency?: HrCurrency;
    runId?: string;
  };

  try {
    if (payload.action === "approve") {
      if (!payload.runId) {
        return NextResponse.json({ message: "يرجى تحديد مسير الرواتب للاعتماد." }, { status: 400 });
      }
      const approved = await approvePayrollRun(payload.runId, session);
      return NextResponse.json(approved);
    } else {
      // Calculate
      if (!payload.periodId || !payload.currency) {
        return NextResponse.json(
          { message: "يرجى تحديد الفترة والعملة لحساب المسير." },
          { status: 400 }
        );
      }
      const calculated = await calculatePayrollRun(
        payload.periodId,
        payload.currency,
        session
      );
      return NextResponse.json(calculated, { status: 201 });
    }
  } catch (error: any) {
    console.error("Failed to process payroll run:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر معالجة مسير الرواتب." },
      { status: 400 }
    );
  }
}
