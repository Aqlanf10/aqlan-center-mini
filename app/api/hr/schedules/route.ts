import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  createWorkSchedule,
  listWorkSchedules,
  type CreateScheduleInput,
} from "@/lib/hr-contracts-attendance";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId") || undefined;
  const isDefaultParam = url.searchParams.get("isDefault");
  const isDefault = isDefaultParam !== null ? isDefaultParam === "true" : undefined;

  try {
    const schedules = await listWorkSchedules({ staffId, isDefault });
    return NextResponse.json(schedules);
  } catch (error) {
    console.error("Failed to list schedules:", error);
    return NextResponse.json({ message: "تعذّر تحميل جداول العمل." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) {
    return NextResponse.json({ message: "إدارة جداول العمل للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Partial<CreateScheduleInput>;
  if (!payload.name || !payload.shiftPattern || !payload.workDays) {
    return NextResponse.json(
      { message: "يرجى تحديد مسمى الجدول ونمط الوردية وأيام العمل." },
      { status: 400 }
    );
  }

  try {
    const schedule = await createWorkSchedule(payload as CreateScheduleInput, session);
    return NextResponse.json(schedule, { status: 201 });
  } catch (error: any) {
    console.error("Failed to create work schedule:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر إنشاء جدول العمل." },
      { status: 400 }
    );
  }
}
