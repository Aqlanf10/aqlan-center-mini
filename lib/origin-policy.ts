/**
 * سياسة الأصل الدقيق (Exact Origin Policy) — P2-FIX-4.
 *
 * المشكلة: كان حارس الـmutations يقارن **اسم المضيف فقط** بعد قصّ البروتوكول
 * والمنفذ، ويقرأ `x-forwarded-host` بلا قرار توثيقٍ للوسيط. النتيجة:
 * `https://clinic.example.com` كانت تكافئ `http://clinic.example.com` و
 * `https://clinic.example.com:444` — وأصل المهاجم على نطاقٍ فرعيّ مشترك
 * قد يمرّ بمضيفٍ متطابق.
 *
 * القاعدة بعد الإصلاح — المقارنة على **أصلٍ كامل مطبَّع**: `scheme://host[:port]`
 * (المنفذ الافتراضي يُسقط، الحروف الصغيرة، لا مسار ولا query ولا fragment
 * ولا wildcards):
 *
 *  1. `TRUSTED_ORIGINS` و/أو `APP_ORIGIN` مضبوطة ⇒ الأصل يجب أن يطابق
 *     واحداً منها **حرفياً بعد التطبيع** — لا مضيفٍ متطابق ببروتوكولٍ آخر
 *     ولا بمنفذٍ آخر ولا بنطاقٍ آخر.
 *  2. لا قائمة في الإنتاج:
 *     - `TRUST_PROXY=true` ⇒ الأصل الكانوني يُشتق من ترويسات الوسيط الموثوق
 *       (x-forwarded-proto + x-forwarded-host) وتطبق عليه المقارنة الدقيقة.
 *     - بلا وسيط موثوق ⇒ **فشل مغلق** لطلبات الكوكي: لا يمكن إثبات أصل
 *       كانوني من ترويسات يكتبها العميل، فالرفض هو القرار الآمن.
 *  3. التطوير/الاختبار (بلا إنتاج): مطابقة دقيقة لأصل الخادم نفسه
 *       (request.nextUrl.origin — لا ترويسات مُعاد توجيهها) أو القائمة.
 *
 * `x-forwarded-host` لا يُقرأ إطلاقاً إلا عندما `TRUST_PROXY=true` —
 * الترويسات المُعاد توجيهها يكتبها العميل ما لم يُثبت أن الوسيط أمامنا.
 *
 * الوحدة Edge-safe بلا اعتماديات Node — تُستهلك من proxy.ts ومن الاختبارات
 * مباشرة (قرار بيئي لكل حالة، بلا إعادة تشغيل خادم).
 */

/** الأصل المطبَّع: scheme://host[:port] بمنفذٍ افتراضي مسقوط — أو null إن فسد. */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    // url.origin يُسقط المنفذ الافتراضي لكل من https وhttp أصلاً —
    // فالمطبَّع الناتج: protocol://host[:port] بحروف صغيرة، بلا مسار/استعلام.
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * قائمة الأصول الموثوقة من البيئة: `APP_ORIGIN` (الأصل الكانوني الواحد)
 * و`TRUSTED_ORIGINS` (أصول إضافية، مفصولة بفواصل) — كل إدخال يجب أن يكون
 * أصل URL كامل صالح (scheme://host[:port])؛ ما ليس أصلاً كاملاً (مضيف وحيد،
 * wildcard، مسار) يُرفض عند التحليل لا يُقبَل بصمت.
 */
export function trustedOriginsFromEnv(
  env: Record<string, string | undefined>,
): string[] {
  const raws: string[] = [];
  if (env.APP_ORIGIN && env.APP_ORIGIN.trim()) raws.push(env.APP_ORIGIN.trim());
  if (env.TRUSTED_ORIGINS && env.TRUSTED_ORIGINS.trim()) {
    raws.push(...env.TRUSTED_ORIGINS.split(",").map((entry) => entry.trim()));
  }
  const origins: string[] = [];
  for (const raw of raws) {
    const normalized = normalizeOrigin(raw);
    if (normalized) origins.push(normalized);
  }
  return origins;
}

