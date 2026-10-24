/**
 * تشخيص فشل تسجيل الدخول للمشغّل — سطرٌ ثابت الشكل لا يحمل إلا قيمًا من قائمة مغلقة.
 *
 * كان الـcatch الخارجي في /api/auth/login يحوّل كل استثناء إلى 500 عامّ بلا أي أثر،
 * فتعطّل الدخول في Staging (حارس هجرة التقويم ORTHO_UNREGISTERED_OBJECT_COLLISION
 * قبل التحقق من كلمة المرور) بلا سببٍ ظاهر للمشغّل.
 *
 * السطر يحمل: حدثًا ثابتًا، ومرحلةً من تعداد، وفئةً من قائمة سماح، ورقم هجرة من أربع
 * خانات عند فئات الهجرة وحدها. لا يحمل أبدًا: نص الاستثناء أو تفاصيله أو مكدّسه أو
 * سببه، ولا اسم المستخدم ولا كلمة المرور ولا الترويسات ولا SQL ولا الروابط ولا بيانات
 * مرضى. استجابة العميل لا تتغيّر.
 */

export const LOGIN_FAILURE_EVENT = "staff_login_failed";

export type LoginFailureStage = "rate_limit" | "user_lookup" | "password_verify" | "session_issue";

/** فئات حراس الهجرة: النص يبدأ بالرمز ثم ": " ثم رقم الهجرة. */
const MIGRATION_GUARD_CATEGORIES = [
  "ORTHO_UNREGISTERED_OBJECT_COLLISION",
  "ORTHO_MIGRATION_REGISTRY_MISMATCH",
  "ORTHO_MIGRATION_SOURCE_MISMATCH",
  "RUNTIME_MIGRATION_REGISTRY_MISMATCH",
  "RUNTIME_MIGRATION_SOURCE_MISMATCH",
] as const;

export type LoginFailureCategory =
  | (typeof MIGRATION_GUARD_CATEGORIES)[number]
  | "session_secret_missing"
  | "database_connection"
  | "database_resources"
  | "query_canceled"
  | "schema_object_missing"
  | "unclassified";

export type LoginFailureDiagnostic = {
  event: typeof LOGIN_FAILURE_EVENT;
  stage: LoginFailureStage;
  category: LoginFailureCategory;
  version?: string;
};

const CONNECTION_ERRNO = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "EPIPE"]);

function categoryOf(error: unknown): { category: LoginFailureCategory; version?: string } {
  const message = error instanceof Error && typeof error.message === "string" ? error.message : "";
  for (const category of MIGRATION_GUARD_CATEGORIES) {
    if (message.startsWith(`${category}: `)) {
      const version = /^\d{4}(?=$|:)/.exec(message.slice(category.length + 2))?.[0];
      return version ? { category, version } : { category };
    }
  }
  if (message.includes("SESSION_SECRET")) return { category: "session_secret_missing" };
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (CONNECTION_ERRNO.has(code) || /^08[0-9A-Z]{3}$/.test(code) || code === "57P01" || code === "57P03") return { category: "database_connection" };
    if (/^53[0-9A-Z]{3}$/.test(code)) return { category: "database_resources" };
    if (code === "57014") return { category: "query_canceled" };
    if (code === "42P01" || code === "42703" || code === "42883") return { category: "schema_object_missing" };
  }
  return { category: "unclassified" };
}

export function loginFailureDiagnostic(stage: LoginFailureStage, error: unknown): LoginFailureDiagnostic {
  return { event: LOGIN_FAILURE_EVENT, stage, ...categoryOf(error) };
}

/** يكتب السطر وحده. أي خطأ في الكتابة نفسها لا يغيّر استجابة الدخول. */
export function logLoginFailure(stage: LoginFailureStage, error: unknown): void {
  try {
    console.error(JSON.stringify(loginFailureDiagnostic(stage, error)));
  } catch {
    /* التشخيص لا يكسر الاستجابة. */
  }
}
