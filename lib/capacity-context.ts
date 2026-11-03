/**
 * مسارُ تقييم السعة الوحيد.
 *
 * الحُكم يجب أن يكون واحدًا مهما كان الباب: شاشة المواعيد، والحجز السريع، وتحويل
 * طلب مريض، والزيارة التالية، وأدوات الوكيل الذكي. وبابٌ يحكم بقواعده الخاصة هو
 * بالضبط كيف يعود الازدحام بعد أن مُنع.
 *
 * فهذه الوحدة تجمع التهيئة الحيّة — الإعدادات، والخدمة، وحجب الطبيب — وتسلّمها
 * للمحرّك. ولا يبني أيُّ مسارٍ حكمَه بنفسه.
 */
import {
  CLINIC_TIME_ZONE, getSettings, getSettingsWith, listAppointmentServices, listAppointmentServicesWith,
  listProviderBlocks, resolveServiceByLegacyType, resolveServiceByLegacyTypeWith, type DbClient,
} from "./db";
import { clinicDayStart } from "./clinicZone";
import { chairCount, type SettingsMap } from "./settings";
import { judgeFullCapacity, type CapacityVerdict, type ProviderBlockWindow, type Shift } from "./capacity";
import type { AppointmentService } from "./appointment-services";
import type { Appointment } from "./schedule";

export interface CapacityContext {
  shifts: Shift[];
  chairs: number;
  nearCapacityPercent: number;
  emergencyReserveMinutes: number;
  newPatientDailyLimit: number;
  strictHours?: boolean;
  closedWeekdays?: number[];
}

/** يقرأ سياسة السعة من الإعدادات — مصدرٌ واحد لساعات المركز وطاقته. */
export async function loadCapacityContext(): Promise<CapacityContext> {
  return capacityContextFrom(await getSettings());
}

/** The same context read on the caller's client (canonical snapshots, M2 slice 19). */
export async function loadCapacityContextWith(q: Pick<DbClient, "query">): Promise<CapacityContext> {
  return capacityContextFrom(await getSettingsWith(q));
}

const WEEKDAY_TOKEN: Record<string, number> = {
  "0": 0, sun: 0, sunday: 0, "الأحد": 0, "الاحد": 0,
  "1": 1, mon: 1, monday: 1, "الاثنين": 1, "الإثنين": 1,
  "2": 2, tue: 2, tuesday: 2, "الثلاثاء": 2,
  "3": 3, wed: 3, wednesday: 3, "الأربعاء": 3, "الاربعاء": 3,
  "4": 4, thu: 4, thursday: 4, "الخميس": 4,
  "5": 5, fri: 5, friday: 5, "الجمعة": 5, "الجمعه": 5,
  "6": 6, sat: 6, saturday: 6, "السبت": 6,
};

function parseClosedWeekdays(raw: string | undefined): number[] {
  if (!raw || !raw.trim()) return [];
  const days = new Set<number>();
  for (const token of raw.split(/[,\u060C;]+/)) {
    const key = token.trim().toLowerCase();
    if (key in WEEKDAY_TOKEN) days.add(WEEKDAY_TOKEN[key]);
  }
  return [...days].sort((a, b) => a - b);
}

