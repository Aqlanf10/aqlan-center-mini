import type { Appointment } from "./schedule";

/**
 * بطاقة المريض — ورقةٌ تخرج بيده فيها رقمُ ملفّه وموعدُه القادم.
 * (منقولة من مستودع الوكيل الآخر aqlan-center-main لمواعيدنا.)
 *
 * والمشكلة التي تحلّها هي **الزحمة** بعينها: المريض يأتي فلا يذكر رقم ملفّه ولا
 * موعده، فيقف عند الاستقبال بينما يُبحث عن اسمه بين المتشابهين — واسمٌ مثل «محمد
 * أحمد» في تعز ليس واحدًا. وبطاقةٌ في جيبه تختصر البحث إلى رقم.
 *
 * **وهي عكس الوصفة عمدًا.** الوصفة تُجمَّد لحظة إصدارها لأنها وثيقةٌ يُصرف بها
 * دواء، وتعديلُ المحفوظ يجعل نسختين تقولان شيئين. أما البطاقة فقيمتها كلُّها في
 * أنها **تقول الحال الآن**: موعدٌ نُقل بعد طبعها يجعل الورقة القديمة خطأً، فلا
 * تُجمَّد — تُبنى عند كل طبعة من الملف الحيّ، **وتحمل تاريخ طبعها** كي يعرف
 * حاملُها متى صحّت. وبطاقةٌ بلا تاريخٍ تُقرأ بعد ستة أشهر على أنها اليوم.
 */

/** أقصى ما يُطبع من المواعيد القادمة — بطاقةٌ فيها عشرة مواعيد لا تُقرأ. */
export const CARD_APPOINTMENTS = 3;

/** المواعيد التي ما زالت قائمة: الملغى ومن لم يحضر لا يُطبعان على بطاقة. */
export function isUpcoming(appointment: Appointment, today: string): boolean {
  if (appointment.status === "cancelled" || appointment.status === "no_show") return false;
  if (appointment.status === "done") return false;
  return appointment.scheduledDate >= today;
}

/**
 * المواعيد القادمة مرتّبةً بالأقرب أوّلًا.
 *
 * والمقارنة نصّيّة على `YYYY-MM-DD` و`HH:MM` — وهما مضبوطان بتوقيت العيادة أصلًا،
 * فتحويلُهما إلى `Date` يُدخل المنطقة الزمنية في مقارنةٍ لا تحتاجها.
 */
export function upcomingAppointments(
  appointments: readonly Appointment[],
  today: string,
  limit: number = CARD_APPOINTMENTS,
): Appointment[] {
  return appointments
    .filter((one) => isUpcoming(one, today))
    .sort((one, two) =>
      one.scheduledDate === two.scheduledDate
        ? one.scheduledTime.localeCompare(two.scheduledTime)
        : one.scheduledDate.localeCompare(two.scheduledDate))
    .slice(0, Math.max(0, limit));
}
