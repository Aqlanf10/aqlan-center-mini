import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  addWaitingEntry, doctorOwnedPatientIds, findUserByUsername,
  listAppointmentsByDate, listWaitingEntries,
} from "@/lib/db";
import { getSettings } from "@/lib/db";
import { isExpired } from "@/lib/waiting-list";
import {
  PERIODS, URGENCIES, rankCandidates,
  type PreferredPeriod, type WaitingUrgency,
} from "@/lib/waiting-list";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/**
 * قائمة الانتظار — من لم يجد موعدًا.
 *
 * المحرّك يرفض الحجز حين يمتلئ اليوم. والرفض بلا وجهةٍ يعني مريضًا ضاع: يُغلق
 * الهاتف، ثم يُلغي غيرُه موعده بعد ساعتين فيبقى الكرسي فارغًا ولا أحد يعرف من
 * يُنادى. فهذه الواجهة هي الجانب الآخر من الحارس.
 *
 * ومعاملان اختياريّان يحوّلانها إلى **ترشيحٍ لمكانٍ شاغر**: `date` و`time`
 * (و`durationMinutes`) — فتُعاد القائمة مرتَّبةً بمن يصلح لهذا المكان.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  try {
    let entries = await listWaitingEntries({
      includeResolved: params.get("includeResolved") === "1",
    });

    /* عزلُ الطبيب — الحارس نفسه الذي يحمي `/api/patients` و`/api/appointments`.
       صفُّ الانتظار يحمل اسم المريض ورقم هاتفه، فقائمةٌ بلا عزلٍ تُطلع طبيبًا
       على مرضى زملائه من باب لم يُحرَس. والفلترة في الخادم بعد الجلب — قائمةٌ
       مفتوحة بضع عشرات صفوف — لا في الشاشة. */
    if (session.role === "doctor") {
      const user = await findUserByUsername(session.username).catch(() => null);
      if (!user?.permissions?.canViewAllPatients) {
        const doctorPartyId = user?.partyId
          ?? (typeof session.partyId === "number" ? session.partyId : null);
        if (!doctorPartyId) return NextResponse.json({ entries: [] });
        const owned = await doctorOwnedPatientIds(
          doctorPartyId, Array.from(new Set(entries.map((entry) => entry.patientId))),
        ).catch(() => new Set<number>());
        entries = entries.filter(
          (entry) => entry.doctorId === doctorPartyId || owned.has(entry.patientId),
        );
      }
    }

    /* مدّة البقاء: إعدادٌ يُقرأ ويُطبَّق. وإعدادٌ يبدو فاعلًا وهو معطَّل أسوأ من
       إعدادٍ غير موجود — وهو الدرس نفسه من حدّ المرضى الجدد في المرحلة ٤ب.
       والانتهاء علامةٌ للمراجعة لا حذف: الصفّ يبقى ويُعلَّم. */
    const settings = await getSettings().catch(() => null);
    const holdDays = Number(settings?.["scheduling.waiting_list_hold_days"] ?? 0);
    const today = new Date().toISOString().slice(0, 10);
    const marked = entries.map((entry) => ({
      ...entry,
      isStale: Number.isFinite(holdDays) && holdDays > 0
        ? isExpired(entry, today, holdDays) : false,
    }));
    entries = marked;

    const date = params.get("date") ?? "";
    const time = params.get("time") ?? "";
    if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) {
      return NextResponse.json({ entries });
    }

    /* مدّةُ المكان: ما أُرسل، وإلا ما بقي من مدّة الموعد الملغى — ولا تُفترض
       بلا أساس، لأنّ الافتراض هنا يرشّح من لا يسعه المكان. */
    const requested = Number(params.get("durationMinutes"));
    let durationMinutes = Number.isFinite(requested) && requested > 0 ? requested : 0;
    if (!durationMinutes) {
      const sameDay = await listAppointmentsByDate(date).catch(() => []);
      const freed = sameDay.find((appointment) => appointment.scheduledTime.startsWith(time.padStart(5, "0")));
      durationMinutes = freed?.durationMinutes ?? 30;
    }

    const doctorId = Number(params.get("doctorId"));
    const candidates = rankCandidates(entries, {
      date, time, durationMinutes,
      doctorId: Number.isInteger(doctorId) && doctorId > 0 ? doctorId : null,
    });
    return NextResponse.json({ entries, candidates, slot: { date, time, durationMinutes } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قائمة الانتظار." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const integer = (key: string): number | null => {
    const value = Number(body[key]);
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  const text = (key: string): string | null => {
    const value = body[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };

  const period = text("preferredPeriod") ?? "any";
  const urgency = text("urgency") ?? "normal";
  if (!PERIODS.includes(period as PreferredPeriod)) {
    return NextResponse.json({ message: "الفترة المفضّلة غير معروفة." }, { status: 400 });
  }
  if (!URGENCIES.includes(urgency as WaitingUrgency)) {
    return NextResponse.json({ message: "درجة الإلحاح غير معروفة." }, { status: 400 });
  }

  try {
    const result = await addWaitingEntry({
      patientId: Number(body.patientId),
      serviceId: integer("serviceId"),
      doctorId: integer("doctorId"),
      earliestDate: text("earliestDate"),
      latestDate: text("latestDate"),
      preferredPeriod: period as PreferredPeriod,
      urgency: urgency as WaitingUrgency,
      durationMinutes: body.durationMinutes == null ? null : Number(body.durationMinutes),
      note: text("note"),
    }, { actor: session.username, actorRole: session.role });

    return result.ok
      ? NextResponse.json(result.entry, { status: 201 })
      : NextResponse.json({ message: result.message }, { status: 409 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الانتظار. أعد المحاولة." }, { status: 500 });
  }
}
