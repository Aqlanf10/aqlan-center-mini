import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { findUserByUsername, rejectBookingRequest } from "@/lib/db";
import { confirmBookingRequestThroughEngine as confirmThroughEngine, confirmBookingRequestResponse as confirmResponse } from "@/lib/booking-request-confirm";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalWaitingFailure } from "@/lib/canonical-patient-http";
import { CanonicalBookingRequestRefusal, commandCanonicalBookingRequestConfirm, commandCanonicalBookingRequestReject } from "@/lib/canonical-booking-requests";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  /* M2 slice 21: a canonical envelope confirms under appointments.create (through the
     same door below, on the admitted transaction) or rejects under appointments.cancel;
     it never falls back to the legacy session. */
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    const canonicalId = Number((await context.params).id);
    let canonicalBody: unknown;
    try { canonicalBody = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
      return NextResponse.json({ code: "invalid_booking_request", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    const canonicalSource = (canonicalBody ?? {}) as Record<string, unknown>;
    try {
      if (canonicalSource.action === "reject") return NextResponse.json(await commandCanonicalBookingRequestReject(selected.handle, canonicalId), { headers: NO_STORE });
      if (canonicalSource.action === "confirm") {
        const result = await commandCanonicalBookingRequestConfirm(selected.handle, canonicalId, ({ client, actor, audit, allowNewPatient }) =>
          confirmThroughEngine(canonicalId, canonicalSource, actor, { client, audit, allowNewPatient }));
        return confirmResponse(result, NO_STORE);
      }
      return NextResponse.json({ code: "invalid_booking_request", message: "إجراء غير معروف." }, { status: 400, headers: NO_STORE });
    } catch (error) {
      if (error instanceof CanonicalBookingRequestRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      if ((error as { code?: string }).code === "55P03") return NextResponse.json({ code: "return_booking_source_changed", message: "يجري تحديث سياق الحجز. حدّث الاقتراح وأعد المحاولة." }, { status: 409, headers: NO_STORE });
      return canonicalWaitingFailure(error, "تعذّر تنفيذ الإجراء. أعد المحاولة.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "reception") {
    return NextResponse.json({ message: "إدارة طلبات الحجز للاستقبال والإدارة." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الطلب غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const action = typeof source.action === "string" ? source.action : "";

  try {
    if (action === "reject") {
      const rejected = await rejectBookingRequest(id);
      if (!rejected) {
        return NextResponse.json({ message: "الطلب عولج سلفًا." }, { status: 409 });
      }
      return NextResponse.json(rejected);
    }

    if (action === "confirm") {
      const actorUser = await findUserByUsername(session.username).catch(() => null);
      const result = await confirmThroughEngine(id, source, {
        username: session.username, userId: session.userId, role: session.role, channel: "ui",
        canOverrideCapacity: actorUser?.permissions?.canOverrideCapacity === true,
      });
      return confirmResponse(result);
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return NextResponse.json({ code: "return_booking_source_changed", message: "يجري تحديث سياق الحجز. حدّث الاقتراح وأعد المحاولة." }, { status: 409 });
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

