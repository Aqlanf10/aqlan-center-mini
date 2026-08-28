import { toWhatsAppNumber } from "./reminders";
import { addDays } from "./schedule";

/**
 * طلبات الحجز من المرضى — المنطق الخالص.
 *
 * الفرق الجوهري بين هذه الوحدة وبين «حجز إلكتروني» بالمعنى الشائع: المريض هنا **يطلب**
 * موعدًا ولا يحجزه. صفحة عامة بلا تسجيل دخول تكتب في جدول المواعيد مباشرة تعني — في
 * عيادة بكرسيين — يومًا ممتلئًا بأسماء لا أحد يعرف إن كانت حقيقية، وهو انهيار أسوأ من
 * الفوضى الحالية لا علاج لها. فالطلب يصل، والاستقبال تراه وتؤكّده بوقت محدد.
 *
 * ولذلك أيضًا الرد على المريض بعد الإرسال يقول «وصلنا طلبك وسنتصل بك» لا «تم الحجز»:
 * وعدٌ لم يُقطع لا يُخلَف، ومريض جاء ظانًّا أن له موعدًا ثم لم يجده هو نفس شكوى الإهمال
 * التي بُنيت الأداة كلها لعلاجها.
 */

export type PreferredPeriod = "morning" | "evening" | "any";
export type BookingRequestStatus = "new" | "confirmed" | "rejected";

export interface BookingRequestInput {
  fullName: string;
  phone: string;
  reason: string | null;
  preferredDate: string | null;
  preferredPeriod: PreferredPeriod;
}

export interface BookingRequest extends BookingRequestInput {
  id: number;
  status: BookingRequestStatus;
  createdAt: string;
  handledAt: string | null;
  appointmentId: number | null;
}

export const PERIOD_LABELS: Record<PreferredPeriod, string> = {
  morning: "صباحًا",
  evening: "مساءً",
  any: "أي وقت",
};

/** أقصى مدى يُقبل فيه طلب مستقبلي. أبعد من شهرين طلبٌ لن يتذكّره صاحبه. */
export const MAX_DAYS_AHEAD = 60;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type Validation =
  | { ok: true; value: BookingRequestInput }
  | { ok: false; message: string };

/**
 * يتحقق من طلب المريض ويعيد سبب الرفض بالعربية.
 *
 * الرقم هو الحقل الحاسم: طلبٌ برقم لا يصلح لا يمكن تأكيده أصلًا — لا اتصال ولا واتساب —
 * فيبقى في القائمة إلى الأبد. لذلك يُرفض عند الإدخال بينما المريض ما زال أمام الشاشة
 * ويستطيع تصحيحه، لا بعد يومين حين تحاول الاستقبال الاتصال.
 */
export function validateBookingRequest(raw: {
  fullName?: unknown;
  phone?: unknown;
  reason?: unknown;
  preferredDate?: unknown;
  preferredPeriod?: unknown;
}, today: string): Validation {
  const fullName = typeof raw.fullName === "string" ? raw.fullName.trim().replace(/\s+/g, " ") : "";
  if (fullName.length < 3 || fullName.length > 60) {
    return { ok: false, message: "اكتب الاسم الكامل (٣ أحرف فأكثر)." };
  }
  // اسم بلا حرف واحد ليس اسمًا: الحقل المملوء بأرقام أو رموز يأتي من العبث لا من مريض.
  if (!/[؀-ۿA-Za-z]/.test(fullName)) {
    return { ok: false, message: "اكتب الاسم بالحروف." };
  }

  const rawPhone = typeof raw.phone === "string" ? raw.phone : "";
  const phone = toWhatsAppNumber(rawPhone);
  if (!phone) {
    return { ok: false, message: "اكتب رقم جوال يمني صحيح، مثل 7XXXXXXXX." };
  }

  const reasonText = typeof raw.reason === "string" ? raw.reason.trim() : "";
  const reason = reasonText ? reasonText.slice(0, 200) : null;

  let preferredDate: string | null = null;
  if (typeof raw.preferredDate === "string" && raw.preferredDate.trim()) {
    const candidate = raw.preferredDate.trim();
    if (!DATE_PATTERN.test(candidate)) {
      return { ok: false, message: "اختر يومًا من القائمة." };
    }
    if (candidate < today) {
      return { ok: false, message: "اليوم المختار مضى. اختر يومًا قادمًا." };
    }
    if (candidate > addDays(today, MAX_DAYS_AHEAD)) {
      return { ok: false, message: "اختر يومًا خلال الشهرين القادمين." };
    }
    preferredDate = candidate;
  }

  const rawPeriod = typeof raw.preferredPeriod === "string" ? raw.preferredPeriod : "any";
  const preferredPeriod: PreferredPeriod =
    rawPeriod === "morning" || rawPeriod === "evening" ? rawPeriod : "any";

  return { ok: true, value: { fullName, phone, reason, preferredDate, preferredPeriod } };
}

/**
 * رسالة واتساب لتأكيد الموعد للمريض.
 *
 * تُرسَل من الاستقبال بعد أن تحدّد الوقت فعلًا. صياغتها تقول الوقت مرتين — باليوم
 * والساعة — لأن أكثر ما يُنسى في المواعيد ليس وجود الموعد بل يومه.
 */
export function confirmationText(input: {
  patientName: string;
  whenText: string;
  clinicName: string;
  clinicPhone: string;
}): string {
  return [
    `السلام عليكم ${input.patientName}،`,
    ``,
    `وصلنا طلبكم، وحجزنا لكم في ${input.clinicName}:`,
    `${input.whenText}`,
    ``,
    `إن كان الوقت لا يناسبكم أخبرونا لنغيّره — مكانكم محفوظ.`,
    `للتواصل: ${input.clinicPhone}`,
  ].join("\n");
}
