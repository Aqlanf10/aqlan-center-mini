import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { arriveAppointment, closeBookedAppointment, deleteAppointment, getAppointment, markReminderSent, resolvePastBooking } from "@/lib/db";
import { findWaitingCandidatesForSlot } from "@/lib/waiting-list-match";
import { authorizeAppointment } from "@/lib/operational-access";
import { rescheduleAppointment } from "@/lib/book-appointment";
import { findUserByUsername } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * من ينتظر هذا المكان الذي شغر للتوّ.
 *
 * يُلحق بردّ الإلغاء وعدم الحضور، فيعرف **كلُّ** بابٍ يُغلق موعدًا أنّ في
 * القائمة من يصلح له — لا شاشةُ المواعيد وحدها كما كان. والمطابقة من الوحدة
 * المشتركة لا نسخةً هنا، وتُطبَّق فيها حدودُ الطبيب على ملفّات المرضى.
 *
 * وفشلُه لا يُفشل الإغلاق: الموعد أُغلق فعلًا، والترشيح تحسينٌ فوقه.
 */
async function candidatesForFreedSlot(
  appointmentId: number,
  session: NonNullable<Awaited<ReturnType<typeof requireSession>>>,
): Promise<{ count: number; slot: { date: string; time: string } } | null> {
  try {
    const appointment = await getAppointment(appointmentId);
    if (!appointment) return null;
    const match = await findWaitingCandidatesForSlot({
      appointmentId,
      date: appointment.scheduledDate,
      time: appointment.scheduledTime.slice(0, 5),
    }, { session });
    if (!match || match.candidates.length === 0) return null;
    /* عددٌ وموضعٌ فقط: أسماءُ المنتظرين تُقرأ من مسار قائمة الانتظار بحارسه،
       فلا يصير ردُّ الإلغاء بابًا ثانيًا لبيانات المرضى. */
    return {
      count: match.candidates.length,
      slot: { date: match.slot.date, time: match.slot.time },
    };
  } catch {
    return null;
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  /* الفاعل يُحمل إلى سجلّ الانتقالات: «مَن ألغى هذا الموعد» سؤالٌ يُسأل بعد أسبوع،
     ولا يجيبه سجلٌّ يقول «الاستقبال» عن ستّة أشخاص. */
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الموعد غير صالح." }, { status: 400 });
  }

  /* حارسُ المورد قبل الجسد: «هل معك جلسة؟» لا تكفي — والسؤال «هل هذا المريض لك؟».
     ورقمُ المريض يُحسم من الموعد في الجدول لا ممّا يرسله الطلب. */
  const allowed = await authorizeAppointment(session, id);
  if (!allowed.ok) {
    return NextResponse.json({ message: allowed.message }, { status: allowed.status });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }
  const action = typeof (body as Record<string, unknown>)?.action === "string"
    ? String((body as Record<string, unknown>).action) : "";
  /* سببُ الإلغاء — يُقصّ عند حدٍّ معقول: السجلّ لا يُحذف منه، فلا يُترك بابًا لنصٍّ
     بلا حدّ. وغيابه يجعل الطبقة الأدنى تكتب سببها الافتراضي لا أن تُسقط الحقل. */
  const bodyReason = typeof (body as Record<string, unknown>)?.reason === "string"
    ? String((body as Record<string, unknown>).reason).trim().slice(0, 300) || null
    : null;

  try {
    if (action === "arrive") {
      // الوصول يفتح صفًّا في اللوحة — هذا ما يجعل الحجز والانتظار نظامًا واحدًا.
      const ok = await arriveAppointment(id);
      if (!ok) {
        return NextResponse.json(
          { message: "سُجّل وصوله بالفعل أو تغيّرت حالة الموعد." },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true });
    }
    if (action === "reminded") {
      // يُستدعى بعد فتح واتساب لا قبله: التسجيل قبل الفتح يزعم إرسالًا لم يحدث.
      const ok = await markReminderSent(id);
      if (!ok) return NextResponse.json({ message: "الموعد غير موجود." }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    if (action === "cancel" || action === "no_show") {
      /* الحارس في الجملة لا قبلها: الشاشة لا تعرض الزرّين إلا على المحجوز، وجهازان
         يضغطان معًا — «وصل» و«لم يحضر» — كان أحدهما يمحو الآخر بلا أثر. */
      const closed = await closeBookedAppointment(
        id, action === "cancel" ? "cancelled" : "no_show",
        { actor: session.username, actorRole: session.role, reason: bodyReason },
      );
      if (!closed) {
        return NextResponse.json(
          { message: "تغيّرت حالة الموعد — حدّث القائمة." },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true, waiting: await candidatesForFreedSlot(id, session) });
    }
    /* نقلُ الموعد — عبر محرّك السعة نفسه، وبسببٍ يُسجَّل.
       وقبل هذا لم يكن في النظام نقلٌ أصلًا: كان يُلغى الموعد ويُحجز غيره، فيُحتسب
       المريض في «الملغى» وهو لم يُلغِ. */
    if (action === "reschedule") {
      const user = await findUserByUsername(session.username).catch(() => null);
      const body_ = body as Record<string, unknown>;
      const result = await rescheduleAppointment({
        appointmentId: id,
        date: String(body_.date ?? ""),
        time: String(body_.time ?? ""),
        durationMinutes: body_.durationMinutes == null ? null : Number(body_.durationMinutes),
        serviceId: body_.serviceId === undefined
          ? undefined : (body_.serviceId == null ? null : Number(body_.serviceId)),
        doctorId: body_.doctorId === undefined
          ? undefined : (body_.doctorId == null ? null : Number(body_.doctorId)),
        chairNo: body_.chairNo === undefined
          ? undefined : (body_.chairNo == null ? null : Number(body_.chairNo)),
        reason: bodyReason ?? "",
        overrideReason: typeof body_.overrideReason === "string" ? body_.overrideReason : null,
      }, {
        username: session.username,
        role: session.role,
        doctorPartyId: user?.partyId ?? null,
        /* صلاحيةُ التجاوز من المستخدم في الخادم لا من الطلب. */
        canOverrideCapacity: user?.permissions?.canOverrideCapacity === true,
        channel: "ui",
      });

      if (result.ok) {
        return NextResponse.json({
          ok: true, appointment: result.appointment, warning: result.warning,
        });
      }
      return NextResponse.json(
        { message: result.message, conflict: result.conflict ?? null },
        { status: result.status },
      );
    }

    if (action === "close_done" || action === "close_no_show") {
      // إغلاق موعدٍ مضى من قائمة المعلّقة: «تمّت» أو «لم يحضر».
      const resolved = await resolvePastBooking(
        id, action === "close_done" ? "done" : "no_show",
        { actor: session.username, actorRole: session.role, reason: bodyReason },
      );
      if (!resolved) {
        return NextResponse.json(
          { message: "الموعد لم يعد معلّقًا — حدّث القائمة." },
          { status: 409 },
        );
      }
      return NextResponse.json({
        ok: true,
        waiting: action === "close_no_show"
          ? await candidatesForFreedSlot(id, session) : null,
      });
    }
    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

/* حذف موعد نهائيًا — المدير وحده، وللموعد الذي لم يتحول زيارةً بعد. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف المواعيد للمدير وحده." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الموعد غير صالح." }, { status: 400 });
  }
  const deletable = await authorizeAppointment(session, id);
  if (!deletable.ok) {
    return NextResponse.json({ message: deletable.message }, { status: deletable.status });
  }

  let reason: string | null = null;
  try {
    const body = (await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES));
    if (typeof body?.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 300);
    }
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; /* لا سبب — ليس شرطًا */ }

  try {
    const result = await deleteAppointment(id, { actor: session.username, actorRole: session.role, reason });
    if (!result.ok) {
      if (result.reason === "arrived") {
        return NextResponse.json(
          { message: "صاحب الموعد وصل وتحوّل زيارةً — لا يُحذف، أُنهِ الزيارة أو ألغِ الموعد." },
          { status: 409 },
        );
      }
      return NextResponse.json({ message: "الموعد غير موجود." }, { status: 404 });
    }
    return NextResponse.json({ message: "حُذف الموعد وسُجِّل في التدقيق." });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف الموعد. أعد المحاولة." }, { status: 500 });
  }
}
