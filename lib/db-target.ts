import { parseDatabaseHost } from "./db-tls";

/**
 * تصنيف بيئة هدف قاعدة البيانات (P1-FIX-8) — قرار مركزي مستقل عن الجهاز الذي
 * يشغّل الأمر.
 *
 * المشكلة التي يغلقها هذا الملف: أدوات DB (db:migrate --apply وrestore:full)
 * كانت تمنع الإنتاج فقط إذا **عملية الجهاز نفسها** رأت NODE_ENV=production أو
 * RAILWAY_PROJECT_ID. تشغيلها من لابتوب مطوّر على رابط قاعدة إنتاج مع
 * --allow-remote كان يمرّ — الحماية كانت على مكان التشغيل لا على الهدف.
 *
 * النموذج المعتمد (fail-closed):
 *
 *  ١) `DATABASE_ENVIRONMENT` التصنيف الصريح للهدف — أحد:
 *     test | development | staging | production. هو المصدر الأول للحقيقة
 *     لأنه يوثّق **نية مالك القاعدة** لا تخمينًا من الشبكة. قيمة أخرى/فارغة
 *     تعني «غير مصنَّف» لا «غير إنتاج» — فرق fail-closed.
 *
 *  ٢) بلا تصنيف صريح: مضيف محلي (localhost/127.0.0.1/::1/unix) ⇒ development.
 *
 *  ٣) بلا تصنيف صريح ومضيف بعيد: إن كانت عملية التشغيل نفسها داخل Railway
 *     (RAILWAY_PROJECT_ID مضبوط) ⇒ production — تشغيل داخل بيئة Railway على
 *     قاعدة بعيدة هو الإنتاج افتراضًا حتى يوثّق غير ذلك.
 *
 *  ٤) ما عدا ذلك (بعيد بلا تصنيف) ⇒ unknown-remote — **رفض كل عملية هدم/كتابة
 *     جماعية** (تطبيق هجرات/استعادة) حتى يُصنَّف الهدف صراحةً. القراءة
 *     الآمنة (db:status) مسموحة.
 *
 * سياسة P1 الصريحة (لا تتجاوز بعلمٍ في هذه المرحلة):
 *  * production: migrate apply ⇒ مرفوض بنيويًّا. restore-full ⇒ مرفوض بنيويًّا.
 *  * unknown-remote: نفس الرفض — التصنيف إلزامي قبل أي كتابة.
 *  * test/staging/development: مسموحة وفق أعلام الـCLI المعتادة
 *    (--apply، --allow-remote للبعيد الموثّق).
 */

export type DbEnvironment =
  | "local"
  | "test"
  | "development"
  | "staging"
  | "production"
  | "unknown-remote";

export const DATABASE_ENVIRONMENT_VALUES = [
  "test",
  "development",
  "staging",
  "production",
] as const;

export type DatabaseEnvironmentValue = (typeof DATABASE_ENVIRONMENT_VALUES)[number];

export interface DbTargetDecision {
  /** تصنيف الهدف — انظر DbTargetDecision above. */
  environment: DbEnvironment;
  host: string;
  port: string;
  database: string;
  user: string;
  /** هل الهدف محلي فعليًّا (localhost/socket)؟ */
  localHost: boolean;
  /** التصنيف جاء من DATABASE_ENVIRONMENT الصريح لا من الاستنتاج. */
  explicit: boolean;
  /** تطبيق الهجرات (db:migrate --apply) مسموح لهذا الهدف في P1؟ */
  allowsMigrateApply: boolean;
  /** الاستعادة الكاملة (restore:full) مسموحة لهذا الهدف في P1؟ */
  allowsRestoreFull: boolean;
  /** فحوص القراءة الآمنة (db:status/dry-run) مسموحة؟ */
  allowsReadOnlyStatus: boolean;
  /** أسباب مقروءة لماذا رُفض/قُبل — تُعرض في CLI قبل أي تنفيذ. */
  reasons: string[];
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host === "[::1]"
    || host === ""
    || host.startsWith("/") // unix socket directory
  );
}

/** هل عملية التشغيل الحالية داخل بيئة Railway فعلًا؟ (إشارة واحدة من عدة). */
export function runningInsideRailway(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.RAILWAY_PROJECT_ID
    || (env.RAILWAY_ENVIRONMENT_NAME && env.RAILWAY_ENVIRONMENT)
    || env.RAILWAY_SERVICE_ID,
  );
}

/**
 * قيمة DATABASE_ENVIRONMENT من البيئة بعد التحقق: الصحيحة تُعاد، والمجهولة
 * تُرمى (fail-closed: قيمة غلط ليست «غير إنتاج»)، وغيابها يعني null.
 */
export function explicitDatabaseEnvironment(env: NodeJS.ProcessEnv = process.env): DatabaseEnvironmentValue | null {
  const raw = env.DATABASE_ENVIRONMENT?.trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  const value = DATABASE_ENVIRONMENT_VALUES.find((candidate) => candidate === lowered);
  if (!value) {
    throw new Error(
      `DATABASE_ENVIRONMENT="${raw}" غير صالحة — القيم المقبولة: `
      + DATABASE_ENVIRONMENT_VALUES.join(" | ")
      + ". التصنيف الخاطئ ليس «غير مصنَّف»؛ اضبط القيمة الصحيحة أو احذف المتغير.",
    );
  }
  return value;
}

export function classifyDbTarget(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): DbTargetDecision {
  const identity = parseDatabaseHost(connectionString);
  const host = identity?.host ?? "";
  const localHost = isLocalHost(host);
  const reasons: string[] = [];

  const explicit = explicitDatabaseEnvironment(env);
  let environment: DbEnvironment;

  if (explicit) {
    environment = explicit;
    reasons.push(
      `التصنيف صريح من DATABASE_ENVIRONMENT=${explicit} — نيّة مالك القاعدة هي المصدر الأول.`,
    );
  } else if (localHost) {
    environment = "local";
    reasons.push("المضيف محلي بلا تصنيف صريح ⇒ development (قاعدة الجهاز نفسه).");
  } else if (runningInsideRailway(env)) {
    environment = "production";
    reasons.push(
      "هدف بعيد بلا تصنيف صريح داخل عملية Railway ⇒ production افتراضًا حتى يوثّق غير ذلك.",
    );
  } else {
    environment = "unknown-remote";
    reasons.push(
      "هدف بعيد بلا تصنيف صريح ⇒ unknown-remote: العمليات المدمِّرة مرفوضة حتى "
      + "يُضبط DATABASE_ENVIRONMENT=test|development|staging|production.",
    );
  }

  // production والهدف محلي فعليًّا معًا؟ تصنيف غريب لكنه صريح — نحترمه كما وثّقه
  // المالك (ربما قاعدة إنتاج معروضة عبر نفق محلي). الرفض يبقى.
  const isProduction = environment === "production";
  const isUnknownRemote = environment === "unknown-remote";

  return {
    environment,
    host: identity?.host ?? "(غير معروف)",
    port: identity?.port ?? "5432",
    database: identity?.database ?? "(افتراضي)",
    user: identity?.user ?? "(افتراضي)",
    localHost,
    explicit: explicit !== null,
    allowsMigrateApply: !isProduction && !isUnknownRemote,
    allowsRestoreFull: !isProduction && !isUnknownRemote,
    allowsReadOnlyStatus: true,
    reasons,
  };
}

/** نص الهوية بلا كلمات سر — لعرض CLI. */
export function describeDbTarget(target: DbTargetDecision): string {
  return `host=${target.host} port=${target.port} database=${target.database} user=${target.user}`;
}
