/**
 * تحويلُ انتظارٍ إلى موعد — بقرار إنسان، وعبر محرّك السعة نفسه.
 *
 * القاعدة التي تحكم هذه الوحدة كلَّها: **قائمة الانتظار ترشِّح ولا تحجز صامتةً.**
 * لا يوجد في النظام مسارٌ يقرأ القائمة فيحجز من تلقاء نفسه؛ هذه الدالّة تُستدعى
 * حين يضغط موظّفٌ «احجز له» بعد أن كلّم المريض وسمع منه الموافقة.
 *
 * والترتيب مقصود بحذافيره:
 *   ١) **التعافي أولًا:** يُسأل هل لهذا الصفّ موعدٌ مكتوبٌ سلفًا
 *      (`waiting_list_id` على الموعد). فإن وُجد رُبط ولم يُكتب غيره.
 *   ٢) يُحجز الصفُّ (`claim`) — فلا يحجز موظّفان المكانَ نفسه لمريضين.
 *   ٣) يُحجز الموعد عبر `bookAppointment` — الباب الوحيد: قفلُ اليوم، ومحرّك
 *      السعة، وسجلّ التدقيق، وحدُّ المرضى الجدد. ولا كتابةَ مباشرة في الجدول.
 *      ويُكتب معه رقمُ صفّه في المعاملة نفسها.
 *   ٤) لا تصير الحالة «حُجز» إلا بعد أن يوجد الموعد، ومعه رقمه في الجملة نفسها.
 *   ٥) وأيُّ فشلٍ في (٣) يُطلق الحجز — فلا يبقى صفٌّ معلّقًا لأنّ السعة رفضت.
 *
 * **والنافذة التي أُغلقت:** كانت الخطوتان (٣) و(٤) منفصلتين بلا رابطٍ دائم، فلو
 * سقطت العملية بينهما بقي موعدٌ موجود وصفٌّ مفتوح — ثم يُعاد الحجز فيُنشأ موعدٌ
 * **ثانٍ** للمريض نفسه. ومهلةُ المطالبة (دقيقتان) لا تُصلح هذا: هي تنتهي فتفتح
 * الباب للموعد الثاني بدل أن تدلّ على الأوّل. فالرابط الدائم على الموعد هو
 * المفتاح، وفهرسٌ فريدٌ في القاعدة يجعلها الحَكَم لا ترتيبَ الاستدعاءات.
 */
import {
  claimWaitingForBooking, findAppointmentForWaiting, getWaitingEntry, markWaitingBooked,
  recordWaitingContact, releaseWaitingClaim,
} from "./db";
import { bookAppointment, type BookingActor, type BookingConflict } from "./book-appointment";
import type { Appointment } from "./schedule";
import type { WaitingEntry } from "./waiting-list";

export interface ConvertWaitingInput {
  waitingId: number;
  date: string;
  time: string;
  durationMinutes?: number | null;
  /** خدمةُ المكان — وإن غابت فخدمةُ الانتظار نفسه. */
  serviceId?: number | null;
  doctorId?: number | null;
  chairNo?: number | null;
  note?: string | null;
  overrideReason?: string | null;
}

export type ConvertWaitingResult =
  | { ok: true; appointment: Appointment; entry: WaitingEntry; warning: string | null }
  /** الصفُّ كان محجوزًا سلفًا — والنتيجة نفسها تُعاد بلا موعدٍ ثانٍ. */
  | { ok: true; appointment: null; entry: WaitingEntry; warning: null; alreadyBooked: number }
  | { ok: false; status: 400 | 404 | 409; message: string; conflict?: BookingConflict };

