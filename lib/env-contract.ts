/**
 * عقد البيئة وتكافؤ CI — المصدرُ الواحد (TD-02).
 *
 * قبل هذا الملف كانت الحقيقة موزّعة: الإصدار «22» مكتوبٌ في ci.yml ومكتوبٌ في
 * Dockerfile، وإصدار npm في رأس غريبٍ داخل CI، وإصدار PostgreSQL في اسم ملفٍ
 * ونصّ تعليق. والتكرار ليس خطرًا على النصّ بل على **الاتفاق**: حين تتغيّر نسخةٌ
 * في مكانٍ وتنسى في آخر، يصير «البناء يعمل عندي» مختلفًا عن «البناء يعمل في CI»
 * — وهذا بالضبط الدين الذي يُغلقِه TD-REG-019/008/013.
 *
 * القاعدة: كل ثابتٍ بيئيٍّ يُفحَص أو يُطبَّق يسكن هنا، وكل ملفٍّ آخر (CI، Docker،
 * package.json، فحوص) يقرؤه من هنا أو يُفحَص ضده. أي اختلاف = انجرافٌ يُكشَف
 * بالفحص لا بالحظّ.
 */

import { CLINIC_ZONE_FALLBACK } from "./clinicZone";

/** إصدار Node الأعظمي المدعوم — عقد CI وDocker معًا (TD-REG-019). */
export const SUPPORTED_NODE_MAJOR = 22;

/** نطاق engines في package.json — نصٌّ حرفي يُفحَص تطابقه مع الثابت أعلاه. */
export const SUPPORTED_NODE_RANGE = ">=22 <23";

/**
 * نطاق npm المدعوم للتثبيت والبناء (المرحلة C):
 *  * 10.9+ — ما يأتي مدمجًا مع node:22 (صورة Docker تبني به: `npm ci` من القفل).
 *  * 11.x  — ما يرفع إليه CI صراحةً: بوابة التدقيق تحتاج نهاية الـbulk advisory
 *    التي لا يعرفها npm المدمج (نهاية quick-audit المتقاعدة تُجيب 400).
 * أي major خارج هذا النطاق = انجرافٌ يرفضه فحص البيئة.
 */
export const SUPPORTED_NPM_RANGE = ">=10.9 <12";

/** major لـnpm الذي تفرضه بوابة CI للتدقيق (npm audit عبر نهاية الـbulk). */
export const CI_REQUIRED_NPM_MAJOR = 11;

/**
 * major المدعوم لقاعدة PostgreSQL الحقيقية في الاختبار والتطوير (TD-REG-008):
 * CI يشغّل postgres:18-alpine، وعقد المخطط baseline مُولَّد على 18 حصرًا
 * (`db:baseline:manifest:verify` يرفض غيره)، واختبارات الاستعادة والتزامن
 * تُثبت سلوك 18. هذا عقدُ **الاختبار/التطوير** — لا ادّعاءً فيه على إصدار
 * قاعدة الإنتاج (ذاك خارج المستودع لا يُثبت من هنا).
 */
export const SUPPORTED_POSTGRES_MAJOR = 18;

/**
 * أسماء رابط الاتصال التي يقرأها تطبيق التشغيل فعلًا — القائمة المرجعية الواحدة.
 *
 * تكامل Neon مع Vercel يضبط `DATABASE_URL`، وتكاملات أخرى تضبط `POSTGRES_URL` أو
 * `POSTGRES_PRISMA_URL`. lib/db.ts يقرأ من هذه القائمة حصرًا (لا نسخة محلية
 * عنده)، وكل فحصٍ أو بوابة تحتاج «كل مسارات الاتصال الحية» تقرأها من هنا —
 * فأي اسمٍ يُضاف هنا يظهر تلقائيًا في فحص البيئة وبوابة الأمان، ولا تنشأ نسخة
 * منجرفة ثانية. (تصحيح مراجعة المالك لـTD-02: الفحص كان يرى اسمين فقط بينما
 * التطبيق يقرأ أربعة — ثغرة عزل فعلية.)
 */
export const RUNTIME_DATABASE_URL_ENV_NAMES = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
] as const;

export type RuntimeDatabaseUrlEnvName = (typeof RUNTIME_DATABASE_URL_ENV_NAMES)[number];

/**
 * كل أسماء روابط القواعد التي تفحصها بوابة عقد البيئة قبل أي بوابة:
 * مسارات التطبيق الحية كلها، ورابط اختبار التكامل، ومصدر الرحلات الثانوي
 * (`SOURCE_DATABASE_URL` — تقرأه رحلات verify:backup/plans/portal وغيرها بسقوطٍ
 * إلى DATABASE_URL، فهو مسار اتصالٍ حقيقي قد يُختار داخل البوابة الكاملة).
 * مشتقٌّ من القائمة الحية لا نسخةً عنها — إضافة اسمٍ للمسارات الحية تدخل
 * الفحص تلقائيًا.
 */
