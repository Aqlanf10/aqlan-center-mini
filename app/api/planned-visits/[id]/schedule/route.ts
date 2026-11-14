import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { ensureSchema, findUserByUsername, getPool } from "@/lib/db";
import { plannedVisitScheduleResponse, schedulePlannedVisitThroughEngine } from "@/lib/planned-visit-schedule";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalWaitingFailure } from "@/lib/canonical-patient-http";
import { CanonicalPlannedVisitRefusal, commandCanonicalPlannedVisitSchedule } from "@/lib/canonical-planned-visits";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

/**
 * تحويل الزيارة المخطَّطة موعدًا — بتاريخٍ ووقت فقط (المواصفة §١١).
 *
 * سبب الموعد والعلاج والمدة والطبيب كلها في الزيارة المخطَّطة أصلًا؛ إعادة إدخالها
 * موعدًا مستقلًّا هو ما يجعل الاتفاق يُكتب مرتين فيخالف إحداهما الأخرى يوم الخلاف.
 * والكتابة تمرّ من قفل اليوم الذرّي نفسه الذي يمرّ عليه كل حجز.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  /* M2 slice 22: a canonical envelope schedules under appointments.create through the
     same door, on the admitted transaction; it never falls back to the legacy session. */
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    const canonicalId = Number((await context.params).id);
    let canonicalBody: unknown;
    try { canonicalBody = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
      return NextResponse.json({ code: "invalid_planned_visit", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    const canonicalSource = (canonicalBody ?? {}) as Record<string, unknown>;
    try {
      const result = await commandCanonicalPlannedVisitSchedule(selected.handle, canonicalId, ({ client, patientId, actor, audit }) =>
        schedulePlannedVisitThroughEngine(canonicalId, patientId, canonicalSource, actor, { client, audit }));
      return plannedVisitScheduleResponse(result, NO_STORE);
    } catch (error) {
      if (error instanceof CanonicalPlannedVisitRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      if ((error as { code?: string }).code === "55P03") return NextResponse.json({ code: "return_booking_source_changed", message: "يجري تحديث المسؤول عن الحالة. حدّث الاقتراح وأعد المحاولة." }, { status: 409, headers: NO_STORE });
      return canonicalWaitingFailure(error, "تعذّر حجز الجلسة. أعد المحاولة.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  const { id } = await context.params;
  const plannedVisitId = Number(id);
  if (!Number.isInteger(plannedVisitId) || plannedVisitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة المخطَّطة غير صالح." }, { status: 400 });
  }

  await ensureSchema();
  const { rows } = await getPool().query<{ patient_id: number }>(
    "SELECT patient_id FROM planned_visits WHERE id = $1",
    [plannedVisitId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ message: "الزيارة المخطَّطة غير موجودة." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, rows[0].patient_id))) {
    return NextResponse.json({ message: "غير مصرّح لك بجدولة جلسة لهذا المريض." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "التاريخ غير صالح." }, { status: 400 });
  }
  if (!TIME_PATTERN.test(time)) {
    return NextResponse.json({ message: "الوقت غير صالح." }, { status: 400 });
  }

  try {
    const actorUser = await findUserByUsername(session.username).catch(() => null);
    const result = await schedulePlannedVisitThroughEngine(plannedVisitId, rows[0].patient_id, source, {
      username: session.username, userId: session.userId, role: session.role, channel: "visit",
      canOverrideCapacity: actorUser?.permissions?.canOverrideCapacity === true,
    });
    return plannedVisitScheduleResponse(result);
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return NextResponse.json({ code: "return_booking_source_changed", message: "يجري تحديث المسؤول عن الحالة. حدّث الاقتراح وأعد المحاولة." }, { status: 409 });
    return NextResponse.json({ message: "تعذّر حجز الجلسة. أعد المحاولة." }, { status: 500 });
  }
}
