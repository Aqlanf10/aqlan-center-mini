import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import {
  listLeaveRequests,
  createLeaveRequest,
  listLeaveTypes,
  type CreateLeaveRequestInput,
} from "@/lib/hr-contracts-attendance";
import type { HrLeaveStatus } from "@/lib/hr-contracts-attendance-shared";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  const url = new URL(request.url);
  const includeTypes = url.searchParams.get("types") === "true";
  const staffId = url.searchParams.get("staffId") || undefined;
  const status = (url.searchParams.get("status") as HrLeaveStatus) || undefined;
  const startDate = url.searchParams.get("startDate") || undefined;
  const endDate = url.searchParams.get("endDate") || undefined;

  try {
    const requests = await listLeaveRequests({ staffId, status, startDate, endDate });
    if (includeTypes) {
      const types = await listLeaveTypes();
      return NextResponse.json({ requests, types });
    }
    return NextResponse.json(requests);
  } catch (error) {
    console.error("Failed to list leaves:", error);
    return NextResponse.json({ message: "تعذّر تحميل الإجازات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Partial<CreateLeaveRequestInput>;
  if (!payload.staffId || !payload.leaveTypeId || !payload.startDate || !payload.endDate) {
    return NextResponse.json(
      { message: "يرجى تحديد الموظف ونوع الإجازة وتاريخ البدء والانتهاء." },
      { status: 400 }
    );
  }

  try {
    const leave = await createLeaveRequest(payload as CreateLeaveRequestInput, session);
    return NextResponse.json(leave, { status: 201 });
  } catch (error: any) {
    console.error("Failed to create leave request:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر رفع طلب الإجازة." },
      { status: 400 }
    );
  }
}
