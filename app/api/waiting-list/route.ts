import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  addWaitingEntry, listWaitingContactEventsFor, listWaitingEntries,
} from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import {
  clinicToday, findWaitingCandidatesForSlot, markStale, scopeWaitingEntries,
  waitingHoldDays,
} from "@/lib/waiting-list-match";
import {
  PERIODS, SHIFTS, URGENCIES, normalizeWeekdays,
  type ContactEvent, type PreferredPeriod, type PreferredShift, type WaitingUrgency,
} from "@/lib/waiting-list";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalWaitingFailure } from "@/lib/canonical-patient-http";
import { commandCanonicalWaitingAdd, parseCanonicalWaitingAdd, readCanonicalFreedSlotCandidates, readCanonicalWaitingList } from "@/lib/canonical-waiting-list";

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
 * ومعاملاتُ المكان الشاغر (`date` و`time` و`serviceId` و`appointmentId`) تحوّلها
 * إلى **ترشيح**: والمطابقة تجري في `lib/waiting-list-match` — منطقٌ واحد يشترك
 * فيه كلُّ بابٍ يفتح مكانًا، لا نسخةٌ في كلّ شاشة.
 */
export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    // Canonical identity (M2 slice 14): entries inside the appointment scope; the free-slot
    // matching mode (slice 19) ranks the entries inside the scope in its own snapshot.
    const params = new URL(request.url).searchParams;
    try {
      const list = await readCanonicalWaitingList(selected.handle, {
        includeResolved: params.get("includeResolved") === "1", withHistory: params.get("withHistory") === "1",
      });
      const date = params.get("date") ?? "", time = params.get("time") ?? "";
      if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) return NextResponse.json(list, { headers: NO_STORE });
      const positive = (key: string) => { const value = Number(params.get(key)); return Number.isInteger(value) && value > 0 ? value : null; };
      const match = await readCanonicalFreedSlotCandidates(selected.handle, {
        date, time, durationMinutes: positive("durationMinutes"), serviceId: positive("serviceId"),
        doctorId: positive("doctorId"), appointmentId: positive("appointmentId"),
      });
      if (!match) return NextResponse.json(list, { headers: NO_STORE });
      return NextResponse.json({
        ...list, slot: match.slot, examined: match.examined,
        candidates: match.candidates.map(candidate => ({ ...candidate.entry, matchFacts: candidate.facts, matchReason: candidate.reason })),
      }, { headers: NO_STORE });
    } catch (error) {
      return canonicalWaitingFailure(error, "تعذّر تحميل قائمة الانتظار.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  try {
    const raw = await listWaitingEntries({
      includeResolved: params.get("includeResolved") === "1",
    });

    /* عزلُ الطبيب — الحارس نفسه الذي يحمي `/api/patients` و`/api/appointments`،
       ومن الوحدة المشتركة فلا يتفرّق تطبيقُه بين مسارٍ وآخر. */
    const scoped = await scopeWaitingEntries(session, raw);

    /* مدّة البقاء: إعدادٌ يُقرأ ويُطبَّق. وإعدادٌ يبدو فاعلًا وهو معطَّل أسوأ من
       إعدادٍ غير موجود — وهو الدرس نفسه من حدّ المرضى الجدد في المرحلة ٤ب.
       والانتهاء علامةٌ للمراجعة لا حذف: الصفّ يبقى ويُعلَّم.
       و«اليوم» بتوقيت المركز: `toISOString` تُقدّم اليوم ثلاث ساعاتٍ مساءً في
       تعز، فتُعلَّم صفوفٌ لم تنتهِ بعد. */
    const entries = markStale(scoped, clinicToday(), await waitingHoldDays());

    /* سجلّ الاتصال يُرسَل مع القائمة: الشاشة تحتاجه لتقول «كُلّم ٣ مرات، آخرها
       لم يردّ» بدل «نودي» الغامضة. */
    let history: Record<number, ContactEvent[]> = {};
    if (params.get("withHistory") === "1" && entries.length > 0) {
      const map = await listWaitingContactEventsFor(entries.map((entry) => entry.id))
        .catch(() => new Map<number, ContactEvent[]>());
      history = Object.fromEntries(map);
    }

    const date = params.get("date") ?? "";
    const time = params.get("time") ?? "";
    if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) {
      return NextResponse.json({ entries, history });
    }

    const requestedDuration = Number(params.get("durationMinutes"));
    const requestedService = Number(params.get("serviceId"));
    const requestedDoctor = Number(params.get("doctorId"));
    const requestedAppointment = Number(params.get("appointmentId"));

    const match = await findWaitingCandidatesForSlot({
      date, time,
      durationMinutes: Number.isFinite(requestedDuration) && requestedDuration > 0
        ? requestedDuration : null,
      serviceId: Number.isInteger(requestedService) && requestedService > 0
        ? requestedService : null,
      doctorId: Number.isInteger(requestedDoctor) && requestedDoctor > 0
        ? requestedDoctor : null,
      appointmentId: Number.isInteger(requestedAppointment) && requestedAppointment > 0
        ? requestedAppointment : null,
    }, { session });

    if (!match) return NextResponse.json({ entries, history });
    return NextResponse.json({
      entries,
      history,
      slot: match.slot,
      examined: match.examined,
      candidates: match.candidates.map((candidate) => ({
        ...candidate.entry, matchFacts: candidate.facts, matchReason: candidate.reason,
      })),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قائمة الانتظار." }, { status: 500 });
  }
}

/**
 * إضافةُ منتظر.
 *
 * والجلسةُ وحدها ليست تفويضًا: من لا يملك فتح ملفّ المريض لا يُدخله صفَّ انتظار
 * ولا يقرأ اسمه من ردّ التكرار. فالحارس هنا هو `canAccessPatient` نفسه الذي
 * يحمي الملفّ الطبيّ — لا فحصُ «هل معه جلسة».
 */
export async function POST(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    // Canonical identity (M2 slice 14): add on appointments.edit, patient inside the scope.
    let canonicalBody: unknown;
    try {
      canonicalBody = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
      return NextResponse.json({ code: "invalid_waiting_input", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    try {
      return NextResponse.json(await commandCanonicalWaitingAdd(selected.handle, parseCanonicalWaitingAdd(canonicalBody)), { status: 201, headers: NO_STORE });
    } catch (error) {
      return canonicalWaitingFailure(error, "تعذّر حفظ الانتظار. أعد المحاولة.");
    }
  }
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

  const patientId = Number(body.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "لا تملك صلاحية على ملفّ هذا المريض." }, { status: 403 });
  }

  const period = text("preferredPeriod") ?? "any";
  const urgency = text("urgency") ?? "normal";
  const shift = text("preferredShift") ?? "any";
  if (!PERIODS.includes(period as PreferredPeriod)) {
    return NextResponse.json({ message: "الفترة المفضّلة غير معروفة." }, { status: 400 });
  }
  if (!URGENCIES.includes(urgency as WaitingUrgency)) {
    return NextResponse.json({ message: "درجة الإلحاح غير معروفة." }, { status: 400 });
  }
  if (!SHIFTS.includes(shift as PreferredShift)) {
    return NextResponse.json({ message: "الوردية المفضّلة غير معروفة." }, { status: 400 });
  }

  /* الأيام المفضّلة: قيمةٌ خارج ١..٧ تُرفض ولا تُسقَط صامتةً — إسقاطُها يحفظ
     تفضيلًا غير الذي كتبه الموظّف ثم يُنادى المريض في يومٍ لا يأتي فيه. */
  const days = body.preferredDays === undefined
    ? [] : normalizeWeekdays(body.preferredDays);
  if (days === null) {
    return NextResponse.json({ message: "أيام الأسبوع المفضّلة غير صالحة." }, { status: 400 });
  }

  try {
    const result = await addWaitingEntry({
      patientId,
      serviceId: integer("serviceId"),
      doctorId: integer("doctorId"),
      earliestDate: text("earliestDate"),
      latestDate: text("latestDate"),
      preferredPeriod: period as PreferredPeriod,
      preferredShift: shift as PreferredShift,
      preferredDays: days,
      sameDayAvailable: body.sameDayAvailable === undefined
        ? true : body.sameDayAvailable !== false,
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