export const GATE_DATABASE_URL_ENV_NAMES: readonly string[] = [
  ...RUNTIME_DATABASE_URL_ENV_NAMES,
  "TEST_DATABASE_URL",
  "SOURCE_DATABASE_URL",
];

/** توقيت العيادة التعاقدي — تعز/اليمن. المصدر الوظيفي: lib/clinicZone.ts. */
export const CLINIC_TIME_ZONE_CONTRACT = CLINIC_ZONE_FALLBACK;

/**
 * البوابات الإلزامية في CI — يفحص الاختبارُ وجودَ كلٍّ منها في ci.yml حرفيًا.
 *
 * (تصحيح مراجعة المالك) عقد المخطط وبيان خط الأساس بواباتُ أمان لا خطواتُ
 * رفع أثر: توليد العقد على PostgreSQL 18، وتوليد بيان baseline مرشّح، والتحقق
 * من البيان الملتزم ضد توليدٍ طازج — كلها فاشلةٌ بذاتها في CI فلا يجوز أن
 * تغيب عن البوابة الكاملة المحلية ولا عن هذا الفحص.
 *
 * (التصحيح النهائي) تحقق انحراف العقد `schema:contract:verify` بوابةٌ
 * مستقلة عن التوليد: التوليد وحده كان يُستعاد فورًا بلا مقارنة — فالعقد
 * المتقادم كان يمرّ أخضر. الآن يُقارَن الملتزم بالطازج بنيويًّا (خطأ
 * SCHEMA_CONTRACT_DRIFT) قبل الاستعادة، محليًّا وفي CI.
 */
export const REQUIRED_CI_GATES: readonly string[] = [
  "npm run typecheck",
  "npm run lint",
  "npm test",
  "npm run test:postgres",
  "npm run schema:contract",
  "npm run schema:contract:verify",
  "npm run verify:ci",
  "npm run db:baseline:manifest",
  "npm run db:baseline:manifest:verify",
  "npm run ci:audit",
  "npm run ci:scan:body",
  "npm run build",
  "npm run test:security-http",
];

export interface ContractViolation {
  /** اسم القاعدة — ثابت يُختبر عليه. */
  rule: string;
  /** رسالة عربية موجّهة للمشغّل: ماذا انكسر وكيف يُصلَح. */
  message: string;
}

/** major من نصّ إصدار Node مثل "v22.20.0" — أو null إن لم يُفسَّر. */
export function nodeMajorFromVersionString(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  if (!match) return null;
  return Number(match[1]);
}

/** فحص إصدار Node ضد العقد — يُرجع انتهاكًا أو null. */
export function checkNodeContract(version: string): ContractViolation | null {
  const major = nodeMajorFromVersionString(version);
  if (major === null) {
    return {
      rule: "node.version.unparseable",
      message: `لم يُفسَّر إصدار Node («${version}») — لا يمكن التحقق من العقد.`,
    };
  }
  if (major !== SUPPORTED_NODE_MAJOR) {
    return {
      rule: "node.major.unsupported",
      message: `إصدار Node الحالي ${major} خارج العقد: المدعوم ${SUPPORTED_NODE_MAJOR} حصرًا `
        + `(${SUPPORTED_NODE_RANGE}). CI وDocker يعملان على ${SUPPORTED_NODE_MAJOR} — `
        + `بدّل إليه (‎.nvmrc مضبوط بالفعل: nvm use) قبل تشغيل البوابة الكاملة.`,
    };
  }
  return null;
}

/** فحص إصدار npm ضد نطاق العقد — يُرجع انتهاكًا أو null. */
export function checkNpmContract(version: string): ContractViolation | null {
  const match = /^(\d+)\.(\d+)\./.exec(version.trim());
  if (!match) {
    return {
      rule: "npm.version.unparseable",
      message: `لم يُفسَّر إصدار npm («${version}») — لا يمكن التحقق من العقد.`,
    };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const npmMajorSupported = major === 10 || major === 11;
  const npmMinorSupported = major !== 10 || minor >= 9;
  if (!npmMajorSupported || !npmMinorSupported) {
    return {
      rule: "npm.range.unsupported",
      message: `إصدار npm الحالي ${version} خارج العقد (${SUPPORTED_NPM_RANGE}). `
        + `البناء من القفل يعمل على 10.9+، وبوابة التدقيق تحتاج ${CI_REQUIRED_NPM_MAJOR} `
        + `(نهاية الـbulk advisory) — راجع docs/ENVIRONMENT_CI_PARITY.md.`,
    };
  }
  return null;
}

/** المضيف محلي (loopback)؟ — localhost و127.0.0.1 و::1 فقط. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** أسماء مضيفين تبدو منصة Railway — لا تقع قواعدُ البوابات عليها أبدًا. */
export function looksLikeRailwayDatabaseHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized.endsWith(".rlwy.net")
    || normalized.endsWith(".railway.app")
    || normalized.endsWith(".railway.internal")
    || normalized === "railway.internal";
}

