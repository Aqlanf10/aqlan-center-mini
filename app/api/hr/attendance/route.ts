import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import {
  listAttendanceRecords,
  recordAttendancePunch,
  type AttendancePunchInput,
} from "@/lib/hr-contracts-attendance";
import type { HrAttendanceStatus } from "@/lib/hr-contracts-attendance-shared";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "admin" && session.role !== "reception") {
    return NextResponse.json({ message: "عرض الدوام والحضور وإدارته للمدير والاستقبال فقط." }, { status: 403 });
  }

  const url = new URL(request.url);
  const staffIdStr = url.searchParams.get("staffId");
  const staffId = staffIdStr ? parseInt(staffIdStr, 10) : undefined;
  const startDate = url.searchParams.get("startDate") || undefined;
  const endDate = url.searchParams.get("endDate") || undefined;
  const status = (url.searchParams.get("status") as HrAttendanceStatus) || undefined;

  try {
    const records = await listAttendanceRecords({ staffId, startDate, endDate, status });
    return NextResponse.json(records);
  } catch (error) {
    console.error("Failed to list attendance:", error);
    return NextResponse.json({ message: "تعذّر تحميل سجلات الحضور." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "admin" && session.role !== "reception") {
    return NextResponse.json({ message: "عرض الدوام والحضور وإدارته للمدير والاستقبال فقط." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Partial<AttendancePunchInput>;
  if (!payload.staffId || !payload.punchType) {
    return NextResponse.json(
      { message: "يرجى تحديد الموظف ونوع البصمة (دخول أو خروج)." },
      { status: 400 }
    );
  }

  try {
    const record = await recordAttendancePunch(
      {
        staffId: payload.staffId,
        punchType: payload.punchType,
        punchTime: payload.punchTime || new Date().toISOString(),
        source: payload.source || "manual",
        note: payload.note || null,
        ipAddress: payload.ipAddress || null,
      },
      session
    );
    return NextResponse.json(record, { status: 201 });
  } catch (error: any) {
    console.error("Failed to record punch:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر تسجيل البصمة." },
      { status: 400 }
    );
  }
}
