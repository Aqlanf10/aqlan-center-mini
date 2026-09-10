import fs from "node:fs";

/**
 * قرار TLS لاتصال PostgreSQL (P1.19 + P1-FIX-9 + Final Production Gate).
 *
 * الحالات:
 *  ١) sslmode=disable محليًا/CI فقط.
 *  ٢) sslmode=disable على مضيف بعيد في الإنتاج = رفض فوري.
 *  ٣) شهادة جذر موثوقة عبر PGSSL_ROOT_CERT_PEM (PEM مباشر، مناسب للمنصات)
 *     أو PGSSL_ROOT_CERT (مسار ملف) = تشفير + تحقق كامل.
 *  ٤) بعيد بلا CA = تشفير بلا تحقق مع تحذير صريح.
 */

export interface TlsDecision {
  mode: "disabled" | "verified" | "encrypted-unverified";
  ssl: false | { rejectUnauthorized: boolean; ca?: string[] };
  warning: string | null;
}

type TlsOptions = {
  rootCertPath?: string;
  rootCertPem?: string;
  productionRuntime?: boolean;
};

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

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

function normalizeRootCertPem(raw: string, source: string): string {
  const pem = raw.trim();
  if (!pem.startsWith("-----BEGIN CERTIFICATE-----") || !pem.endsWith("-----END CERTIFICATE-----")) {
    throw new Error(`${source} مضبوط لكن محتواه ليس شهادة PEM صالحة — التحقق الكامل لن يُخفَّض بصمت.`);
  }
  return `${pem}\n`;
}

function trustedRootCa(options: TlsOptions): string | null {
  const inline = options.rootCertPem ?? process.env.PGSSL_ROOT_CERT_PEM;
  if (inline?.trim()) return normalizeRootCertPem(inline, "PGSSL_ROOT_CERT_PEM");

  const rootCertPath = options.rootCertPath ?? process.env.PGSSL_ROOT_CERT;
  if (!rootCertPath?.trim()) return null;

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
  return normalizeRootCertPem(ca, "PGSSL_ROOT_CERT");
}

export function decideTls(connectionString: string, options: TlsOptions = {}): TlsDecision {
  const lowered = connectionString.toLowerCase();
  const sslmode = sslModeFromUrl(connectionString);
  const host = parseDatabaseHost(connectionString)?.host ?? "";

  if (sslmode === "disable") {
    if (isLocalHost(host) || !lowered.includes("://")) {
      return { mode: "disabled", ssl: false, warning: null };
    }
    if (isProductionTlsContext(options)) {
      throw new Error(
        "سياسة TLS للإنتاج (P1): sslmode=disable على مضيف بعيد في سياق إنتاج مرفوض — "
        + "قاعدة الإنتاج لا تُدار عبر قناة مفتوحة. احذف sslmode=disable من الرابط أو "
        + "اضبط CA موثوقًا عبر PGSSL_ROOT_CERT_PEM أو PGSSL_ROOT_CERT.",
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

  const ca = trustedRootCa(options);
  if (ca) {
    return { mode: "verified", ssl: { rejectUnauthorized: true, ca: [ca] }, warning: null };
  }

  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    throw new Error(
      `sslmode=${sslmode} في رابط الاتصال يطلب التحقق من الشهادة، لكن لا PGSSL_ROOT_CERT_PEM ولا PGSSL_ROOT_CERT مضبوط. `
      + "لا يُتعطَّل التحقق حين يُطلب صراحةً — اضبط شهادة الجذر ثم أعد المحاولة.",
    );
  }

  return {
    mode: "encrypted-unverified",
    ssl: { rejectUnauthorized: false },
    warning:
      "تنبيه أمني (مخاطرة متبقية معلنة): اتصال PostgreSQL بعيد مشفَّر لكن بلا التحقق "
      + "من سلسلة الشهادة (rejectUnauthorized=false — قابل لانتحال الخادم داخل الشبكة). "
      + "لتفعيل التحقق الكامل اضبط PGSSL_ROOT_CERT_PEM أو PGSSL_ROOT_CERT بشهادة جذر تثق بها.",
  };
}

export function sslForConnection(connectionString: string): false | { rejectUnauthorized: boolean; ca?: string[] } {
  const decision = decideTls(connectionString);
  if (decision.warning) console.warn(`[db-tls] ${decision.warning}`);
  return decision.ssl;
}
