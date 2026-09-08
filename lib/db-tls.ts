import fs from "node:fs";

/**
 * قرار TLS لاتصال PostgreSQL (P1.19 + P1-FIX-9) — مركزيّ ومُختبر.
 *
 * الحالة قبل P1: `sslFor()` تُفعّل التشفير لكن تعطّل التحقق من سلسلة الشهادة
 * (`rejectUnauthorized: false`) لكل مزوّد مُدار — اتصالٌ مشفّر قابل للوسيط
 * (MITM): من يعترض المسار يستطيع انتحال الخادم وقراءة/تعديل كل البيانات.
 *
 * نموذج P1 — أربع حالات صريحة:
 *
 *  ١) `sslmode=disable` مع مضيف محلي (localhost/127.0.0.1/::1) أو رابط بلا
 *     مضيف: بلا تشفير — صحيح لقاعدة على الجهاز نفسه وقواعد CI المعزولة.
 *
 *  ٢) `sslmode=disable` مع **مضيف بعيد في سياق إنتاج** (NODE_ENV=production
 *     أو داخل Railway أو DATABASE_ENVIRONMENT=production): **رفض فوري** —
 *     لا اتصال إلى قاعدة إنتاج بلا تشفير. قرار المراجعة المستقلة لP1:
 *     التطبيق يفشل في الإقلاع بصوت عالٍ بدل أن يعمل على قناة مفتوحة.
 *
 *  ٣) شهادة جذر موثوقة عبر `PGSSL_ROOT_CERT` (مسار ملف CA): تشفير **وتحقق
 *     كامل** — `rejectUnauthorized: true` مع CA المقروء. إن كان الملف غير
 *     قابل للقراءة: خطأ فوري صريح (لا سقوط صامت إلى بلا تحقق).
 *     ملاحظة صدق (P1-FIX-9): **لم نتحقق بعد أن مزوّد Railway يتيح تنزيل شهادة
 *     CA** من لوحته لقاعدة PostgreSQL — لذلك لا يُدّعى ذلك في التوثيق. الطريقة
 *     المثبتة للتحقق الكامل: شهادة جذر من مصدر تثق به، تُرفع للخدمة ويُضبط
 *     المسار — أو مضيف قاعدة يعمل بCA عام موثوق.
 *
 *  ٤) رابط بعيد بلا CA مضبوط: تشفير بلا تحقق — مع تحذير مسجَّل بصوت عالٍ.
 *     هذه هي الحالة الواقعية الحالية على Railway (شبكة خاصة مشفّرة بلا تحقق
 *     هوية) — تُوثَّق كـ**مخاطرة متبقية معلنة**، لا تُسمّى verified.
 *
 * كذلك يُحترم `sslmode=verify-full`/`verify-ca` صراحةً: معهما بلا CA ⇒ خطأ
 * (الطلب صريح ولا يُخدَع)، و`sslmode=require` وحدها تُبقى على النموذج ٤.
 */

export interface TlsDecision {
  mode: "disabled" | "verified" | "encrypted-unverified";
  ssl: false | { rejectUnauthorized: boolean; ca?: string[] };
  warning: string | null;
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * سياق تشغيل «إنتاجي» لقرار TLS — يُستخدم لرفض sslmode=disable على البعيد
 * (P1-FIX-9). يُمرَّر صراحةً من الأدوات/الاختبارات؛ الافتراضي يقرأ بيئة العملية.
 */
function isProductionTlsContext(options: { productionRuntime?: boolean } = {}): boolean {
  if (options.productionRuntime === true) return true;
  if (options.productionRuntime === false) return false;
  return (
    process.env.NODE_ENV === "production"
    || process.env.DATABASE_ENVIRONMENT === "production"
    || Boolean(process.env.RAILWAY_PROJECT_ID)
    || Boolean(process.env.RAILWAY_SERVICE_ID)
  );
}

/** يفكّ مضيف/منفذ قاعدة من رابط postgresql:// — لعرض هوية الهدف بلا كلمة سر. */
export function parseDatabaseHost(connectionString: string): { host: string; port: string; database: string; user: string } | null {
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port || "5432",
      database: url.pathname.replace(/^\//, "") || "(افتراضي)",
      user: url.username || "(افتراضي)",
    };
  } catch {
    return null;
  }
}

