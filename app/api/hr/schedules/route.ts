import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString } from "@/lib/schedule";
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

  const raw = (body ?? {}) as {
    staffId?: string | number | null;
    department?: string | null;
    name?: string;
    scheduleType?: string;
    shiftPattern?: string;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    workingDays?: number[];
    workDays?: number[];
    shiftStartTime?: string;
    shiftEndTime?: string;
    secondShiftStart?: string | null;
    secondShiftEnd?: string | null;
    gracePeriodMins?: number;
    expectedDailyHours?: number;
    crossesMidnight?: boolean;
  };

  if (!raw.name) {
    return NextResponse.json(
      { message: "يرجى تحديد مسمى الجدول." },
      { status: 400 }
    );
  }

  const scheduleInput: CreateScheduleInput = {
    staffId: raw.staffId ? Number(raw.staffId) : null,
    department: raw.department || null,
    name: String(raw.name).trim(),
    scheduleType: (raw.scheduleType || raw.shiftPattern || "morning") as any,
    effectiveFrom: raw.effectiveFrom || clinicDateString(new Date(), CLINIC_ZONE_FALLBACK),
    effectiveTo: raw.effectiveTo || null,
    workingDays: Array.isArray(raw.workingDays)
      ? raw.workingDays
      : Array.isArray(raw.workDays)
      ? raw.workDays
      : [0, 1, 2, 3, 4, 6],
    shiftStartTime: raw.shiftStartTime || "09:00",
    shiftEndTime: raw.shiftEndTime || "17:00",
    secondShiftStart: raw.secondShiftStart || null,
    secondShiftEnd: raw.secondShiftEnd || null,
    gracePeriodMins: raw.gracePeriodMins !== undefined ? Number(raw.gracePeriodMins) : 15,
    expectedDailyHours: raw.expectedDailyHours !== undefined ? Number(raw.expectedDailyHours) : 8,
    crossesMidnight: Boolean(raw.crossesMidnight),
  };

  try {
    const schedule = await createWorkSchedule(scheduleInput, session);
    return NextResponse.json(schedule, { status: 201 });
  } catch (error: any) {
    console.error("Failed to create work schedule:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر إنشاء جدول العمل." },
      { status: 400 }
    );
  }
}
