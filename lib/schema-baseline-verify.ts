import { comparePublicSchemaToManifest, type BaselineSchemaManifest, type SchemaManifestDiff } from "./schema-manifest";
import type { DbPool } from "./db";
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
 * تشخيصات المدير وحده.
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

assertCommittedManifest(committed);
const COMMITTED_BASELINE_MANIFEST: BaselineSchemaManifest = Object.freeze(committed);

/** المرجع الملتزم — مقروء فقط (مجمّد). */
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

let baselineLogged = false;

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production"
    || process.env.DATABASE_ENVIRONMENT === "production"
    || Boolean(process.env.RAILWAY_PROJECT_ID);
}

/**
 * one-shot تشخيصي محمي بعلم صريح: يعمل مرة واحدة كحد أقصى، عند أول استدعاء
 * health/runtime، ولا يغيّر جواب /api/health ولا يرمي أخطاء — فشل التحقق
 * يُسجَّل ويُكتفى به حتى يقرر المالك (لا إصلاح تلقائي أبدًا من هنا).
 */
export async function logSchemaBaselineVerifyOnce(pool: DbPool): Promise<void> {
  if (!isProductionRuntime() || process.env.SCHEMA_BASELINE_VERIFY_ONCE !== "true" || baselineLogged) return;

  baselineLogged = true;
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
  } catch (error) {
    console.warn(
      `[schema-baseline] verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
