import { comparePublicSchemaToManifest, type BaselineSchemaManifest, type SchemaManifestDiff } from "./schema-manifest";
import type { DbPool } from "./db";
import { sanitizeErrorMessage } from "./redact";
import committedManifestJson from "@/schema/baseline-schema-manifest.pg18.json";

/**
 * تحقق خط أساس الإنتاج — SELECT حرفيًّا، لا DDL ولا أي كتابة.
 *
 * يقارن مخطط `public` الحقيقي مع المرجع الملتزم في المستودع
 * (schema/baseline-schema-manifest.pg18.json — مُولَّد من migrations/0001 على
 * PostgreSQL 18 في CI). الدلالة: **المتوقع ⊆ الفعلي** — الكائنات الإضافية
 * (ما أنشأه ensureSchema التاريخي بعد خط الأساس) لا تفشل، وأي كائن ناقص
 * أو بصمة مخالفة ⇒ fail-closed.
 *
 * هذه هي البديل الآمن للمجس القديم runBaselineSchemaProbe الذي ينشئ temporary
 * schema — هنا لا ينفَّذ إلا SELECT على كتالوج النظام، فلا مجال لأثر DDL حتى
 * داخل معاملة مراجَعة.
 *
 * النتيجة لا تُعرض في /api/health العام إطلاقًا: تسجَّل مرة واحدة إلى سجل
 * التشغيل بعلم صريح (SCHEMA_BASELINE_VERIFY_ONCE=true) وتُستخدم لاحقًا في
 * تشخيصات المدير وحده. فشل التشغيل العابر (انقطاع اتصال مثلًا) لا يستهلك
 * الفرصة الواحدة — الحالة تعود idle للمحاولة اللاحقة، وما يجري مرة واحدة
 * فعلًا هو نتيجة baseline حقيقية (توافق أو انحراف) قد سُجّلت. الرسائل عبر
 * sanitizeErrorMessage — لا أسرار ولا روابط قاعدة ولا مسارات في السجل.
 */

const committed = committedManifestJson as unknown as BaselineSchemaManifest;

function assertCommittedManifest(manifest: BaselineSchemaManifest): void {
  if (manifest.format !== "aqlan-baseline-schema-manifest" || manifest.formatVersion !== 1) {
    throw new Error("committed baseline manifest: format غير مدعوم.");
  }
  if (manifest.migrationVersion !== "0001") {
    throw new Error("committed baseline manifest: migrationVersion غير متوقعة.");
  }
  if (manifest.postgresMajor !== 18) {
    throw new Error(`committed baseline manifest: postgresMajor=${manifest.postgresMajor} والمطلوب 18.`);
  }
}

/**
 * تجميد عميق متكرر: الجذر والأغصان والمصفوفات كلها مقروءة فعلًا — لا يستطيع
 * مستدعٍ فسخ البوابة عبر reference.tables.push أو reference.columns.x = ….
 * ملاحظة النوع: نُبقي التوقيع BaselineSchemaManifest كما هو لأن المقارن في
 * schema-manifest.ts يقبله؛ التجميد هنا حماية وقت تشغيل لا تغيير توقيع.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

assertCommittedManifest(committed);
const COMMITTED_BASELINE_MANIFEST: BaselineSchemaManifest = deepFreeze(committed);

/** المرجع الملتزم — مقروء فقط (مجمّد تجميدًا عميقًا عند تحميل الوحدة). */
export function committedBaselineManifest(): BaselineSchemaManifest {
  return COMMITTED_BASELINE_MANIFEST;
}

export interface SchemaBaselineVerification {
  compatible: boolean;
  postgresMajor: number;
  fingerprint: string;
  checked: BaselineSchemaManifest["checked"];
  missingTables: number;
  columnProblems: number;
  missingConstraints: number;
  missingIndexes: number;
  missingTriggers: number;
  /** أول كائنات ناقصة (بحد أقصى) لتشخيص المالك — أسماء كائنات الكتالوج فقط، لا بيانات مرضى. */
  samples: {
    missingTables: string[];
    missingConstraints: string[];
    missingIndexes: string[];
    missingTriggers: string[];
    columnProblems: string[];
  };
}

const SAMPLE_LIMIT = 20;

