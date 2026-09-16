/**
 * توقيت العيادة — مصدرُ حقيقةٍ واحد.
 *
 * المركز في تعز، واليمن كلّها منطقة `Asia/Aden` (UTC+3 بلا توقيت صيفي). ولا توجد
 * منطقة باسم `Asia/Taiz` في قاعدة المناطق العالمية (IANA)، فالاسم الصحيح للتوقيت
 * المطلوب هو هذا.
 *
 * **لماذا مصدرٌ واحد؟** كان النصّ مكتوبًا يدويًّا في أربعةٍ وثلاثين موضعًا عبر تسعةٍ
 * وعشرين ملفًّا. وذلك ليس تكرارًا شكليًّا: تغييرُ توقيت المركز — فرعٌ ثانٍ، أو انتقال —
 * يتطلّب أربعًا وثلاثين تعديلًا صحيحًا، وواحدٌ يُنسى فتصير شاشةٌ واحدة على يومٍ آخر.
 * وشاشةٌ واحدة على اليوم الخطأ تكفي: كشفُ الحساب يُطبع بيوم الغد، والتقرير اليومي
 * يُسقط زيارات المساء، وقائمة مواعيد اليوم تُعرض فارغة والعيادة ممتلئة.
 *
 * ويُقرأ `CLINIC_TIME_ZONE` من البيئة إن ضُبط — فالقيمة هنا سقفٌ احتياطيّ لا حبس.
 */

/** التوقيت الافتراضي — تعز، اليمن. */
export const CLINIC_ZONE_FALLBACK = "Asia/Aden";

/** هل تعرف بيئة التشغيل هذه المنطقة الزمنية فعلًا؟ */
export function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * يحسم التوقيت المستعمل: المضبوط في البيئة إن كان معروفًا، وإلّا الافتراضي.
 *
 * المنطقة المجهولة تُردّ إلى الافتراضي ولا تُمرَّر: `Intl` ترمي عليها، فيسقط كل
 * حسابٍ لليوم في كل شاشة — خطأٌ مطبعيّ في متغيّر بيئة يُطفئ البرنامج كلّه.
 */
export function resolveClinicZone(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return CLINIC_ZONE_FALLBACK;
  return isKnownZone(trimmed) ? trimmed : CLINIC_ZONE_FALLBACK;
}

/**
 * إزاحةُ منطقةٍ زمنية عن UTC بالدقائق في لحظةٍ بعينها.
 *
 * تُقاس باللحظة لا بالمنطقة وحدها: منطقةٌ ذات توقيتٍ صيفيّ تختلف إزاحتها بين
 * يناير ويوليو، فحسابُها مرّةً واحدة يخطئ نصف السنة.
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    value("year"), value("month") - 1, value("day"),
    value("hour") % 24, value("minute"), value("second"),
  );
  return (asIfUtc - instant.getTime()) / 60_000;
}

/**
 * بدايةُ يومٍ بتوقيت المركز، كلحظةٍ مطلقة.
 *
 * **العطب الذي تُغلقه:** `new Date(\`${date}T00:00:00\`)` يُفسَّر بتوقيت
 * **العملية** لا المركز. وخادمُ الإنتاج يعمل بـUTC والمركز في `Asia/Aden` (+٣)،
 * فكلُّ حسابٍ يقيس «دقائق اليوم» من هذا المنتصف ينزاح ثلاث ساعات. وأثرُ ذلك في
 * حجب الأطباء مضاعف: يُقبل حجزٌ داخل إجازة الطبيب، ويُرفض حجزٌ في وقتٍ هو فيه
 * متاح — وكلاهما صامت.
 *
 * والحسابُ بخطوتين لأنّ الإزاحة تُقاس بلحظةٍ، واللحظةُ هي ما نبحث عنه: تُقدَّر
 * أولًا بإزاحة منتصف الليل UTC، ثمّ تُصحَّح بإزاحة التقدير — فتصحّ حتى على
 * حدود التوقيت الصيفيّ.
 */
export function clinicDayStart(dateISO: string, timeZone: string): Date {
  const naiveUtc = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(naiveUtc)) return new Date(Number.NaN);
  const guess = new Date(naiveUtc - offsetMinutesAt(new Date(naiveUtc), timeZone) * 60_000);
  return new Date(naiveUtc - offsetMinutesAt(guess, timeZone) * 60_000);
}
