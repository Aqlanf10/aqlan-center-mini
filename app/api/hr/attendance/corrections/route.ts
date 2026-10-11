import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  listAttendanceCorrections,
  requestAttendanceCorrection,
  decideAttendanceCorrection,
  type RequestCorrectionInput,
} from "@/lib/hr-contracts-attendance";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إدارة تصحيحات الحضور للمدير وحده." }, { status: 403 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId") || undefined;
  const status = (url.searchParams.get("status") as "pending" | "approved" | "rejected") || undefined;

  try {
    const corrections = await listAttendanceCorrections({ staffId, status });
    return NextResponse.json(corrections);
  } catch (error) {
    console.error("Failed to list corrections:", error);
    return NextResponse.json({ message: "تعذّر تحميل طلبات التصحيح." }, { status: 500 });
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

  const payload = (body ?? {}) as Record<string, any>;

  try {
    if (payload.action === "decide") {
      const { id, decision, reason } = payload as {
        id: string;
        decision: "approved" | "rejected";
        reason?: string;
      };
      if (!id || !decision) {
        return NextResponse.json({ message: "يرجى تحديد الطلب والقرار." }, { status: 400 });
      }
      const updated = await decideAttendanceCorrection(id, decision, reason ?? null, session);
      return NextResponse.json(updated);
    } else {
      // Create a correction request
      const input = payload as RequestCorrectionInput;
      if (!input.attendanceRecordId || !input.reason) {
        return NextResponse.json(
          { message: "يرجى تحديد سجل الحضور وسبب التصحيح." },
          { status: 400 }
        );
      }
      const created = await requestAttendanceCorrection(input, session);
      return NextResponse.json(created, { status: 201 });
    }
  } catch (error: any) {
    console.error("Failed to process correction:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر معالجة تصحيح الحضور." },
      { status: 400 }
    );
  }
}
