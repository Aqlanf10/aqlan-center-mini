/**
 * مُنتظَرو اليوم — من حجز لهذا اليوم ولم يصل بعد، وكم تأخّر.
 *
 * شاشة «اليوم» تعرض من وصل: الطابور والكراسي ومن نُودي عليهم. ولا تعرض من
 * **يُنتظَر**. فموظفة الاستقبال التي تريد أن تعرف «مَن بقي من مواعيد الصباح؟»
 * تترك شاشة العمل وتفتح شاشة المواعيد وتقرأ جدول اليوم كاملًا وتستثني الواصلين
 * بعينها — في ذروة الزحمة، وهي الوقت الذي لا تملك فيه ذلك.
 *
 * وأثر ذلك ليس بطئًا فقط: الموعد الذي تأخّر صاحبه عشرين دقيقة لا يظهر لأحد، فلا
 * يُتَّصل به ولا يُعاد ترتيب الكرسي الفارغ — يجلس الكرسي فارغًا وأمامه صفٌّ ينتظر.
 *
 * الحساب هنا خالص بلا قاعدة ولا شبكة، ليُختبر وحده: التأخير أهمّ رقمٍ في الفقرة،
 * وعرضُه خاطئًا أسوأ من عدم عرضه — «لم يتأخّر» عن متأخّرٍ نصفَ ساعة يُسكِت
 * الاستقبال عن مكالمةٍ كانت ستُنقذ الكرسي.
 */
import { toMinutes, type Appointment } from "./schedule";

/**
 * بعدها يُعدّ المريض متأخّرًا فعلًا — ربع ساعةٍ سماحٌ معتاد في العيادات.
 *
 * صار هذا **الافتراضيَّ** لا القاعدة: القيمة تُقرأ من الإعداد
 * `ops.late_tolerance_minutes`. وبقاؤه هنا مقصود — الدالّة تبقى خالصةً تُختبر بلا
 * قاعدة، ومَن لم يمرّر شيئًا يحصل على سلوك اليوم نفسه حرفًا بحرف.
 */
export const LATE_MINUTES = 15;

export interface ExpectedArrival {
  id: number;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  scheduledTime: string;
  appointmentType: string | null;
  doctorName: string | null;
  /** دقائق التأخّر عن الموعد — صفرٌ لمن لم يحن موعده بعد، فلا سالب يُعرض. */
  lateMinutes: number;
  late: boolean;
}

/**
 * يُرشّح المحجوزين وحدهم ويحسب تأخّر كلٍّ منهم عن موعده.
 *
 * `booked` دون سواها: الواصل صار في الطابور، والملغى والمتغيّب أُغلقا، والمنتهي
 * انصرف. عرضُ أيٍّ منها هنا يجعل الفقرة قائمةَ يومٍ ثانيةً لا قائمةَ انتظار.
 *
 * @param nowTime الساعة الآن بصيغة HH:MM — تُمرَّر ولا تُقرأ من الساعة هنا، فالدالة
 *                تبقى قابلةً للاختبار بلحظةٍ معلومة لا بلحظة تشغيل الاختبار.
 */
export function expectedArrivals(
  appointments: Appointment[],
  nowTime: string,
  lateToleranceMinutes: number = LATE_MINUTES,
): ExpectedArrival[] {
  /* حدٌّ غير معقول (سالب أو غير رقم) يعود إلى الافتراضي: إعدادٌ فاسد لا يُعطّل
     الشاشة، ولا يجعل كل مريضٍ متأخّرًا من اللحظة الأولى. */
  const threshold = Number.isFinite(lateToleranceMinutes) && lateToleranceMinutes >= 0
    ? lateToleranceMinutes
    : LATE_MINUTES;
  const now = toMinutes(nowTime);
  return appointments
    .filter((appointment) => appointment.status === "booked")
    .map((appointment) => {
      const at = toMinutes(appointment.scheduledTime);
      /* وقتٌ غير مفهوم لا يُحسب تأخيرًا مختلقًا: يُعرض الموعد بلا رقم تأخّر. */
      const lateMinutes = now == null || at == null ? 0 : Math.max(0, now - at);
      return {
        id: appointment.id,
        patientId: appointment.patientId,
        patientName: appointment.patientName,
        patientPhone: appointment.patientPhone,
        scheduledTime: appointment.scheduledTime,
        appointmentType: appointment.appointmentType ?? null,
        doctorName: appointment.doctorName ?? null,
        lateMinutes,
        late: lateMinutes >= threshold,
      };
    })
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
}

/** نصٌّ عربيٌّ سليم للتأخير — لا «1 دقيقة» ولا «2 دقائق». */
export function lateText(minutes: number): string {
  if (minutes <= 0) return "";
  if (minutes === 1) return "متأخّر دقيقة";
  if (minutes === 2) return "متأخّر دقيقتين";
  if (minutes < 11) return `متأخّر ${minutes} دقائق`;
  if (minutes < 60) return `متأخّر ${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = hours === 1 ? "ساعة" : hours === 2 ? "ساعتين" : `${hours} ساعات`;
  return rest === 0 ? `متأخّر ${hoursText}` : `متأخّر ${hoursText} و${rest} دقيقة`;
}