function summarize(diff: SchemaManifestDiff): SchemaBaselineVerification {
  return {
    compatible: diff.ok,
    postgresMajor: COMMITTED_BASELINE_MANIFEST.postgresMajor,
    fingerprint: COMMITTED_BASELINE_MANIFEST.fingerprint,
    checked: diff.checked,
    missingTables: diff.missingTables.length,
    columnProblems: diff.columnProblems.length,
    missingConstraints: diff.missingConstraints.length,
    missingIndexes: diff.missingIndexes.length,
    missingTriggers: diff.missingTriggers.length,
    samples: {
      missingTables: diff.missingTables.slice(0, SAMPLE_LIMIT),
      missingConstraints: diff.missingConstraints.slice(0, SAMPLE_LIMIT),
      missingIndexes: diff.missingIndexes.slice(0, SAMPLE_LIMIT),
      missingTriggers: diff.missingTriggers.slice(0, SAMPLE_LIMIT),
      columnProblems: diff.columnProblems.slice(0, SAMPLE_LIMIT).map(
        (problem) => `${problem.table}.${problem.column} (${problem.kind})`,
      ),
    },
  };
}

/**
 * يُسقط public بقارئ SELECT-only ويقارن بالمرجع الملتزم. كل الاستعلامات
 * من projectSchemaReadOnly (5 SELECT على الكتالوج) — لا شيء آخر.
 */
export async function verifySchemaBaseline(pool: DbPool): Promise<SchemaBaselineVerification> {
  const diff = await comparePublicSchemaToManifest(pool, COMMITTED_BASELINE_MANIFEST);
  return summarize(diff);
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production"
    || process.env.DATABASE_ENVIRONMENT === "production"
    || Boolean(process.env.RAILWAY_PROJECT_ID);
}

/**
 * حالة الone-shot: idle → running → completed.
 *  * completed تعني نتيجة baseline فعلية سُجِّلت (compatible=true أو false) —
 *    لا إعادة تشغيل أبدًا بعدها، فالانحراف نتيجة حقيقية لا عطلًا.
 *  * الخطأ التشغيلي العابر (انقطاع اتصال…) لا يستهلك الفرصة: الحالة تعود
 *    idle بعد تسجيل تحذير معقّم، فتُقبل محاولة لاحقة.
 *  * الاستدعاءات المتوازية أثناء running تنتظر نفس المحاولة — لا يُنفَّذ
 *    الإسقاط (5 SELECT) مرتين أبدًا.
 */
type BaselineVerifyState = "idle" | "running" | "completed";
let baselineVerifyState: BaselineVerifyState = "idle";
let baselineVerifyInFlight: Promise<void> | null = null;

/** رسالة التعقيم العامة عند أي خطأ يحمل سرًّا أو رابط قاعدة أو مسارًا. */
const BASELINE_VERIFY_FALLBACK = "تعذّر التحقق من مخطط قاعدة البيانات.";

/**
 * one-shot تشخيصي محمي بعلم صريح: يعمل مرة واحدة كحد أقصى على نتيجة baseline
 * فعلية، عند أول استدعاء health/runtime، ولا يغيّر جواب /api/health ولا يرمي
 * أخطاء — فشل التحقق يُسجَّل ويُكتفى به حتى يقرر المالك (لا إصلاح تلقائي أبدًا
 * من هنا)، وفشل التشغيل العابر وحده يتيح محاولة لاحقة.
 */
export async function logSchemaBaselineVerifyOnce(pool: DbPool): Promise<void> {
  if (!isProductionRuntime() || process.env.SCHEMA_BASELINE_VERIFY_ONCE !== "true") return;
  if (baselineVerifyState === "completed") return;
  if (baselineVerifyState === "running" && baselineVerifyInFlight) {
    // استدعاء متوازٍ: ينتظر نفس الوعد — الإسقاط لا يجري مرتين.
    await baselineVerifyInFlight;
    return;
  }

  baselineVerifyState = "running";
  const attempt = (async () => {
    try {
      const result = await verifySchemaBaseline(pool);
      if (result.compatible) {
        console.info(
          `[schema-baseline] compatible=true pg_major=${result.postgresMajor} `
          + `fingerprint=${result.fingerprint.slice(0, 16)} `
          + `tables=${result.checked.tables} columns=${result.checked.columns} `
          + `constraints=${result.checked.constraints} indexes=${result.checked.indexes} `
          + `triggers=${result.checked.triggers}`,
        );
      } else {
        console.error(
          `[schema-baseline] compatible=false pg_major=${result.postgresMajor} `
          + `missing_tables=${result.missingTables} column_problems=${result.columnProblems} `
          + `missing_constraints=${result.missingConstraints} missing_indexes=${result.missingIndexes} `
          + `missing_triggers=${result.missingTriggers} `
          + `samples=${JSON.stringify(result.samples)}`,
        );
      }
      baselineVerifyState = "completed";
    } catch (error) {
      console.warn(
        `[schema-baseline] verification failed: ${sanitizeErrorMessage(error, BASELINE_VERIFY_FALLBACK)}`,
      );
      baselineVerifyState = "idle";
    } finally {
      baselineVerifyInFlight = null;
    }
  })();
  baselineVerifyInFlight = attempt;
  await attempt;
}
