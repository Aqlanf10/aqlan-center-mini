import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  getWorkScheduleById,
  updateWorkSchedule,
  type UpdateScheduleInput,
} from "@/lib/hr-contracts-attendance";

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
    const schedule = await getWorkScheduleById(id);
    if (!schedule) {
      return NextResponse.json({ message: "الجدول غير موجود." }, { status: 404 });
    }
    return NextResponse.json(schedule);
  } catch (error) {
    console.error("Failed to get schedule:", error);
    return NextResponse.json({ message: "تعذّر جلب جدول العمل." }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) {
    return NextResponse.json({ message: "إدارة جداول العمل للمدير وحده." }, { status: 403 });
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as UpdateScheduleInput;

  try {
    const updated = await updateWorkSchedule(id, payload, session);
    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("Failed to update work schedule:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر تعديل جدول العمل." },
      { status: 400 }
    );
  }
}