export async function convertWaitingToAppointment(
  input: ConvertWaitingInput, actor: BookingActor,
): Promise<ConvertWaitingResult> {
  const waitingId = Number(input.waitingId);
  if (!Number.isInteger(waitingId) || waitingId <= 0) {
    return { ok: false, status: 400, message: "رقم الانتظار غير صالح." };
  }

  const entry = await getWaitingEntry(waitingId);
  if (!entry) return { ok: false, status: 404, message: "الانتظار غير موجود." };

  /* تكرارُ الضغط لا يُنتج موعدين: صفٌّ مُغلق بموعدٍ حقيقيّ يعيد الموعد نفسه. */
  if (entry.status === "booked" && entry.appointmentId) {
    return {
      ok: true, appointment: null, entry, warning: null,
      alreadyBooked: entry.appointmentId,
    };
  }
  if (entry.status !== "waiting" && entry.status !== "offered") {
    return { ok: false, status: 409, message: "هذا الانتظار مُغلقٌ سلفًا." };
  }

  /* التعافي: صفٌّ مفتوح وله موعدٌ مكتوب يعني أنّ محاولةً سابقة سقطت بين كتابة
     الموعد وإغلاق الصفّ. فيُربط الموعد القائم — ولا يُكتب موعدٌ ثانٍ للمريض. */
  const orphan = await findAppointmentForWaiting(waitingId).catch(() => null);
  if (orphan) {
    const linked = await markWaitingBooked(
      waitingId, orphan.id,
      { actor: actor.username, actorRole: (actor.role ?? null) as string | null },
    );
    const after = await getWaitingEntry(waitingId).catch(() => null);
    return linked.ok
      ? { ok: true, appointment: orphan, entry: after ?? entry, warning: null }
      : {
        ok: true, appointment: null, entry: after ?? entry, warning: null,
        alreadyBooked: linked.alreadyBooked ?? orphan.id,
      };
  }

  const claim = await claimWaitingForBooking(waitingId, actor.username);
  if (!claim.ok) {
    if (claim.reason === "not_found") {
      return { ok: false, status: 404, message: "الانتظار غير موجود." };
    }
    return {
      ok: false, status: 409,
      message: claim.reason === "claimed"
        ? "زميلٌ آخر يحجز لهذا المريض الآن. انتظر لحظة ثم أعد المحاولة."
        : "هذا الانتظار مُغلقٌ سلفًا.",
    };
  }

  try {
    const booked = await bookAppointment({
      patientId: entry.patientId,
      date: input.date,
      time: input.time,
      /* المدّة: ما طلبه الموظّف، وإلا مدّةُ الانتظار المسجّلة، وإلا مدّةُ الخدمة
         داخل المحرّك — ولا ثابتَ هنا. */
      durationMinutes: input.durationMinutes ?? entry.durationMinutes ?? null,
      serviceId: input.serviceId ?? entry.serviceId ?? null,
      doctorId: input.doctorId ?? entry.doctorId ?? null,
      chairNo: input.chairNo ?? null,
      note: input.note ?? entry.note ?? null,
      overrideReason: input.overrideReason ?? null,
      /* الوسمُ يُكتب مع الموعد — لا بعده: لحظةَ وجود الموعد يوجد دليلُ نسبه. */
      waitingListId: waitingId,
    }, actor);

    if (!booked.ok) {
      await releaseWaitingClaim(waitingId).catch(() => {});
      return booked.status === 409
        ? { ok: false, status: 409, message: booked.conflict.message, conflict: booked.conflict }
        : { ok: false, status: 400, message: booked.message };
    }

    const appointmentId = Number(booked.appointment.id);
    const marked = await markWaitingBooked(
      waitingId, appointmentId,
      { actor: actor.username, actorRole: (actor.role ?? null) as string | null },
    );
    if (!marked.ok) {
      /* الموعد كُتب ولم يُغلق الصفّ. والموعد لا يُلغى سرًّا — لكنّه لم يعد
         يتيمًا: وسمُه يحمل رقم صفّه، فإعادةُ المحاولة تجده وتربطه بلا موعدٍ
         ثانٍ. ويُقال ذلك للموظّف صراحةً بدل «راجع يدويًّا». */
      return {
        ok: false, status: 409,
        message: marked.alreadyBooked
          ? `حُجز لهذا المنتظر موعدٌ آخر رقمه ${marked.alreadyBooked}. راجع الموعدين.`
          : "كُتب الموعد ولم يُغلق صفّ الانتظار. أعد الضغط — سيُربط الموعد نفسه ولن يُحجز غيره.",
      };
    }

    /* أثرُ المكالمة: «وافق» واقعةٌ تُكتب، فتُقرأ لاحقًا في سجلّ الاتصال بدل أن
       يختفي سببُ الحجز. وفشلُ التسجيل لا يُسقط حجزًا تمّ. */
    await recordWaitingContact(waitingId, {
      outcome: "accepted", channel: "phone", note: null,
      slotDate: input.date, slotTime: input.time, appointmentId,
    }, { actor: actor.username, actorRole: (actor.role ?? null) as string | null })
      .catch(() => {});

    const after = await getWaitingEntry(waitingId).catch(() => null);
    return {
      ok: true, appointment: booked.appointment, entry: after ?? entry,
      warning: booked.warning,
    };
  } catch (error) {
    await releaseWaitingClaim(waitingId).catch(() => {});
    throw error;
  }
}
