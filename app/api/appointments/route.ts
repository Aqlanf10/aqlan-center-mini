import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { chairCount } from "@/lib/settings";
import { isAdmin } from "@/lib/roles";
import { doctorOwnedPatientIds, findUserByUsername, getSettings, insertAppointmentOnClient, listAppointmentsByDate, recordAudit, writeAppointmentInDay } from "@/lib/db";
import { nextFreeTime, withinWorkingHours } from "@/lib/schedule";
import { judgeCapacity, overrideAccepted, type CapacityVerdict } from "@/lib/capacity";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }
  try {
    const list = await listAppointmentsByDate(date);
    /* صلاحيات الوكيل المساعد: الطبيب بلا منحٍ صريح يرى مواعيده ومواعيد مرضاه
       والمواعيد غير المسندة — لا جدول زملائه. الفلترة في الخادم بعد الجلب
       (قائمة يوم كامل بضع عشرات صفوف) لا في الشاشة. */
    if (session.role === "doctor") {
      const user = await findUserByUsername(session.username).catch(() => null);
      if (!user?.permissions?.canViewAllAppointments) {
        const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
        if (doctorPartyId) {
          const candidateIds = Array.from(new Set(list.map((a) => a.patientId)));
          const owned = await doctorOwnedPatientIds(doctorPartyId, candidateIds).catch(() => new Set<number>());
          return NextResponse.json(
            list.filter((a) => !a.doctorId || a.doctorId === doctorPartyId || owned.has(a.patientId)),
          );
        }
        return NextResponse.json([]);
      }
    }
    return NextResponse.json(list);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل مواعيد اليوم." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }

  const source = (body ?? {}) as Record<string, unknown>;
  const patientId = Number(source.patientId);
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  const durationMinutes = Number(source.durationMinutes ?? 30);
  const appointmentType = typeof source.appointmentType === "string" && source.appointmentType.trim()
    ? source.appointmentType.trim().slice(0, 60)
    : null;
  const note = typeof source.note === "string" ? source.note.trim() : "";

  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }

  try {
    const settings = await getSettings();
    const chairs = chairCount(settings);
    /* ساعات الدوام تُمرَّر للتنبيه لا للمنع: طوارئُ الأسنان تقع ليلًا، ومركزٌ
       يرفض تسجيل مريضٍ جاء بألمٍ في الحادية عشرة يدفع الاستقبال إلى تسجيله بوقتٍ
       كاذب — فيُفسد الجدول كلَّه بدل أن يحفظه. */
    const hours = { start: settings["clinic.day_start"], end: settings["clinic.day_end"] };
    const nearCapacityPercent = Number(settings["scheduling.near_capacity_percent"]);
    /* التجاوز حقٌّ لا افتراض: المدير يملكه، وغيره لا يملكه إلا بمنحٍ صريح.
       ويُقرأ من المستخدم في القاعدة لا من الجلسة: الجلسة كوكي، والصلاحية قرارٌ
       يُغيَّر من شاشة المستخدمين فيسري فورًا لا بعد خروجٍ ودخول. */
    const actor = await findUserByUsername(session.username).catch(() => null);
    const canOverride = isAdmin(session.role)
      || actor?.permissions?.canOverrideCapacity === true;
    const overrideReason = typeof source.overrideReason === "string"
      ? source.overrideReason.trim().slice(0, 300) : "";
    /* يُملأ داخل الحكم إن مرّ تجاوزٌ، ليُسجَّل بعد نجاح الكتابة لا قبلها: تسجيل
       تجاوزٍ لحجزٍ لم يُكتب يزعم ما لم يحدث.
       وحقلٌ في كائنٍ لا متغيّرٌ مفرد: المُصرِّف لا يرى الإسناد داخل دالّة الحكم،
       فيضيّق المتغيّر المفرد إلى `never` بعد الفحص. */
    const capacity: { overridden: CapacityVerdict | null } = { overridden: null };
    // الحارس يُطبَّق على الخادم لا في الواجهة وحدها. والفحص والكتابة داخل قفل
    // اليوم الذرّي: جهازان يحجزان في اللحظة نفسها فيتنافسان على القفل نفسه،
    // فيرى الثاني مواعيد الأول ويُبعَد بدل أن يكتبا فوق كرسيٍّ واحد.
    const result = await writeAppointmentInDay({
      date,
      judge: (sameDay) => {
        /* محرّك السعة يحكم بثلاث لا باثنتين: متاح، واقترب من الحدّ (يمرّ بتحذير)،
           وتجاوز (يُمنع إلا بصلاحيةٍ وسببٍ موثَّق). والحكم داخل قفل اليوم الذرّي
           فلا يمرّ حاجزان معًا على آخر كرسيّ. */
        const verdict = judgeCapacity({
          appointments: sameDay, date, time, durationMinutes, chairs, hours,
          nearCapacityPercent,
        });
        if (verdict.state !== "OVER_CAPACITY") {
          return { ok: true as const };
        }
        const permitted = overrideAccepted({ canOverride, reason: overrideReason });
        if (permitted.ok) {
          capacity.overridden = verdict;
          return { ok: true as const };
        }

        const suggestion = nextFreeTime(sameDay, date, time, durationMinutes, chairs);
        return {
          ok: false as const,
          conflict: {
            message: verdict.message,
            state: verdict.state,
            reasons: verdict.reasons,
            dayPercent: verdict.dayPercent,
            /* سببُ الرفض يفرّق بين «ممتلئ» و«ليست لك الصلاحية» — وإلا حاول
               الموظّف مرارًا وهو لا يعرف أنّ المشكلة ليست في الوقت. */
            overrideHint: canOverride ? permitted.message : "تجاوز السعة يحتاج صلاحيةً أعلى.",
            // بديل محدد بدل رفض مجرّد: الاستقبال تقول للمريض وقتًا، لا «جرّب غيره».
            suggestion,
            suggestionMessage: suggestion ? `أقرب وقت متاح: ${suggestion}` : "لا يوجد وقت متاح في هذا اليوم.",
          },
        };
      },
      commit: (client) =>
        insertAppointmentOnClient(client, {
          patientId,
          date,
          time,
          durationMinutes,
          appointmentType,
          note: note ? note.slice(0, 300) : null,
          /* الطبيب يحجز لنفسه فيُسجّل موعده على جهته فيراه في جدوله المحجوب. */
          doctorId: session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
            ? session.partyId
            : (Number.isInteger(Number(source.doctorId)) && Number(source.doctorId) > 0
              ? Number(source.doctorId)
              : null),
        }),
    });

    if (!result.ok) {
      return NextResponse.json(result.conflict, { status: 409 });
    }
    /* تنبيهٌ لا خطأ: الموعد حُجز، والاستقبال تُخبَر أنه خارج الدوام لتتأكّد قبل أن
       تَعِد المريض — أو لتُصحّح خطأ إدخالٍ كتب ٢١:٠٠ مكان ٠٩:٠٠. */
    const capacityOverride = capacity.overridden;
    if (capacityOverride) {
      /* «أي تجاوز يجب أن يسجل السبب والمستخدم والوقت في Audit Log» — خطّة المالك. */
      await recordAudit({
        action: "appointment.capacity_override",
        entity: "appointment",
        entityId: String((result.value as { id?: number })?.id ?? ""),
        actor: session.username,
        actorRole: session.role,
        details: {
          التاريخ: date,
          الوقت: time,
          الحالة: capacityOverride.state,
          "امتلاء اليوم": `${capacityOverride.dayPercent}٪`,
          "الكراسي المشغولة": `${capacityOverride.occupiedChairs} من ${capacityOverride.chairs}`,
          السبب: overrideReason,
        },
      }).catch(() => {});
    }
    const outsideHours = !withinWorkingHours(time, durationMinutes, hours);
    return NextResponse.json(
      outsideHours
        ? { ...result.value, warning: `هذا الوقت خارج دوام المركز (${hours.start}–${hours.end}).` }
        : result.value,
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر حجز الموعد. أعد المحاولة." }, { status: 500 });
  }
}
