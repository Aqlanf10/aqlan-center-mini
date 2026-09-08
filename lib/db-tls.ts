import fs from "node:fs";

/**
 * قرار TLS لاتصال PostgreSQL (P1.19) — مركزيّ ومُختبر.
 *
 * الحالة قبل P1: `sslFor()` تُفعّل التشفير لكن تعطّل التحقق من سلسلة الشهادة
 * (`rejectUnauthorized: false`) لكل مزوّد مُدار — اتصالٌ مشفَّر قابل للوسيط
 * (MITM): من يعترض المسار يستطيع انتحال الخادم وقراءة/تعديل كل البيانات.
 *
 * نموذج P1 — ثلاث حالات صريحة:
 *
 *  ١) `sslmode=disable` في الرابط أو مضيف محلي (localhost/127.0.0.1/::1):
 *     بلا تشفير — صحيح لقاعدة على الجهاز نفسه وقواعد CI المعزولة.
 *
 *  ٢) شهادة جذر موثوقة عبر `PGSSL_ROOT_CERT` (مسار ملف CA):
 *     تشفير **وتحقق كامل** — `rejectUnauthorized: true` مع CA المقروء.
 *     إن كان الملف غير قابل للقراءة: خطأ فوري صريح (لا سقوط صامت إلى بلا
 *     تحقق). على Railway: يُرفع ملف CA (المزوّد يتيح تنزيله من إعدادات قاعدة
 *     البيانات) إلى الخدمة ويُضبط المتغير — الطريقة موثَّقة في
 *     docs/PRODUCTION_HARDENING_REPORT.md.
 *
 *  ٣) رابط بعيد بلا CA مضبوط: تشفير بلا تحقق — **مع تحذير مسجَّل بصوت عالٍ**
 *     في كل إقلاع (سلوك قائم لعدم كسر الاتصال الحالي، والقرار الصريح
 *     المتعطِّل بالتحقق انتظر ضبط CA). الانتقال الكامل = ضبط PGSSL_ROOT_CERT
 *     في بيئة الإنتاج (P2/تشغيلي — لا تغيير بيئة إنتاج في P1).
 *
 * كذلك يُحترم `sslmode=verify-full`/`verify-ca` صراحةً: معهما بلا CA ⇒ خطأ
 * (الطلب صريح ولا يُخدَع)، و`sslmode=require` وحدها تُبقى على النموذج ٣.
 */

export interface TlsDecision {
  mode: "disabled" | "verified" | "encrypted-unverified";
  ssl: false | { rejectUnauthorized: boolean; ca?: string[] };
  warning: string | null;
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
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

export function decideTls(connectionString: string, options: { rootCertPath?: string } = {}): TlsDecision {
  const lowered = connectionString.toLowerCase();
  const sslmode = sslModeFromUrl(connectionString);

  // ١) تعطيل صريح أو مضيف محلي — بلا TLS.
  if (sslmode === "disable") {
    return { mode: "disabled", ssl: false, warning: null };
  }
  const host = parseDatabaseHost(connectionString)?.host ?? "";
  if (isLocalHost(host)) {
    return { mode: "disabled", ssl: false, warning: null };
  }

  // ٢) تحقق كامل: CA من PGSSL_ROOT_CERT (أو مسار صريح).
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

  // ٣) بعيد بلا CA: تشفير بلا تحقق — مع تحذير بصوت عالٍ.
  return {
    mode: "encrypted-unverified",
    ssl: { rejectUnauthorized: false },
    warning:
      "تنبيه أمني: اتصال PostgreSQL بعيد مشفَّر لكن بلا التحقق من سلسلة الشهادة "
      + "(rejectUnauthorized=false — قابل لانتحال الخادم). اضبط PGSSL_ROOT_CERT بمسار شهادة "
      + "الجذر المزوّد لتفعيل التحقق الكامل.",
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
