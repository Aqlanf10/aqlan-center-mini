import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import {
  listLeaveRequests,
  createLeaveRequest,
  listLeaveTypes,
  leaveStaffOptions,
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
  const staffIdStr = url.searchParams.get("staffId");
  const staffId = staffIdStr ? parseInt(staffIdStr, 10) : undefined;
  const status = (url.searchParams.get("status") as any) || undefined;
  const startDate = url.searchParams.get("startDate") || undefined;
  const endDate = url.searchParams.get("endDate") || undefined;

  try {
    const requests = await listLeaveRequests({ staffId, status, startDate, endDate }, session);
    if (includeTypes) {
      const types = await listLeaveTypes();
      return NextResponse.json({ requests, types, staff: await leaveStaffOptions(session) });
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

  const payload = (body ?? {}) as Record<string, any>;
  const leaveTypeCode = payload.leaveTypeCode || payload.leaveTypeId;
  if (!payload.staffId || !leaveTypeCode || !payload.startDate || !payload.endDate) {
    return NextResponse.json(
      { message: "يرجى تحديد الموظف ونوع الإجازة وتاريخ البدء والانتهاء." },
      { status: 400 }
    );
  }

  try {
    const start = new Date(payload.startDate);
    const end = new Date(payload.endDate);
    const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const daysCount = payload.daysCount ? Number(payload.daysCount) : diffDays;

    const input: CreateLeaveRequestInput = {
      staffId: Number(payload.staffId),
      leaveTypeCode,
      startDate: String(payload.startDate),
      endDate: String(payload.endDate),
      daysCount,
      reason: String(payload.reason || "طلب إجازة"),
      isPartialDay: Boolean(payload.isPartialDay),
      partialHours: payload.partialHours ? Number(payload.partialHours) : null,
      attachmentRefs: payload.attachmentRefs || [],
    };
    const leave = await createLeaveRequest(input, session);
    return NextResponse.json(leave, { status: 201 });
  } catch (error: any) {
    console.error("Failed to create leave request:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر رفع طلب الإجازة." },
      { status: 400 }
    );
  }
}
