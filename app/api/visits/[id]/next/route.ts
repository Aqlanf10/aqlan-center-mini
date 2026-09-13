import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createNextSession, findUserByUsername, getClinicalVisit, writeAppointmentInDay } from "@/lib/db";
import { loadCapacityContext, resolveService } from "@/lib/capacity-context";
import { actorCanOverride, judgeBookingInDay } from "@/lib/book-appointment";
import { toWhatsAppNumber } from "@/lib/reminders";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * حجز الجلسة القادمة للمريض الذي انتهت زيارته للتو.
 *
 * مسار مستقل عن `POST /api/appointments` لأن مدخله مختلف: هناك يُختار مريض من سجل
 * قائم، وهنا يُشتقّ من زيارة قد تكون لمريض مشى لا سجلّ له بعد. وما يجمعهما — حارس
 * السعة — يمرّ منه الاثنان.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const visitId = Number(rawId);
  if (!Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }

  const visit = await getClinicalVisit(visitId);
  if (!visit) {
    return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
  }
  if (visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بجدولة جلسة لهذا المريض." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  const durationMinutes = Number(source.durationMinutes ?? 30);
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }

  // رقم مكتوب في الحقل يُقبل فقط إن صلح للاتصال؛ ورقم فارغ يعني الاكتفاء برقم الزيارة.
  let phone: string | null = null;
  if (typeof source.phone === "string" && source.phone.trim()) {
    phone = toWhatsAppNumber(source.phone);
    if (!phone) {
      return NextResponse.json({ message: "رقم الجوال غير صحيح. اتركه فارغًا أو صحّحه." }, { status: 400 });
    }
  }

  try {
    /* محرّك السعة نفسه وقفل اليوم نفسه: الجلسة القادمة حجزٌ يُحسب في السعة، فلا
       تفلت من الحكم ولا من القفل. */
    const capacityContext = await loadCapacityContext();
    const service = await resolveService({
      serviceId: Number(source.serviceId) > 0 ? Number(source.serviceId) : null,
      appointmentType: typeof source.appointmentType === "string" ? source.appointmentType : null,
    });
    const actorUser = await findUserByUsername(session.username).catch(() => null);
    const canOverride = actorCanOverride({
      username: session.username, role: session.role, channel: "visit",
      canOverrideCapacity: actorUser?.permissions?.canOverrideCapacity === true,
    });
    const overrideReason = typeof source.overrideReason === "string"
      ? source.overrideReason.trim().slice(0, 300) : "";
    const result = await writeAppointmentInDay({
      date,
      judge: async (sameDay, client) => {
        const judged = await judgeBookingInDay({
          sameDay, client, date, time, durationMinutes, service,
          context: capacityContext, canOverride, overrideReason,
        });
        return judged.ok
          ? { ok: true as const }
          : { ok: false as const, conflict: judged.conflict };
      },
      commit: (client) =>
        createNextSession({ visitId, date, time, durationMinutes, phone, note }, client),
    });
    if (!result.ok) {
      return NextResponse.json(result.conflict, { status: 409 });
    }
    const created = result.value;
    if (!created) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    }
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حجز الجلسة. أعد المحاولة." }, { status: 500 });
  }
}
