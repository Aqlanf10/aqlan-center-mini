import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  disbursePayrollItem,
  disburseEntireRun,
  type DisburseInput,
} from "@/lib/hr-payroll";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "صرف الرواتب والمستحقات للمدير وحده." }, { status: 403 });

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
    disburseAll?: boolean;
    runId?: string;
    itemId?: string;
    amount?: number;
    paymentMethod?: string;
    referenceNumber?: string;
    notes?: string;
    safeOrBankId?: string;
  };

  const disburseInput: DisburseInput = {
    amount: payload.amount !== undefined ? Number(payload.amount) : undefined,
    paymentMethod: payload.paymentMethod || "cash",
    referenceNumber: payload.referenceNumber || null,
    notes: payload.notes || null,
    safeOrBankId: payload.safeOrBankId || null,
  };

  try {
    if (payload.disburseAll) {
      if (!payload.runId) {
        return NextResponse.json({ message: "يرجى تحديد مسير الرواتب للصرف الجماعي." }, { status: 400 });
      }
      const disbursements = await disburseEntireRun(payload.runId, disburseInput, session);
      return NextResponse.json({ success: true, disbursements }, { status: 201 });
    } else {
      if (!payload.itemId) {
        return NextResponse.json({ message: "يرجى تحديد بند المستحق للصرف الفردي." }, { status: 400 });
      }
      const disbursement = await disbursePayrollItem(payload.itemId, disburseInput, session);
      return NextResponse.json({ success: true, disbursement }, { status: 201 });
    }
  } catch (error: any) {
    console.error("Failed to disburse payroll:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر تنفيذ عملية الصرف." },
      { status: 400 }
    );
  }
}