function capacityContextFrom(settings: SettingsMap): CapacityContext {
  const shifts: Shift[] = [
    { start: settings["clinic.day_start"], end: settings["clinic.day_end"] },
  ];
  const second = {
    start: (settings["clinic.shift2_start"] ?? "").trim(),
    end: (settings["clinic.shift2_end"] ?? "").trim(),
  };
  /* الوردية الثانية اختيارية: فارغةٌ تعني دوامًا متّصلًا، لا يومًا بلا عمل. */
  if (second.start && second.end) shifts.push(second);

  const number = (key: string, fallback: number): number => {
    const parsed = Number(settings[key as keyof typeof settings]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const strictRaw = (settings["scheduling.strict_hours"] ?? "").trim().toLowerCase();
  return {
    shifts,
    chairs: chairCount(settings),
    nearCapacityPercent: number("scheduling.near_capacity_percent", 80),
    emergencyReserveMinutes: number("scheduling.emergency_reserve_minutes", 0),
    newPatientDailyLimit: number("scheduling.new_patient_daily_limit", 0),
    strictHours: strictRaw === "true" || strictRaw === "on" || strictRaw === "1",
    closedWeekdays: parseClosedWeekdays(settings["clinic.closed_weekdays"]),
  };
}

/**
 * يحسم الخدمة المطلوبة.
 *
 * يقبل المعرِّف الرقميّ (الطريق الجديد) والرمز النصّيّ القديم (`consultation`…)
 * فيبقى ما بُني قبل هذه المرحلة عاملًا. والغياب لا يُسقط الحجز: يُعاد `null`
 * ويعامل الموعد كإجراءٍ عام بمدّته المُرسَلة.
 */
export async function resolveService(input: {
  serviceId?: number | null;
  appointmentType?: string | null;
}): Promise<AppointmentService | null> {
  if (input.serviceId) {
    const all = await listAppointmentServices({ includeInactive: true });
    return all.find((service) => service.id === input.serviceId) ?? null;
  }
  if (input.appointmentType) return await resolveServiceByLegacyType(input.appointmentType);
  return null;
}

/** Same lookup inside a caller-owned snapshot/transaction (no ensureSchema). */
export async function resolveServiceWith(
  q: Pick<DbClient, "query">,
  input: { serviceId?: number | null; appointmentType?: string | null },
): Promise<AppointmentService | null> {
  if (input.serviceId) {
    const all = await listAppointmentServicesWith(q, { includeInactive: true });
    return all.find((service) => service.id === input.serviceId) ?? null;
  }
  if (input.appointmentType) return await resolveServiceByLegacyTypeWith(q, input.appointmentType);
  return null;
}

/** الخدمة الافتراضية حين لا تُحدَّد — لا تُعطّل الحجز ولا تفرض متطلّباتٍ وهمية. */
export const FALLBACK_SERVICE = {
  requiresProvider: false,
  requiresChair: true,
  allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false,
  isActive: true,
  nameAr: "إجراء عام",
} as const;

/** نوافذ حجب الطبيب بالدقائق من بداية يوم المركز؛ تُقرأ مرة واحدة عند عرض اليوم. */
export async function loadProviderBlockWindows(
  providerId: number, date: string, client?: Pick<DbClient, "query">,
): Promise<ProviderBlockWindow[]> {
  const raw = await listProviderBlocks(providerId, date, client);
  const dayStart = clinicDayStart(date, CLINIC_TIME_ZONE);
  if (Number.isNaN(dayStart.getTime())) throw new Error("Invalid clinic day");
  return raw.map((block) => ({
    startMinutes: Math.max(0, Math.round((new Date(block.startsAt).getTime() - dayStart.getTime()) / 60000)),
    endMinutes: Math.min(24 * 60, Math.round((new Date(block.endsAt).getTime() - dayStart.getTime()) / 60000)),
    reason: block.reason,
  }));
}

const toMinutes = (value: string): number => {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
};

/**
 * الحكم الكامل لمسارٍ واحد.
 *
 * `sameDay` تأتي من داخل قفل اليوم الذرّي، فالحكم يرى ما رآه القفل — لا لقطةً
 * أقدم منه.
 */
export interface CapacityEvaluationInput {
  sameDay: Appointment[];
  date: string;
  time: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  service: AppointmentService | null;
  context: CapacityContext;
  providerId?: number | null;
  /** A sourced clinical return consumes its clinician even without a catalogue service. */
  requireAssignedProvider?: boolean;
  chairNo?: number | null;
  isNewPatient?: boolean;
  newPatientsBookedToday?: number;
  excludeId?: number;
  /** اتصال المعاملة حين يُقيَّم داخل قفل اليوم — فلا اتصالَ ثانٍ ولا لقطةٌ أقدم. */
  client?: Pick<DbClient, "query">;
}

/** Freeze verified block windows once for the decision and its alternatives. */
export async function prepareCapacityEvaluator(input: CapacityEvaluationInput): Promise<(time: string) => CapacityVerdict> {
  const { service, context } = input;
  const capacityService = service ?? ((input.requireAssignedProvider ?? Boolean(input.providerId))
    ? { ...FALLBACK_SERVICE, requiresProvider: true } : FALLBACK_SERVICE);
  const blocks: ProviderBlockWindow[] = [];
  if (capacityService.requiresProvider && input.providerId) {
    /* **يفشل مغلقًا.** كان `.catch(() => [])` يبتلع فشل القراءة فيصير الطبيب
       «متاحًا دائمًا» — فيُحجز فوق إجازته أو عمليّته بلا أن يشكو شيء. وحارسٌ
       يفشل مفتوحًا ليس حارسًا: ما لا يُتحقَّق منه يُردّ برسالةٍ صريحة، ولصاحب
       الصلاحية بابُ التجاوز بسببٍ يُسجَّل. */
    try {
      blocks.push(...await loadProviderBlockWindows(input.providerId, input.date, input.client));
    } catch {
      const reason = "تعذّر التحقّق من توافر الطبيب — لم يُحجز حتى يُتأكَّد.";
      return () => ({
        state: "OVER_CAPACITY", occupiedChairs: 0, chairs: context.chairs,
        dayPercent: 0, outsideHours: false, message: reason, reasons: [reason],
      });
    }
  }

  return (time) => judgeFullCapacity({
    appointments: input.sameDay,
    date: input.date,
    time,
    durationMinutes: input.durationMinutes,
    bufferBeforeMinutes: input.bufferBeforeMinutes ?? service?.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: input.bufferAfterMinutes ?? service?.bufferAfterMinutes ?? 0,
    chairs: context.chairs,
    shifts: context.shifts,
    nearCapacityPercent: context.nearCapacityPercent,
    service: capacityService,
    providerId: input.providerId ?? null,
    chairNo: input.chairNo ?? null,
    providerBlocks: blocks,
    emergencyReserveMinutesPerShift: context.emergencyReserveMinutes,
    newPatientDailyLimit: context.newPatientDailyLimit,
    isNewPatient: input.isNewPatient ?? false,
    newPatientsBookedToday: input.newPatientsBookedToday ?? 0,
    excludeId: input.excludeId,
  });
}

export async function evaluateCapacity(input: CapacityEvaluationInput): Promise<CapacityVerdict> {
  return (await prepareCapacityEvaluator(input))(input.time);
}

export { toMinutes as capacityTimeToMinutes };
