import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { ActiveVisitExists, addVisit, listTodayVisits, recordAudit, startVisitFromPlannedVisit } from "@/lib/db";
import { listReceptionHandoffs } from "@/lib/reception-handoff-db";
import { canReadReceptionHandoff, isHandoffDate } from "@/lib/reception-handoff";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalVisitFailure } from "@/lib/canonical-patient-http";
import { commandCanonicalArrival, parseCanonicalArrival, readCanonicalTodayVisits } from "@/lib/canonical-visits";

export const dynamic = "force-dynamic";

/** رسالة عربية لكل عطل — لا يظهر نص إنجليزي لموظفة الاستقبال أبدًا. */
function failed(message: string, status = 500) {
  return NextResponse.json({ message }, { status });
}

export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    // Canonical identity (M2 slice 11): today's queue inside the actor's patient scope.
    // The reception hand-off view is not canonical yet.
    if (new URL(request.url).searchParams.size > 0) {
      return NextResponse.json({ code: "view_not_canonical", message: "هذا العرض لم يُنقل بعد إلى الهوية الموحّدة." }, { status: 409, headers: NO_STORE });
    }
    try {
      return NextResponse.json(await readCanonicalTodayVisits(selected.handle), { headers: NO_STORE });
    } catch (error) {
      return canonicalVisitFailure(error, "تعذّر تحميل قائمة اليوم. تحقق من الاتصال ثم أعد المحاولة.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  if (params.has("view")) {
    if (params.getAll("view").length !== 1 || params.get("view") !== "reception-handoff") {
      return failed("عرض الزيارات غير صالح.", 400);
    }
    if (!canReadReceptionHandoff(session.role)) return failed("تسليم الزيارات للاستقبال والمدير فقط.", 403);
    const date = params.get("date");
    if (params.getAll("date").length > 1 || (date !== null && !isHandoffDate(date))) return failed("تاريخ التوقيع غير صالح.", 400);
    try {
      return NextResponse.json({ ...await listReceptionHandoffs(date ?? undefined),
        owner: { username: session.username, role: session.role } }, { headers: { "Cache-Control": "private, no-store" } });
    } catch { return failed("تعذّر تحديث الزيارات الموقّعة. أعد المحاولة."); }
  }
  try {
    return NextResponse.json(await listTodayVisits());
  } catch {
    // تفاصيل الاستثناء لا تخرج في الاستجابة — قد تحمل رابط قاعدة البيانات.
    return failed("تعذّر تحميل قائمة اليوم. تحقق من الاتصال ثم أعد المحاولة.");
  }
}

export async function POST(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    // Canonical identity (M2 slice 11): arrival on visits.manage, patient inside the scope.
    let canonicalBody: unknown;
    try {
      canonicalBody = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
      return NextResponse.json({ code: "invalid_visit_input", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    try {
      const input = parseCanonicalArrival(canonicalBody);
      return NextResponse.json(await commandCanonicalArrival(selected.handle, input), { status: 201, headers: NO_STORE });
    } catch (error) {
      return canonicalVisitFailure(error, "تعذّر تسجيل المريض. أعد المحاولة.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return failed("طلب غير صالح.", 400);
  }

  const source = (body ?? {}) as Record<string, unknown>;

  /*
   * بدء الزيارة من زيارةٍ مخطَّطة — الرحلة V2.
   *
   * الزيارة تُنشأ مربوطةً بمريضها وجلساتها من الزيارة المخطَّطة نفسها: يعرف الطبيب
   * «مخطَّط لليوم» قبل أن يفتح الفم، والاستقبال لا تعيد إدخال شيء. والمدخل الآخر
   * (اسمٌ حر) يبقى كما هو للمريض المشي.
   */
  const rawPlannedVisitId = Number(source.plannedVisitId);
  if (Number.isInteger(rawPlannedVisitId) && rawPlannedVisitId > 0) {
    try {
      const started = await startVisitFromPlannedVisit({
        plannedVisitId: rawPlannedVisitId,
        actor: session.username,
        actorRole: session.role,
      });
      if (started && "appointmentConflict" in started) {
        return failed("تغيّر الموعد المرتبط أو أُغلق. أعد الحجز قبل بدء الجلسة.", 409);
      }
      if (started && "alreadyActive" in started) {
        return NextResponse.json(
          { message: "لهذه الجلسة زيارة قائمة سلفًا.", visitId: started.visitId },
          { status: 409 },
        );
      }
      if (!started) {
        return failed("الزيارة المخطَّطة غير موجودة أو لا يمكن بدؤها.", 404);
      }
      await recordAudit({
        action: "visit.create", entity: "visit", entityId: started.id, entityLabel: started.patientName,
        details: { المصدر: "جلسة مخططة", الجلسة_المخططة: rawPlannedVisitId },
        actor: session.username, actorRole: session.role,
      });
      return NextResponse.json(started, { status: 201 });
    } catch {
      return failed("تعذّر بدء الزيارة من الجلسة المخطَّطة. أعد المحاولة.");
    }
  }

  const patientName = typeof source.patientName === "string" ? source.patientName.trim() : "";
  if (!patientName) return failed("اسم المريض مطلوب.", 400);
  if (patientName.length > 120) return failed("اسم المريض طويل أكثر من اللازم.", 400);

  const phoneRaw = typeof source.patientPhone === "string" ? source.patientPhone.trim() : "";
  const noteRaw = typeof source.note === "string" ? source.note.trim() : "";

  // ملفُّ المريض إن اختارته الاستقبال من قائمة المطابقات — وهو ما يمنع الملف الثاني.
  const rawPatientId = Number(source.patientId);
  const patientId = Number.isInteger(rawPatientId) && rawPatientId > 0 ? rawPatientId : null;

  // الطبيب المعالج للزيارة إن تم تحديده
  const rawDoctorId = Number(source.doctorId);
  const doctorId = Number.isInteger(rawDoctorId) && rawDoctorId > 0
    ? rawDoctorId
    : (session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
      ? session.partyId
      : null);

  try {
    const visit = await addVisit({
      patientName,
      patientPhone: phoneRaw || null,
      note: noteRaw ? noteRaw.slice(0, 300) : null,
      patientId,
      doctorId,
    });
    // (TD-06) فتح زيارة اليوم (دخول مباشر) — من فتحها ولأي مريض.
    await recordAudit({
      action: "visit.create", entity: "visit", entityId: visit.id, entityLabel: visit.patientName,
      details: { المصدر: "دخول مباشر", المريض: patientId, الطبيب: doctorId },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(visit, { status: 201 });
  } catch (error) {
    if (error instanceof ActiveVisitExists) {
      return NextResponse.json({ message: error.message, visitId: error.visitId }, { status: 409 });
    }
    return failed("تعذّر تسجيل المريض. أعد المحاولة.");
  }
}