export function sslModeFromUrl(connectionString: string): string | null {
  const match = /[?&]sslmode=([a-z-]+)/i.exec(connectionString);
  return match ? match[1].toLowerCase() : null;
}

export function decideTls(
  connectionString: string,
  options: { rootCertPath?: string; productionRuntime?: boolean } = {},
): TlsDecision {
  const lowered = connectionString.toLowerCase();
  const sslmode = sslModeFromUrl(connectionString);
  const host = parseDatabaseHost(connectionString)?.host ?? "";

  // ١) تعطيل صريح: محلي/CI ⇒ مسموح؛ بعيد في سياق إنتاج ⇒ رفض بنيوي (P1-FIX-9).
  if (sslmode === "disable") {
    if (isLocalHost(host) || !lowered.includes("://")) {
      return { mode: "disabled", ssl: false, warning: null };
    }
    if (isProductionTlsContext(options)) {
      throw new Error(
        "سياسة TLS للإنتاج (P1): sslmode=disable على مضيف بعيد في سياق إنتاج مرفوض — "
        + "قاعدة الإنتاج لا تُدار عبر قناة مفتوحة. احذف sslmode=disable من الرابط أو "
        + "اضبط CA موثوقًا عبر PGSSL_ROOT_CERT.",
      );
    }
    return {
      mode: "disabled",
      ssl: false,
      warning:
        "تنبيه: sslmode=disable على مضيف بعيد خارج سياق الإنتاج — قناة غير مشفّرة "
        + "(تطوير/اختبار فقط). صنّف الهدف بDATABASE_ENVIRONMENT قبل أي استخدام جدي.",
    };
  }
  if (isLocalHost(host)) {
    return { mode: "disabled", ssl: false, warning: null };
  }

  // ٣) تحقق كامل: CA من PGSSL_ROOT_CERT (أو مسار صريح).
  const rootCertPath = options.rootCertPath ?? process.env.PGSSL_ROOT_CERT;
  if (rootCertPath && rootCertPath.trim()) {
    let ca: string;
    try {
      ca = fs.readFileSync(rootCertPath.trim(), "utf8");
    } catch (error) {
      throw new Error(
        `PGSSL_ROOT_CERT مضبوط إلى «${rootCertPath}» لكن تعذّرت قراءته `
        + `(${error instanceof Error ? error.message : "خطأ غير معروف"}). `
        + "الاتصال بقاعدة بعيدة بلا تحقق شهادة مرفوض — أصلح مسار CA أو أزل المتغير ليعمل وضع التشفير-بلا-تحقق مع التحذير.",
      );
    }
    return { mode: "verified", ssl: { rejectUnauthorized: true, ca: [ca] }, warning: null };
  }

  // صراحة verify-full/verify-ca بلا CA = طلب لا يمكن تلبيته بأمان — رفض فوري.
  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    throw new Error(
      `sslmode=${sslmode} في رابط الاتصال يطلب التحقق من الشهادة، لكن PGSSL_ROOT_CERT غير مضبوط. `
      + "لا يُتعطَّل التحقق حين يُطلب صراحةً — اضبط متغير CA ثم أعد المحاولة.",
    );
  }

  // ٤) بعيد بلا CA: تشفير بلا تحقق — مخاطرة متبقية معلنة مع تحذير بصوت عالٍ.
  return {
    mode: "encrypted-unverified",
    ssl: { rejectUnauthorized: false },
    warning:
      "تنبيه أمني (مخاطرة متبقية معلنة): اتصال PostgreSQL بعيد مشفَّر لكن بلا التحقق "
      + "من سلسلة الشهادة (rejectUnauthorized=false — قابل لانتحال الخادم داخل الشبكة). "
      + "هذا هو الوضع الحالي المُتحقَّق على Railway. لتفعيل التحقق الكامل اضبط PGSSL_ROOT_CERT "
      + "بشهادة جذر تثق بها.",
  };
}

/**
 * قرار TLS متوافق مع شكل `ssl` الذي تتوقعه pg.Pool — نفس عقد sslFor القديم
 * مع دعم CA والتحقق. التحذير يُسجَّل مرة عند إنشاء الـpool لا مع كل استعلام.
 */
export function sslForConnection(connectionString: string): false | { rejectUnauthorized: boolean; ca?: string[] } {
  const decision = decideTls(connectionString);
  if (decision.warning) console.warn(`[db-tls] ${decision.warning}`);
  return decision.ssl;
}
