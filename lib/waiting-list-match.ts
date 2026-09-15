/**
 * مطابقة المكان الشاغر بقائمة الانتظار — عمليةٌ واحدة في الخادم.
 *
 * كانت المطابقة تعيش في `app/appointments/page.tsx` وحدها: شاشةٌ واحدة تعرف
 * كيف يُنادى المنتظرون، وكلُّ بابٍ آخر يفتح مكانًا — إلغاءٌ من بوّابة المريض،
 * أو عدمُ حضورٍ يُسجَّل من شاشة اليوم، أو نقلُ موعدٍ إلى يومٍ آخر، أو الوكيل
 * الذكيّ — يفتحه صامتًا. والمكان الذي يشغر ولا يعلم به أحد هو بالضبط الكرسيّ
 * الفارغ الذي يشكو منه المركز بينما القائمة ممتلئة.
 *
 * فالمطابقة هنا: منطقٌ واحد، في الخادم، يستدعيه كلُّ بابٍ يفتح مكانًا. ولا
 * تُكرَّر في React — الشاشة تعرض ما يقوله الخادم ولا تحكم بنفسها.
 *
 * وحدُّها الصارم: **هذه الوحدة ترشِّح ولا تحجز.** لا تكتب في `appointments`
 * ولا تغيّر حالة صفٍّ واحد؛ التحويل إلى موعدٍ بابُه `convertWaitingToAppointment`
 * وحده، وهو يمرّ بمحرّك السعة كما يمرّ أيُّ حجزٍ آخر.
 */
import {
  doctorOwnedPatientIds, findUserByUsername, getAppointment, getSettings,
  listAppointmentsByDate, listWaitingContactEventsFor, listWaitingEntries,
} from "./db";
import { CLINIC_TIME_ZONE } from "./db";
import { clinicDateString } from "./schedule";
import { loadCapacityContext } from "./capacity-context";
import {
  explainMatch, describeMatch, isExpired, rankCandidates,
  type ContactEvent, type FreedSlot, type MatchFacts, type MatchContext,
  type WaitingEntry,
} from "./waiting-list";
import type { SessionPayload } from "./auth";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/** المكان الشاغر كما يصفه الباب الذي فتحه. */
export interface FreedSlotRequest {
  date: string;
  time: string;
  durationMinutes?: number | null;
  /** خدمةُ المكان — تُكمَل من الموعد الأصل حين يُمرَّر رقمه. */
  serviceId?: number | null;
  doctorId?: number | null;
  /** الموعدُ الذي شغر مكانه — مصدرُ الحقائق الأدقّ حين يوجد. */
  appointmentId?: number | null;
}

export interface WaitingCandidate {
  entry: WaitingEntry;
  facts: MatchFacts;
  /** سببُ الترشيح بالعربية — الاستقبال يقرأ «لماذا هذا الاسم» لا رقمًا غامضًا. */
  reason: string;
}

export interface WaitingCandidatesResult {
  slot: FreedSlot;
  candidates: WaitingCandidate[];
  /** كم صفًّا مفتوحًا فُحص — يُميّز «لا أحد يصلح» عن «القائمة فارغة». */
  examined: number;
}

/**
 * عزلُ الطبيب — الحارس نفسه في كلّ باب.
 *
 * صفُّ الانتظار يحمل اسم المريض ورقم هاتفه، فقائمةٌ بلا عزلٍ تُطلع طبيبًا على
 * مرضى زملائه من بابٍ لم يُحرَس. وإخفاءُ الاسم في الشاشة ليس تفويضًا.
 */
export async function scopeWaitingEntries(
  session: SessionPayload, entries: WaitingEntry[],
): Promise<WaitingEntry[]> {
  if (session.role !== "doctor") return entries;
  const user = await findUserByUsername(session.username).catch(() => null);
  if (user?.permissions?.canViewAllPatients) return entries;
  const doctorPartyId = user?.partyId
    ?? (typeof session.partyId === "number" ? session.partyId : null);
  if (!doctorPartyId) return [];
  const owned = await doctorOwnedPatientIds(
    doctorPartyId, Array.from(new Set(entries.map((entry) => entry.patientId))),
  ).catch(() => new Set<number>());
  return entries.filter(
    (entry) => entry.doctorId === doctorPartyId || owned.has(entry.patientId),
  );
}

/** «اليوم» بتوقيت المركز — لا `toISOString` التي تُقدّم اليوم ثلاث ساعات مساءً. */
export function clinicToday(now: Date = new Date()): string {
  return clinicDateString(now, CLINIC_TIME_ZONE);
}

