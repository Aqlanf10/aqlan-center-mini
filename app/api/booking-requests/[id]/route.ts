import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  confirmBookingRequest,
  findUserByUsername,
  rejectBookingRequest,
  writeAppointmentInDay,
} from "@/lib/db";
import { loadCapacityContext, resolveService } from "@/lib/capacity-context";
import { actorCanOverride, judgeBookingInDay } from "@/lib/book-appointment";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
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
      const date = typeof source.date === "string" ? source.date : "";
      const time = typeof source.time === "string" ? source.time : "";
      const durationMinutes = Number(source.durationMinutes ?? 30);
      if (!DATE_PATTERN.test(date)) {
        return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
      }

      /* محرّك السعة نفسه الذي يحمي الحجز اليدوي: تأكيد الطلب حجزٌ كامل، ولو حكم
         بقاعدةٍ أخفَّ لدخل من الباب الخلفي ما مُنع من الأمامي. والحكم والكتابة
         معًا داخل قفل اليوم الذرّي — فلا يفلت تأكيدٌ متزامن من فحصٍ قرأ قبل
         كتابة غيره. */
      const capacityContext = await loadCapacityContext();
      const service = await resolveService({
        serviceId: Number(source.serviceId) > 0 ? Number(source.serviceId) : null,
        appointmentType: typeof source.appointmentType === "string" ? source.appointmentType : null,
      });
      const actorUser = await findUserByUsername(session.username).catch(() => null);
      const canOverride = actorCanOverride({
        username: session.username, role: session.role, channel: "ui",
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
        commit: (client) => confirmBookingRequest({ id, date, time, durationMinutes }, client),
      });
      if (!result.ok) {
        return NextResponse.json(result.conflict, { status: 409 });
      }
      const confirmed = result.value;
      if (!confirmed) {
        return NextResponse.json({ message: "الطلب عولج سلفًا." }, { status: 409 });
      }
      return NextResponse.json(confirmed, { status: 201 });
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}
