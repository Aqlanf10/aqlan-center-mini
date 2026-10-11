import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import {
  decideLeaveRequest,
  listLeaveRequests,
} from "@/lib/hr-contracts-attendance";
import type { HrLeaveStatus } from "@/lib/hr-contracts-attendance-shared";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();

  const { id } = await params;
  try {
    const list = await listLeaveRequests({}, session);
    const found = list.find((item) => item.id === Number(id));
    if (!found) {
      return NextResponse.json({ message: "طلب الإجازة غير موجود." }, { status: 404 });
    }
    return NextResponse.json(found);
  } catch (error) {
    console.error("Failed to get leave request:", error);
    return NextResponse.json({ message: "تعذّر جلب طلب الإجازة." }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();

  if (session.role !== "admin") return NextResponse.json({message:"قرار الإجازة للمدير وحده."},{status:403});
  const { id } = await params;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    status?: "approved" | "rejected" | "cancelled";
    decisionNotes?: string;
  };

  if (!payload.status) {
    return NextResponse.json({ message: "يرجى تحديد القرار (قبول أو رفض أو إلغاء)." }, { status: 400 });
  }

  try {
    const updated = await decideLeaveRequest(
      Number(id),
      payload.status,
      payload.decisionNotes || "تحديث حالة الإجازة",
      session
    );
    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("Failed to decide leave request:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر اتخاذ قرار بشأن الإجازة." },
      { status: 400 }
    );
  }
}
