/**
 * أسماء الكوكيز ومددها — معزولة عمدًا عن `lib/auth.ts` و`lib/portal.ts`.
 *
 * `proxy` يعمل على Edge حيث `node:crypto` غير متاح، فاستيراد الاسم من ملف
 * التجزئة كان يسحب معه المكتبة كلها ويُفشل البناء. الثوابت هنا بلا أي اعتمادية.
 */
export const SESSION_COOKIE = "aqlan_flow_session";
export const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // وردية يوم كامل

/** اسم كوكي بوابة المريض — نفس العزل: حارس الـmutations في proxy يقرأه هنا. */
export const PORTAL_COOKIE_NAME = "aqlan_portal_session";

/**
 * (P2-FINAL-1) قرار Secure لكوكي جلسة الطاقم `aqlan_flow_session` — مستقل
 * كليًّا عن ترويسات الوسيط المُعاد توجيهها: `x-forwarded-proto` لا يُقرأ هنا
 * إطلاقًا، فأي طلب يحملها لا يستطيع إطفاء Secure مهما كان NODE_ENV.
 *
 *  - الإنتاج (`NODE_ENV=production`) ⇒ `true` دائمًا: الكوكي لا تُرسل عبر
 *    HTTP إطلاقًا، ولا ترويسة يكتبها العميل (Host ولا forwarded) تستطيع
 *    إطفاء السمة — قرار بيئي من إعدادات النشر لا من محتوى الطلب.
 *  - dev/test المحلي الحقيقي فقط ⇒ `false` فوق مضيف محلي (localhost أو
 *    127.0.0.1 أو ::1) ليعمل الدخول بلا TLS محليًّا — والقرار من Host
 *    الاتصال الفعلي كما رآه الخادم، لا من ترويسة مُعاد توجيهها.
 */
export function staffSessionCookieSecure(hostHeader: string | null | undefined): boolean {
  if (process.env.NODE_ENV === "production") return true;
  const firstEntry = (hostHeader ?? "").split(",")[0].trim().toLowerCase();
  const hostname = firstEntry.split(":")[0];
  return !(
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]"
  );
}
