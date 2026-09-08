import { isHostTrusted } from "./net";
/**
 * دعوةُ المريض إلى بوابته — الرابط والنصّ الذي يُرسل به.
 *
 * فالبوابة بُنيت وتعمل (`app/portal`) **ولا شيء في البرنامج يدلّ عليها**: لا
 * رابطَ في شاشة، ولا زرَّ يُرسلها، ولا سطرَ يقول إنّها موجودة. فبقيت كصندوقٍ
 * أُغلق عليه بابُه — لا المالك يراها، ولا المريض يعرف عنوانها.
 *
 * **ولماذا واتساب لا الورقة؟** لأنّ الدخول إلى البوابة **رقمُ الملف والجوال**،
 * وبطاقةُ المريض المطبوعة تحمل الاثنين معًا. فطبعُ العنوان عليها يجعل بطاقةً
 * تُنسى على طاولةٍ مفتاحًا كاملًا لحساب صاحبها. أمّا الإرسال إلى جواله فيثبت
 * ملكيّته للجوال نفسه الذي هو نصفُ المفتاح.
 */

/** عنوانُ البوابة من عنوان البرنامج — أو `null` إن لم يُعرف. */
export function portalUrl(origin: string | null | undefined): string | null {
  if (typeof origin !== "string") return null;
  const trimmed = origin.trim().replace(/\/+$/, "");
  // **ولا يُبنى رابطٌ من عنوانٍ ناقص**: «https://undefined/portal» يُرسل إلى
  // المريض فيفتح صفحة خطأ، ويظنّ أنّ برنامج المركز معطوب.
  if (!/^https?:\/\/[^/\s]+$/i.test(trimmed)) return null;
  // ومضيفٌ اسمه «undefined» أو «null» ليس مضيفًا: هو متغيّرٌ لم يُضبط وصل
  // إلى القالب نصًّا — ومن راءه مريضًا يفتح صفحةً لا تُفتح.
  const host = trimmed.replace(/^https?:\/\//i, "");
  if (/^(undefined|null)$/i.test(host)) return null;
  return `${trimmed}/portal`;
}

/**
 * عنوانُ البوابة من ترويسات الطلب — لمكوّنات الخادم.
 *
 * و`x-forwarded-proto` تُقرأ قبل الافتراض: خلف Vercel يصل الطلب إلى العملية
 * بـ`http` وإن كان المتصفّح على `https`، فرابطٌ بـ`http` يُرسل إلى المريض
 * فيُنبّهه متصفّحه أنّ الصفحة غير آمنة.
 */
export function portalUrlFromHeaders(
  get: (name: string) => string | null,
): string | null {
  /* (P0.15) المضيف الأمامي لا يُوثق إلا من قائمة المشغّل (TRUSTED_HOSTS)؛
   * وما عدا ذلك يُبنى الرابط من ترويسة host نفسها — وإن لم تكن موثوقة
   * أصلًا فلا رابط: دعوةٌ بلا رابط خيرٌ من دعوةٍ إلى نطاق مهاجم. */
  const forwarded = get("x-forwarded-host");
  const host = isHostTrusted(forwarded) ? forwarded!.split(",")[0].trim() : get("host");
  if (!host) return null;
  const proto = get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  // وترويسةُ المضيف يكتبها العميل، فلا يُقبل منها ما ليس مضيفًا.
  return portalUrl(`${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`);
}

export interface PortalInvite {
  url: string;
  text: string;
}

/**
 * نصُّ الدعوة — **بلا كلمة سرّ، لأنّه لا كلمة سرّ**.
 *
 * ويُذكر فيه رقمُ الملف ولا يُذكر الجوال: الرسالة تصل إلى الجوال نفسه، فذكرُه
 * حشوٌ. ولو أُرسلت خطأً إلى رقمٍ آخر لكان ذكرُه فيها تسليمَ نصفِ المفتاح الثاني.
 */
export function portalInvite(input: {
  origin: string | null | undefined;
  clinicName: string;
  patientNumber: string;
}): PortalInvite | null {
  const url = portalUrl(input.origin);
  if (!url) return null;
  const number = input.patientNumber.trim();
  if (!number) return null;
  return {
    url,
    text:
      `${input.clinicName}\n\n`
      + `يمكنك متابعة مواعيدك وحسابك وتأكيد حضورك من بوابة المرضى:\n${url}\n\n`
      + `رقم ملفك: ${number}\n`
      + "تدخل برقم ملفك وجوّالك المسجَّل لدينا.",
  };
}
