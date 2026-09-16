import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  findUserByUsername, getWaitingEntry, listWaitingContactEvents, markWaitingOffered,
  recordWaitingContact, resolveWaitingEntry, updateWaitingPreferences,
} from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { convertWaitingToAppointment } from "@/lib/waiting-list-booking";
import {
  CONTACT_CHANNELS, CONTACT_OUTCOMES, PERIODS, SHIFTS, URGENCIES, normalizeWeekdays,
  type ContactChannel, type ContactOutcome, type PreferredPeriod, type PreferredShift,
  type WaitingUrgency,
} from "@/lib/waiting-list";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/**
 * قراءةُ صفٍّ واحد مع سجلّ اتصاله — لنافذة «تاريخ المكالمات».
 *
 * والحارس على الملفّ لا على الجلسة: طبيبٌ لا يملك مريضًا لا يقرأ محاولات
 * الاتصال به ولا ملاحظاتها.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await authorize(context);
  if ("response" in guard) return guard.response;

  try {
    const events = await listWaitingContactEvents(guard.id);
    return NextResponse.json({ entry: guard.entry, events });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجلّ الاتصال." }, { status: 500 });
  }
}

/**
 * تحديث انتظار — نداءٌ، أو تسجيلُ مكالمة، أو تعديلُ تفضيلات، أو حجزٌ، أو إغلاق.
 *
 * ولا حذف: من انتظر ثم اعتذر يبقى في السجلّ بسببه. وقائمةٌ تُحذف منها الأسماء
 * لا تُجيب «كم مريضًا ردَدْنا هذا الشهر؟» — وهو الرقم الذي يقول للمالك إن كان
 * يحتاج كرسيًّا ثالثًا.
 *
 * والتفويض هنا على المريض لا على الجلسة: كلُّ فعلٍ في هذا المسار يمسّ ملفَّ
 * مريضٍ بعينه — اسمَه ورقمَ هاتفه ومتى كُلّم — فطبيبٌ لا يملك المريض لا يُحرّك
 * صفَّه ولو نادى المسار مباشرةً. **إخفاءُ الزر في الشاشة ليس تفويضًا.**
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await authorize(context);
  if ("response" in guard) return guard.response;
  const { id, session } = guard;

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  const actor = { actor: session.username, actorRole: session.role };

  try {
    if (action === "offer") {
      const result = await markWaitingOffered(id, actor);
      if (result.ok) return NextResponse.json({ ok: true });
      return NextResponse.json(
        {
          message: result.reason === "not_open"
            ? "هذا الانتظار نودي أو أُغلق سلفًا." : "الانتظار غير موجود.",
        },
        { status: result.reason === "not_open" ? 409 : 404 },
      );
    }

    /* تسجيلُ المكالمة — واقعةٌ تُضاف ولا تُعدَّل.
       كانت الشاشة تعرض «نودي» وحدها: كلمةٌ لا تقول أردّ أم لم يردّ، ولا متى،
       ولا من اتّصل. فالاستقبال يعاود الاتصال بمن رفض، ويترك من طلب أن يُعاود. */
    if (action === "contact") {
      const outcome = String(body.outcome ?? "");
      const channel = String(body.channel ?? "phone");
      if (!CONTACT_OUTCOMES.includes(outcome as ContactOutcome)) {
        return NextResponse.json({ message: "نتيجة الاتصال غير معروفة." }, { status: 400 });
      }
      if (!CONTACT_CHANNELS.includes(channel as ContactChannel)) {
        return NextResponse.json({ message: "وسيلة الاتصال غير معروفة." }, { status: 400 });
      }
      const slotDate = typeof body.slotDate === "string" && DATE_PATTERN.test(body.slotDate)
        ? body.slotDate : null;
      const slotTime = typeof body.slotTime === "string" && TIME_PATTERN.test(body.slotTime)
        ? body.slotTime : null;
      const note = typeof body.note === "string" && body.note.trim()
        ? body.note.trim().slice(0, 300) : null;

      const result = await recordWaitingContact(id, {
        outcome: outcome as ContactOutcome,
        channel: channel as ContactChannel,
        note, slotDate, slotTime,
      }, actor);
      return result.ok
        ? NextResponse.json({ ok: true, event: result.event })
        : NextResponse.json({ message: result.message }, { status: 409 });
    }

    /* تعديلُ التفضيلات — لأنّ المريض يتّصل فيقول «صرت أقدر صباحًا».
       وكان البديل إلغاءَ الصفّ وإنشاءَ غيره، فيفقد أقدميّته ويعود آخر القائمة. */
    if (action === "preferences") {
      const patch: Record<string, unknown> = {};
      if (body.preferredPeriod !== undefined) {
        if (!PERIODS.includes(String(body.preferredPeriod) as PreferredPeriod)) {
          return NextResponse.json({ message: "الفترة المفضّلة غير معروفة." }, { status: 400 });
        }
        patch.preferredPeriod = body.preferredPeriod as PreferredPeriod;
      }
      if (body.preferredShift !== undefined) {
        if (!SHIFTS.includes(String(body.preferredShift) as PreferredShift)) {
          return NextResponse.json({ message: "الوردية المفضّلة غير معروفة." }, { status: 400 });
        }
        patch.preferredShift = body.preferredShift as PreferredShift;
      }
      if (body.urgency !== undefined) {
        if (!URGENCIES.includes(String(body.urgency) as WaitingUrgency)) {
          return NextResponse.json({ message: "درجة الإلحاح غير معروفة." }, { status: 400 });
        }
        patch.urgency = body.urgency as WaitingUrgency;
      }
      if (body.preferredDays !== undefined) {
        const days = normalizeWeekdays(body.preferredDays);
        if (days === null) {
          return NextResponse.json({ message: "أيام الأسبوع المفضّلة غير صالحة." }, { status: 400 });
        }
        patch.preferredDays = days;
      }
      if (body.sameDayAvailable !== undefined) {
        patch.sameDayAvailable = body.sameDayAvailable !== false;
      }
      for (const key of ["earliestDate", "latestDate", "note"] as const) {
        if (body[key] !== undefined) {
          patch[key] = typeof body[key] === "string" && String(body[key]).trim()
            ? String(body[key]).trim() : null;
        }
      }
      for (const key of ["serviceId", "doctorId", "durationMinutes"] as const) {
        if (body[key] !== undefined) {
          const value = Number(body[key]);
          patch[key] = Number.isInteger(value) && value > 0 ? value : null;
        }
      }
      if (Object.keys(patch).length === 0) {
        return NextResponse.json({ message: "لا يوجد تعديل." }, { status: 400 });
      }

      const result = await updateWaitingPreferences(id, patch, actor);
      return result.ok
        ? NextResponse.json(result.entry)
        : NextResponse.json({ message: result.message }, { status: 409 });
    }

    /* الحجز — بقرار إنسانٍ كلّم المريض. والقائمة لا تحجز من تلقاء نفسها أبدًا:
       هذا المسار يُستدعى بضغطة، ويمرّ بمحرّك السعة كأيّ حجزٍ آخر. */
    if (action === "book") {
      const date = String(body.date ?? "");
      const time = String(body.time ?? "");
      if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) {
        return NextResponse.json({ message: "حدّد تاريخ الموعد ووقته." }, { status: 400 });
      }
      const user = await findUserByUsername(session.username).catch(() => null);
      const result = await convertWaitingToAppointment({
        waitingId: id, date, time,
        durationMinutes: body.durationMinutes == null ? null : Number(body.durationMinutes),
        serviceId: body.serviceId == null ? null : Number(body.serviceId),
        doctorId: body.doctorId == null ? null : Number(body.doctorId),
        chairNo: body.chairNo == null ? null : Number(body.chairNo),
        overrideReason: typeof body.overrideReason === "string" ? body.overrideReason : null,
      }, {
        username: session.username,
        role: session.role,
        doctorPartyId: user?.partyId ?? null,
        /* صلاحيةُ التجاوز تُقرأ من المستخدم في الخادم — لا من الطلب. */
        canOverrideCapacity: user?.permissions?.canOverrideCapacity === true,
        channel: "ui",
      });

      if (result.ok) {
        return NextResponse.json({
          ok: true,
          appointment: result.appointment,
          entry: result.entry,
          warning: "warning" in result ? result.warning : null,
          alreadyBooked: "alreadyBooked" in result ? result.alreadyBooked : null,
        });
      }
      return NextResponse.json(
        { message: result.message, conflict: result.conflict ?? null },
        { status: result.status },
      );
    }

    /* «حُجز» لا تُقبل من الشبكة إطلاقًا — وهذا تشديدُ مراجعة المالك.
       كان المسار يقبلها مع رقم موعدٍ يرسله المُنادي، فيستطيع مخوَّلٌ أن يربط
       صفَّ مريضٍ بموعد مريضٍ آخر بمجرّد كتابة رقمٍ في الطلب — وصفٌّ يقول «حُجز»
       وهو مربوطٌ بموعدِ غيره يُسقط صاحبه من القائمة ومن الجدول معًا.
       والتحقّقُ من أنّ الرقم «موعدُ هذا الصفّ» ليس شيئًا يُفحص بعد الواقعة: هو
       يُولد مع الموعد نفسه في `convertWaitingToAppointment`. فالباب أُغلق بدل
       أن يُحرَس. */
    if (action === "booked") {
      return NextResponse.json(
        {
          message: "«حُجز» لا تُكتب يدويًّا. استعمل «احجز له» ليُنشأ الموعد ويُربط بصفّه.",
        },
        { status: 400 },
      );
    }

    if (action === "cancelled" || action === "expired") {
      /* الإلغاء يلزمه سبب: «لماذا خرج من القائمة؟» سؤالٌ يُسأل حين يتّصل المريض
         بعد شهرٍ يسأل عن دوره. */
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (action === "cancelled" && !reason) {
        return NextResponse.json({ message: "اكتب سبب الإلغاء." }, { status: 400 });
      }
      /* ولا `appointmentId` يُقرأ من الجسد هنا: الإغلاق بسببٍ لا يربط مواعيد،
         والربطُ بابُه واحد. */
      const result = await resolveWaitingEntry(id, {
        status: action,
        reason: reason || null,
        appointmentId: null,
      }, actor);
      if (result.ok) return NextResponse.json({ ok: true });
      return NextResponse.json(
        {
          message: result.reason === "already_resolved"
            ? "هذا الانتظار مُغلقٌ سلفًا." : "الانتظار غير موجود.",
        },
        { status: result.reason === "already_resolved" ? 409 : 404 },
      );
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

/**
 * الحارس المشترك — جلسةٌ، ثم رقمٌ صالح، ثم **صلاحيةٌ على ملفّ المريض**.
 *
 * وترتيبُه مقصود: «الانتظار غير موجود» تُعاد لمن لا يملك المريض كما تُعاد لمن
 * طلب رقمًا غير موجود، فلا يُستدلّ من اختلاف الردّين على أنّ لهذا الرقم صفًّا.
 */
async function authorize(
  context: { params: Promise<{ id: string }> },
): Promise<
  | { response: NextResponse }
  | {
      id: number;
      session: NonNullable<Awaited<ReturnType<typeof requireSession>>>;
      entry: NonNullable<Awaited<ReturnType<typeof getWaitingEntry>>>;
    }
> {
  const session = await requireSession();
  if (!session) {
    return {
      response: NextResponse.json(
        { message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 },
      ),
    };
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return {
      response: NextResponse.json({ message: "رقم الانتظار غير صالح." }, { status: 400 }),
    };
  }
  const entry = await getWaitingEntry(id).catch(() => null);
  if (!entry) {
    return {
      response: NextResponse.json({ message: "الانتظار غير موجود." }, { status: 404 }),
    };
  }
  if (!(await canAccessPatient(session, entry.patientId))) {
    return {
      response: NextResponse.json({ message: "الانتظار غير موجود." }, { status: 404 }),
    };
  }
  return { id, session, entry };
}