/**
 * فحص رابط قاعدة بيانات قبل تشغيل أي بوابة تُنشئ/تُسقط قواعد (المرحلة H):
 *
 *  * قاعدة الإنتاج (DATABASE_ENVIRONMENT=production) ⇒ رفضٌ مطلق — البوابات
 *    تختبر، ولا تلمس الإنتاج أبدًا.
 *  * مضيف يشبه Railway ⇒ رفضٌ مطلق — بلا استثناء تصنيفي؛ قرصُ الإنتاج ليس
 *    مكان رحلة.
 *  * مضيف غير محلي بلا تصنيف صريح (test/development/staging) ⇒ رفض — نفس
 *    فلسفة lib/db-target.ts: البعيد غير المصنَّف مجهول، والمجهول لا يُكتب عليه.
 *  * في CI: غير المحلي مرفوضٌ ولو صُنِّف — بوابة CI معزولة بقاعدة الخدمة
 *    المحلية حصرًا.
 *
 * لا يُفتح اتصال هنا — فحصٌ ساكن للرابط فقط؛ التحقق من إصدار الخادم مسؤولية
 * من يفتح الاتصال فعلاً (إعداد اختبارات PostgreSQL).
 */
export function checkDatabaseUrlForGates(
  rawUrl: string,
  varName: string,
  options: { ci: boolean },
): ContractViolation | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      rule: "db.url.unparseable",
      message: `${varName} ليس رابط PostgreSQL صالحًا — لا يمكن التحقق من أمان الهدف.`,
    };
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return {
      rule: "db.url.protocol",
      message: `${varName} ليس رابط postgresql:// — البوابات لا تعمل على غيره.`,
    };
  }
  if (looksLikeRailwayDatabaseHost(parsed.hostname)) {
    return {
      rule: "db.host.railway",
      message: `${varName} يشير إلى مضيف Railway — بوابات الاختبار لا تلمس منصة الإنتاج أبدًا.`,
    };
  }
  if (process.env.DATABASE_ENVIRONMENT === "production") {
    return {
      rule: "db.environment.production",
      message: `${varName} مصنَّف إنتاجًا (DATABASE_ENVIRONMENT=production) — تشغيل البوابات عليه مرفوض.`,
    };
  }
  if (isLoopbackHost(parsed.hostname)) return null;
  const classified = (process.env.DATABASE_ENVIRONMENT ?? "").trim();
  if (options.ci) {
    return {
      rule: "db.host.ci-not-loopback",
      message: `${varName} في CI يجب أن يكون مضيفًا محليًا (127.0.0.1) — بيئة CI معزولة بقاعدة الخدمة.`,
    };
  }
  if (!["test", "development", "staging"].includes(classified)) {
    return {
      rule: "db.host.remote-unclassified",
      message: `${varName} مضيفٌ بعيد بلا تصنيف صريح — صنِّف الهدف أولًا `
        + `(DATABASE_ENVIRONMENT=test|development|staging) كما في lib/db-target.ts، `
        + `أو وجِّه البوابة إلى قاعدة محلية.`,
    };
  }
  return null;
}

/** فحص major لـPostgreSQL — يُرجع انتهاكًا أو null (يُستخدم بعد فتح الاتصال). */
export function checkPostgresMajor(major: number): ContractViolation | null {
  if (major !== SUPPORTED_POSTGRES_MAJOR) {
    return {
      rule: "postgres.major.unsupported",
      message: `قاعدة PostgreSQL الحالية إصدار ${major} — عقد الاختبار/التطوير هو `
        + `${SUPPORTED_POSTGRES_MAJOR} حصرًا (CI يشغّل postgres:${SUPPORTED_POSTGRES_MAJOR}-alpine، `
        + `وعقد baseline/المخطط مُولَّد على ${SUPPORTED_POSTGRES_MAJOR}). محليًّا: docker compose up -d pg18 `
        + `ثم TEST_DATABASE_URL=postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable. `
        + `انظر docs/ENVIRONMENT_CI_PARITY.md.`,
    };
  }
  return null;
}

/** فحص major يرمي استثناءً صريحًا — للإعدادات التي تفشل منها البوابة كلها. */
export function assertPostgresMajorOrThrow(major: number): void {
  const violation = checkPostgresMajor(major);
  if (violation) throw new Error(`[${violation.rule}] ${violation.message}`);
}

/** major من server_version_num — 180004 ⇒ 18. */
export function postgresMajorFromVersionNum(versionNum: number | string): number {
  return Math.floor(Number(versionNum) / 10_000);
}