/** مدّة البقاء المهيّأة — صفرٌ يعني بلا انتهاء، وهو الافتراضيّ. */
export async function waitingHoldDays(): Promise<number> {
  const settings = await getSettings().catch(() => null);
  const raw = Number(settings?.["scheduling.waiting_list_hold_days"] ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** يعلّم الصفوف المنتهية بدل حذفها — القائمة تبقى ويُعلَّم فيها ما طال. */
export function markStale(
  entries: WaitingEntry[], today: string, holdDays: number,
): WaitingEntry[] {
  return entries.map((entry) => ({
    ...entry,
    isStale: holdDays > 0 ? isExpired(entry, today, holdDays) : false,
  }));
}

/**
 * يُكمل وصف المكان من الموعد الأصل.
 *
 * الشاشة كانت ترسل التاريخ والوقت والمدّة والطبيب **ولا ترسل الخدمة**، فيُرشَّح
 * لمكان «تقويم» من ينتظر «خلع» لأنّ المدّة اتّسعت. والخدمة هنا تُقرأ من لقطة
 * الموعد الملغى نفسه — لا تُخمَّن ولا تُترك فارغة إن كانت معروفة.
 */
export async function resolveFreedSlot(request: FreedSlotRequest): Promise<FreedSlot | null> {
  const date = String(request.date ?? "").trim();
  const time = String(request.time ?? "").trim();
  if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) return null;

  let serviceId = Number.isInteger(Number(request.serviceId)) && Number(request.serviceId) > 0
    ? Number(request.serviceId) : null;
  let doctorId = Number.isInteger(Number(request.doctorId)) && Number(request.doctorId) > 0
    ? Number(request.doctorId) : null;
  let durationMinutes = Number.isFinite(Number(request.durationMinutes))
    && Number(request.durationMinutes) > 0 ? Math.round(Number(request.durationMinutes)) : 0;

  const appointmentId = Number(request.appointmentId);
  if (Number.isInteger(appointmentId) && appointmentId > 0) {
    const source = await getAppointment(appointmentId).catch(() => null);
    if (source && source.scheduledDate === date) {
      if (serviceId === null) serviceId = source.serviceId ?? null;
      if (doctorId === null) doctorId = source.doctorId ?? null;
      if (!durationMinutes) durationMinutes = source.durationMinutes;
    }
  }

  /* وحين لا يُمرَّر رقم الموعد — كنداءٍ يدويّ على وقتٍ فارغ — تُقرأ وقائع
     المكان من موعد اليوم الواقع في هذا الوقت إن وُجد. والخدمة تُستكمل من هنا
     أيضًا: كانت الشاشة ترسل المدّة بلا خدمة، فيُرشَّح لمكانٍ خدمتُه معروفة من
     ينتظر خدمةً أخرى لمجرّد أنّ الدقائق اتّسعت. */
  if (serviceId === null || doctorId === null || !durationMinutes) {
    const sameDay = await listAppointmentsByDate(date).catch(() => []);
    const head = time.padStart(5, "0");
    const source = sameDay.find(
      (appointment) => appointment.scheduledTime.slice(0, 5) === head,
    );
    if (source) {
      if (serviceId === null) serviceId = source.serviceId ?? null;
      if (doctorId === null) doctorId = source.doctorId ?? null;
      if (!durationMinutes) durationMinutes = source.durationMinutes;
    }
  }

  /* وآخرُ ملجأ ثلاثون دقيقة — يُعلَن في التوثيق ولا يُدفن: لا سبيل لمعرفة مدّة
     مكانٍ لم يُحجز قطّ، والبديل هو رفضُ الترشيح كلّه. */
  if (!durationMinutes) durationMinutes = 30;

  return { date, time: time.padStart(5, "0"), durationMinutes, serviceId, doctorId };
}

/**
 * مرشَّحو مكانٍ شاغر — الباب الوحيد الذي تستدعيه كلُّ الشاشات والمسارات.
 *
 * `session` اختياريّ فقط للمسارات الداخلية التي لا جلسة لها (مهامٌ مجدولة)؛
 * ومسارات HTTP تمرّره دائمًا فيُطبَّق عزلُ الطبيب.
 */
export async function findWaitingCandidatesForSlot(
  request: FreedSlotRequest,
  options: { session?: SessionPayload | null } = {},
): Promise<WaitingCandidatesResult | null> {
  const slot = await resolveFreedSlot(request);
  if (!slot) return null;

  const [context, open, holdDays] = await Promise.all([
    loadCapacityContext(),
    listWaitingEntries({}),
    waitingHoldDays(),
  ]);

  const today = clinicToday();
  const scoped = options.session
    ? await scopeWaitingEntries(options.session, open)
    : open;
  const entries = markStale(scoped, today, holdDays);

  const history = await listWaitingContactEventsFor(entries.map((entry) => entry.id))
    .catch(() => new Map<number, ContactEvent[]>());
  const historyOf = (entry: WaitingEntry) => history.get(entry.id) ?? [];

  const matchContext: MatchContext = { shifts: context.shifts, clinicToday: today };
  const ranked = rankCandidates(entries, slot, matchContext, historyOf);

  return {
    slot,
    examined: entries.length,
    candidates: ranked.map((entry) => {
      const facts = explainMatch(entry, slot, matchContext, historyOf(entry));
      return { entry, facts, reason: describeMatch(facts) };
    }),
  };
}
