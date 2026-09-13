/**
 * دورة حياة الموعد — الانتقالات المشروعة، خالصةً وقابلةً للاختبار بلا قاعدة.
 *
 * كان `status` نصًّا يُكتب عليه أيُّ شيء: موعدٌ «تمّت» يعود «محجوزًا»، وملغيٌّ يصير
 * «وصل»، ومَن لم يحضر يُقلب «تمّت» بعد أسبوع. ولا أحد يعرف مَن قلبه ولا متى ولا لِمَ.
 * وفي عيادةٍ تُحاسِب أطباءها على ما تمّ، هذا ليس فوضى عرضٍ — هو مالٌ يتحرّك.
 *
 * فهذا الملفّ يُثبّت مفردات الحالة وما يجوز منها إلى ماذا. **والفرضُ في الخادم**:
 * الشرط يُكتب داخل جملة `UPDATE` نفسها لا في فحصٍ قبلها، فجهازان يضغطان معًا لا
 * يمحو أحدهما الآخر. وهذه الوحدة تقول «ما القانون»، و`lib/db.ts` هو من يفرضه.
 */
import type { AppointmentStatus } from "./schedule";

export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] =
  ["booked", "arrived", "done", "cancelled", "no_show"] as const;

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: "محجوز",
  arrived: "وصل",
  done: "تمّت",
  cancelled: "ملغى",
  no_show: "لم يحضر",
};

/**
 * من أيّ حالةٍ يجوز الوصول إلى كلّ حالة.
 *
 * القاعدة الحاكمة: **النهائيّ لا يُفتح**. «تمّت» و«ملغى» و«لم يحضر» نهاياتٌ يُبنى
 * عليها حسابٌ ومتابعة، وفتحُها بعد حين يعيد كتابة ماضٍ اطّلع عليه الناس وتصرّفوا
 * بناءً عليه. التصحيح يكون بموعدٍ جديد لا بقلب القديم — كما يُصحَّح القيد المالي
 * بقيدٍ معاكس لا بمحوه.
 */
export const ALLOWED_FROM: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  booked: [],
  arrived: ["booked"],
  /* «تمّت» من «وصل» في اليوم العادي، ومن «محجوز» لموعدٍ مضى ولم يُغلَق — وهو
     الباب الذي تُغلق منه قائمة المواعيد المعلّقة. */
  done: ["arrived", "booked"],
  cancelled: ["booked"],
  no_show: ["booked"],
};

export function isTerminal(status: AppointmentStatus): boolean {
  return status === "done" || status === "cancelled" || status === "no_show";
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  if (from === to) return false;
  return ALLOWED_FROM[to].includes(from);
}

/** الحالات التي يجوز الانتقال منها إلى `to` — تُحقن في شرط جملة التحديث. */
export function allowedSources(to: AppointmentStatus): readonly AppointmentStatus[] {
  return ALLOWED_FROM[to];
}

/**
 * سببُ الإلغاء مطلوب.
 *
 * «ألغاه من؟ ولماذا؟» سؤالٌ يُسأل بعد أسبوع حين يشتكي المريض أنه حضر ولم يجد موعده.
 * وسجلٌّ بلا سببٍ يجيب «أُلغي» ولا يجيب السؤال.
 */
export function requiresReason(to: AppointmentStatus): boolean {
  return to === "cancelled";
}

export function reasonAcceptable(reason: string | null | undefined): boolean {
  return (reason ?? "").trim().length >= 3;
}

/** رسالةُ الرفض تقول الحالَ الحاضر لا «ممنوع» — فالمستخدم يحتاج أن يعرف ماذا جرى. */
export function rejectionMessage(from: AppointmentStatus, to: AppointmentStatus): string {
  if (from === to) return `الموعد ${STATUS_LABEL[to]} أصلًا.`;
  if (isTerminal(from)) {
    return `الموعد ${STATUS_LABEL[from]} — لا يُعاد فتحه. احجز موعدًا جديدًا إن لزم.`;
  }
  return `لا يصحّ الانتقال من «${STATUS_LABEL[from]}» إلى «${STATUS_LABEL[to]}».`;
}

/** أفعال التدقيق — فعلٌ لكل انتقال، فيُستخرج السجلّ بلا خلطٍ مع غيره. */
export function transitionAction(to: AppointmentStatus): string {
  return `appointment.${to}`;
}
