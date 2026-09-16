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
  CLINIC_TIME_ZONE, getSettings, listAppointmentServices, listProviderBlocks,
  resolveServiceByLegacyType, type DbClient,
} from "./db";
import { clinicDayStart } from "./clinicZone";
import { chairCount } from "./settings";
import { judgeFullCapacity, type CapacityVerdict, type ProviderBlockWindow, type Shift } from "./capacity";
import type { AppointmentService } from "./appointment-services";
import type { Appointment } from "./schedule";

export interface CapacityContext {
  shifts: Shift[];
  chairs: number;
  nearCapacityPercent: number;
  emergencyReserveMinutes: number;
  newPatientDailyLimit: number;
}

/** يقرأ سياسة السعة من الإعدادات — مصدرٌ واحد لساعات المركز وطاقته. */
export async function loadCapacityContext(): Promise<CapacityContext> {
  const settings = await getSettings();
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
  return {
    shifts,
    chairs: chairCount(settings),
    nearCapacityPercent: number("scheduling.near_capacity_percent", 80),
    emergencyReserveMinutes: number("scheduling.emergency_reserve_minutes", 0),
    newPatientDailyLimit: number("scheduling.new_patient_daily_limit", 0),
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

/** الخدمة الافتراضية حين لا تُحدَّد — لا تُعطّل الحجز ولا تفرض متطلّباتٍ وهمية. */
export const FALLBACK_SERVICE = {
  requiresProvider: false,
  requiresChair: true,
  allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false,
  isActive: true,
  nameAr: "إجراء عام",
} as const;

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
export async function evaluateCapacity(input: {
  sameDay: Appointment[];
  date: string;
  time: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  service: AppointmentService | null;
  context: CapacityContext;
  providerId?: number | null;
  chairNo?: number | null;
  isNewPatient?: boolean;
  newPatientsBookedToday?: number;
  excludeId?: number;
  /** اتصال المعاملة حين يُقيَّم داخل قفل اليوم — فلا اتصالَ ثانٍ ولا لقطةٌ أقدم. */
  client?: DbClient;
}): Promise<CapacityVerdict> {
  const { service, context } = input;
  const blocks: ProviderBlockWindow[] = [];
  if (service?.requiresProvider && input.providerId) {
    /* **يفشل مغلقًا.** كان `.catch(() => [])` يبتلع فشل القراءة فيصير الطبيب
       «متاحًا دائمًا» — فيُحجز فوق إجازته أو عمليّته بلا أن يشكو شيء. وحارسٌ
       يفشل مفتوحًا ليس حارسًا: ما لا يُتحقَّق منه يُردّ برسالةٍ صريحة، ولصاحب
       الصلاحية بابُ التجاوز بسببٍ يُسجَّل. */
    let raw: Awaited<ReturnType<typeof listProviderBlocks>>;
    try {
      raw = await listProviderBlocks(input.providerId, input.date, input.client);
    } catch {
      const reason = "تعذّر التحقّق من توافر الطبيب — لم يُحجز حتى يُتأكَّد.";
      return {
        state: "OVER_CAPACITY", occupiedChairs: 0, chairs: context.chairs,
        dayPercent: 0, outsideHours: false, message: reason, reasons: [reason],
      };
    }
    /* ومنتصفُ الليل بتوقيت **المركز** لا بتوقيت العملية: الخادم يعمل بـUTC
       والمركز على منطقته المعتمدة (`CLINIC_TIME_ZONE`)، فقياسُ «دقائق اليوم»
       من منتصف ليلٍ محلّيّ للعملية يُزيح كلّ نافذة حجبٍ بفارق المنطقتين. */
    const dayStart = clinicDayStart(input.date, CLINIC_TIME_ZONE);
    for (const block of raw) {
      /* الحجب يُقاس بدقائق اليوم نفسه: ما قبل بدايته أو بعد نهايته يُقصّ على حدّه. */
      const start = new Date(block.startsAt);
      const end = new Date(block.endsAt);
      blocks.push({
        startMinutes: Math.max(0, Math.round((start.getTime() - dayStart.getTime()) / 60000)),
        endMinutes: Math.min(24 * 60, Math.round((end.getTime() - dayStart.getTime()) / 60000)),
        reason: block.reason,
      });
    }
  }

  return judgeFullCapacity({
    appointments: input.sameDay,
    date: input.date,
    time: input.time,
    durationMinutes: input.durationMinutes,
    bufferBeforeMinutes: input.bufferBeforeMinutes ?? service?.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: input.bufferAfterMinutes ?? service?.bufferAfterMinutes ?? 0,
    chairs: context.chairs,
    shifts: context.shifts,
    nearCapacityPercent: context.nearCapacityPercent,
    service: service ?? FALLBACK_SERVICE,
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

export { toMinutes as capacityTimeToMinutes };