export interface ExactOriginVerdictInput {
  /** ترويسة Origin كما وصلت (أو null إن غابت — القرار بعدها عند المستدعي). */
  origin: string | null;
  /** هل الطلب معتمد بالكوكي (طاقم أو بوابة)؟ */
  cookieAuthenticated: boolean;
  /** أصل الخادم من الطلب نفسه (request.nextUrl.origin) — بلا ترويسات عميل. */
  ownOrigin: string;
  /** TRUST_PROXY=true ⇒ ترويسات الوسيط تُصدَّق. */
  trustProxy: boolean;
  /** x-forwarded-proto (أول إدخال) — يُقرأ فقط عند trustProxy. */
  forwardedProto: string | null;
  /** x-forwarded-host (أول إدخال) — يُقرأ فقط عند trustProxy. */
  forwardedHost: string | null;
  isProduction: boolean;
  /** الأصول الموثوقة المطبَّعة من البيئة (trustedOriginsFromEnv). */
  envTrustedOrigins: string[];
  /**
   * (لطلبات بلا كوكي فقط) هل مضيف Origin موثوق بمعيار المضيف القديم
   * (TRUSTED_HOSTS أو مطابقة مضيف الخادم)؟ الطلبات بلا كوكي لا تحمل جلسة
   * فيفحص الأصل كنظافةٍ لا كحدّ CSRF؛ طلبات الكوكي لا يُسأل هذا الحقل
   * أصلًا — عليها المطابقة الدقيقة حصراً.
   */
  nonCookieHostTrusted?: boolean;
}

export type OriginVerdict = "allowed" | "rejected" | "no-origin";

/**
 * القرار الدقيق على أصلٍ كامل. المستدعي يتعامل مع "no-origin" بسياقه
 * (كوكي ⇒ رفض fail-closed؛ بلا كوكي ⇒ حدود المسار نفسه).
 */
export function exactOriginVerdict(input: ExactOriginVerdictInput): OriginVerdict {
  if (input.origin === null) return "no-origin";

  const originNorm = normalizeOrigin(input.origin);
  if (!originNorm) return "rejected"; // أصل فاسد الشكل — رفض لا تخمين

  const envSet = input.envTrustedOrigins;

  /* طلبات الكوكي — الحدّ CSRF: المطابقة الدقيقة حصراً. */
  if (input.cookieAuthenticated) {
    // 1) قائمة صريحة من المشغّل: هي المرجع، مطابقة حرفية بعد التطبيع.
    if (envSet.length > 0) {
      return envSet.includes(originNorm) ? "allowed" : "rejected";
    }
    // 2) الإنتاج بلا قائمة: لا يمكن إثبات أصل كانوني إلا عبر وسيط موثوق —
    //    وإلا فشلٌ مغلق (ترويسات الوسيط تُقرأ هنا وحدها).
    if (input.isProduction) {
      if (input.trustProxy) {
        const proto = input.forwardedProto === "http" ? "http" : "https";
        const canonical = normalizeOrigin(
          input.forwardedHost ? `${proto}://${input.forwardedHost}` : input.ownOrigin,
        );
        return canonical !== null && canonical === originNorm ? "allowed" : "rejected";
      }
      return "rejected"; // فشل مغلق: أصلٌ كانوني غير مثبت
    }
    // 3) التطوير/الاختبار: مطابقة دقيقة لأصل الخادم من الطلب نفسه.
    const own = normalizeOrigin(input.ownOrigin);
    return own !== null && own === originNorm ? "allowed" : "rejected";
  }

  /* طلبات بلا كوكي — نظافة أصل لا حدّ CSRF: أصلٌ من قائمة المشغّل بحرفه
     يُقبل، وإلا معيار المضيف الموثوق القديم (سلوك ما قبل الإصلاح محفوظ
     لعدم كسر العملاء المشروعين بلا جلسة). */
  if (envSet.includes(originNorm)) return "allowed";
  return input.nonCookieHostTrusted ? "allowed" : "rejected";
}

/**
 * مضيف صالح الشكل — قبل أي مقارنة: لا CRLF ولا مسارات ولا رموز حقن
 * (منطق lib/net.ts نفسه، Edge-safe).
 */
export function isPlausibleHost(host: string): boolean {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) && !host.includes("..");
}
