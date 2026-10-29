import { NextResponse } from "next/server";
import { listBookingRequests } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalWaitingFailure } from "@/lib/canonical-patient-http";
import { CanonicalBookingRequestRefusal, parseBookingRequestStatus, readCanonicalBookingRequests } from "@/lib/canonical-booking-requests";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // M2 slice 21: a canonical envelope reads the queue in one owning snapshot
  // (appointments.create and the whole appointment scope); it never falls back.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      return NextResponse.json(await readCanonicalBookingRequests(selected.handle, parseBookingRequestStatus(new URL(request.url).searchParams.get("status"))), { headers: NO_STORE });
    } catch (error) {
      if (error instanceof CanonicalBookingRequestRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalWaitingFailure(error, "تعذّر تحميل الطلبات.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "reception") {
    return NextResponse.json({ message: "عرض طلبات الحجز للاستقبال والإدارة." }, { status: 403 });
  }
  const status = new URL(request.url).searchParams.get("status") ?? "new";
  if (status !== "new" && status !== "confirmed" && status !== "rejected") {
    return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listBookingRequests(status));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الطلبات." }, { status: 500 });
  }
}
