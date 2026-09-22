import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Client, type ClientConfig } from "pg";
import { loadMigrationFiles, migrate, migrationStatus } from "../migrations";
import { sslForConnection, parseDatabaseHost } from "../db-tls";
import { readTarGzEntries } from "./archive";
import { validateBackupArchive, type ValidationOk } from "./validate";

/**
 * الاستعادة بإعداد Staging/Cutover (P1.15) — لا حالة نصف مستعادة أبدًا.
 *
 * النمط المحرم: «استُعيدت القاعدة وفشلت المستندات» — عيادة تعمل بسجلات بلا
 * أشعة. النمط المعمول به هنا:
 *
 *   اقرأ الأرشيف كاملًا وحقّقه (كل التحققيات العشر)
 *   → استعد القاعدة إلى هدف معزول (ليس إنتاجًا)
 *   → استعد المستندات إلى دليل staging (ليس دليل الإنتاج)
 *   → تحقق من الاثنين تحققًا مستقلًا
 *   → أنتج حالة READY FOR CUTOVER مع خطوات التبديل موثَّقة.
 *
 * التبديل الفعلي (إيقاف التطبيق → تبديل القاعدة → نقل دليل staging إلى
 * DOCUMENTS_DIR → إقلاع → تحقق) **لا يُنفَّذ في P1** — موثَّق فقط في
 * docs/DISASTER_RECOVERY.md. الاستعادة إلى قاعدة الإنتاج قرار تشغيلي بعد
 * مراجعة مستقلة.
 */

export interface StagedRestoreOptions {
  archivePath: string;
  targetUrl: string;
  stagingDir: string;
  /** يرفض الهدف غير الفارغ افتراضًا — لا استعادة فوق بيانات بلا علم صريح. */
  allowNonEmptyTarget?: boolean;
}

export interface StagedRestoreResult {
  ok: boolean;
  targetIdentity: { host: string; port: string; database: string; user: string } | null;
  validationErrors: string[];
  documentsRestored: number;
  documentsVerified: number;
  migrationsApplied: string[];
  sqlRowsStatementLines: number;
  skippedMigrationRecordLines: number;
  readyForCutover: boolean;
  verification: {
    criticalProbeOk: boolean;
    migrationConsistent: boolean;
    tablesCount: number;
  };
  cutoverSteps: string[];
  errors: string[];
}

function clientConfigFor(url: string): ClientConfig {
  return { connectionString: url, ssl: sslForConnection(url) };
}

/** pool-محاكٍ حول Client واحد — ليستخدمه نظام الهجرات على اتصال مخصص. */
function clientAsPool(client: Client) {
  return {
    query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
    connect: async () => ({
      query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
      release: () => {},
    }),
  };
}

async function targetTableCount(client: Client): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS tables FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  return rows[0]?.tables ?? 0;
}

interface ForeignKeyEdge {
  constraint_name: string;
  schema_name: string;
  table_name: string;
  child_id: string;
  parent_id: string;
  condeferrable: boolean;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Only foreign keys on a directed cycle need temporary deferral during replay. */
async function nonDeferrableCyclicForeignKeys(client: Client): Promise<ForeignKeyEdge[]> {
  const { rows } = await client.query<ForeignKeyEdge>(
    `SELECT c.conname AS constraint_name, n.nspname AS schema_name,
            r.relname AS table_name, c.conrelid::text AS child_id,
            c.confrelid::text AS parent_id, c.condeferrable
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       JOIN pg_class p ON p.oid = c.confrelid
       JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public' AND pn.nspname = 'public'`,
  );
  const parents = new Map<string, Set<string>>();
  for (const edge of rows) {
    if (!parents.has(edge.child_id)) parents.set(edge.child_id, new Set());
    parents.get(edge.child_id)!.add(edge.parent_id);
  }
  const canReach = (start: string, destination: string): boolean => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === destination) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(parents.get(current) ?? []));
    }
    return false;
  };
  return rows.filter((edge) => !edge.condeferrable && canReach(edge.parent_id, edge.child_id));
}

/** The archive has one outer transaction; the caller owns that transaction here. */
function withoutArchiveTransaction(lines: string[]): string {
  const opening = lines.findIndex((line) => line.trim() === "BEGIN;");
  let closing = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === "COMMIT;") {
      closing = index;
      break;
    }
  }
  if (opening < 0 || closing <= opening || lines.slice(closing + 1).some((line) => line.trim())) {
    throw new Error("ملف SQL لا يحوي إطار معاملة الاستعادة المتوقع.");
  }
  return lines.slice(opening + 1, closing).join("\n");
}

/**
 * تنفيذ الاستعادة المعزولة كاملة. كل خطوة تفشل توقف ما بعدها — والهدف
 * المعزول يمكن التخلي عنه بأمان في أي لحظة (هذا جوهر العزل).
 */
export async function stagedRestore(options: StagedRestoreOptions): Promise<StagedRestoreResult> {
  const result: StagedRestoreResult = {
    ok: false,
    targetIdentity: parseDatabaseHost(options.targetUrl),
    validationErrors: [],
    documentsRestored: 0,
    documentsVerified: 0,
    migrationsApplied: [],
    sqlRowsStatementLines: 0,
    skippedMigrationRecordLines: 0,
    readyForCutover: false,
    verification: { criticalProbeOk: false, migrationConsistent: false, tablesCount: 0 },
    cutoverSteps: [],
    errors: [],
  };

  // ── الخطوة ١: قراءة الأرشيف كاملًا وتحقيقه — قبل أي لمس للهدف.
  let archive;
  try {
    archive = await readTarGzEntries(options.archivePath);
  } catch (error) {
    result.errors.push(`تعذّرت قراءة الأرشيف — الملف تالف أو مقطوع أو ليس gzip سليمًا: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  const validated = validateBackupArchive(archive, { documentsDir: options.stagingDir });
  if (!validated.ok) {
    result.validationErrors = validated.errors;
    result.errors.push(...validated.errors);
    return result; // لا استعادة قاعدة أصلًا (P1.12)
  }

  const client = new Client(clientConfigFor(options.targetUrl));
  try {
    await client.connect();

    // ── الخطوة ٢: الهدف فارغ؟ (رفض غير الفارغ افتراضًا)
    const tables = await targetTableCount(client);
    if (tables > 0 && !options.allowNonEmptyTarget) {
      result.errors.push(
        `الهدف ليس فارغًا (${tables} جدولًا). الاستعادة فوق بيانات قائمة مرفوضة `
        + "افتراضًا — إن كان المقصود فعلًا فمرّر allowNonEmptyTarget بوعي كامل.",
      );
      return result;
    }

    // ── الخطوة ٣: المخطط من نظام الهجرات (بلا بذور أبدًا) — قاعدة فارغة.
    // كل فشل من هنا فصاعدًا يُبلَّغ نتيجةً (ok=false + errors) لا استثناءً يُرمى —
    // فالسطر الذي يُفشله يهمّ من يشغّل الاستعادة، والهدف المعزول يُتخلّص منه بأمان.
    const migrationFiles = await loadMigrationFiles();
    const migrationPool = clientAsPool(client);
    try {
      const migrationRun = await migrate(migrationPool, { apply: true, files: migrationFiles });
      result.migrationsApplied = migrationRun.appliedVersions;

    // ── الخطوة ٤: بيانات SQL — مع استبعاد صفوف تسجيل الهجرات نفسها:
    // حالة الهجرات في الهدف تُعرَّف بما طبَّقته الخطوة ٣ (الملفات الحالية)، لا
    // بلقطة النسخة — فتُستعاد نسخة قديمة على كود أحدث فتظل حالة المخطط صحيحة.
    const sqlText = Buffer.from(validated.sql).toString("utf8");
    const lines = sqlText.split("\n");
    const appliedLines: string[] = [];
    for (const line of lines) {
      if (/^INSERT INTO schema_migrations\s/.test(line)) {
        result.skippedMigrationRecordLines += 1;
        continue;
      }
      if (/^INSERT INTO\s/.test(line)) result.sqlRowsStatementLines += 1;
      appliedLines.push(line);
    }
      const dataSql = withoutArchiveTransaction(appliedLines);
      await client.query("BEGIN");
      try {
        const cyclicKeys = await nonDeferrableCyclicForeignKeys(client);
        for (const key of cyclicKeys) {
          await client.query(
            `ALTER TABLE ${quoteIdentifier(key.schema_name)}.${quoteIdentifier(key.table_name)} `
            + `ALTER CONSTRAINT ${quoteIdentifier(key.constraint_name)} DEFERRABLE INITIALLY DEFERRED`,
          );
        }
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(dataSql);
        // Force every deferred foreign key check before restoring its original declaration.
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        for (const key of cyclicKeys) {
          await client.query(
            `ALTER TABLE ${quoteIdentifier(key.schema_name)}.${quoteIdentifier(key.table_name)} `
            + `ALTER CONSTRAINT ${quoteIdentifier(key.constraint_name)} NOT DEFERRABLE INITIALLY IMMEDIATE`,
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    } catch (error) {
      result.errors.push(
        `فشل تطبيق بيانات الاستعادة على الهدف المعزول: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }

    // ── الخطوة ٥: المستندات إلى دليل staging — لا إلى دليل الإنتاج.
    await mkdir(options.stagingDir, { recursive: true });
    for (const document of validated.documents) {
      const target = path.join(options.stagingDir, document.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, document.bytes);
      result.documentsRestored += 1;
      // تحقق مستقل بعد الكتابة: قراءة من القرص وبصمة جديدة.
      const written = await readFile(target);
      if (createHash("sha256").update(written).digest("hex") !== document.sha256) {
        result.errors.push(`فشل تحقق ما بعد الكتابة: ${document.relativePath}`);
        return result;
      }
      result.documentsVerified += 1;
    }

    // ── الخطوة ٦: تحقق الهدف بعد الاستعادة.
    const status = await migrationStatus(migrationPool, migrationFiles);
    result.verification = {
      criticalProbeOk: status.probe.ok,
      migrationConsistent: status.consistent,
      tablesCount: await targetTableCount(client),
    };
    if (!status.probe.ok) {
      result.errors.push(`فحص التوافق بعد الاستعادة فشل: ${status.probe.missing.join("، ")}`);
      return result;
    }
    if (!status.consistent) {
      result.errors.push("حالة الهجرات بعد الاستعادة غير متسقة.");
      return result;
    }

    result.ok = true;
    result.readyForCutover = true;
    result.cutoverSteps = cutoverStepsFor(options, result);
    return result;
  } finally {
    await client.end().catch(() => {});
  }
}

/** خطوات التبديل موثَّقة لا منفَّذة (P1.15: لا Production Cutover في هذه المرحلة). */
function cutoverStepsFor(options: StagedRestoreOptions, result: StagedRestoreResult): string[] {
  return [
    "⚠️ هذه الخطوات توثيقٌ للتبديل فقط — لا تُنفَّذ آليًا، والقرار تشغيلي بعد مراجعة مستقلة.",
    `١) أوقف تطبيق الإنتاج (Railway: إيقاف الخدمة) حتى لا تُكتب بيانات جديدة أثناء التبديل.`,
    `٢) خذ نسخة احتياطية من قاعدة الإنتاج الحالية قبل أي تبديل (خطة رجوع).`,
    `٣) استبدل قاعدة الإنتاج بالهدف المعزول المُستعاد: ${result.targetIdentity ? `${result.targetIdentity.database} على ${result.targetIdentity.host}:${result.targetIdentity.port}` : "(هدف غير معروف)"}.`,
    `٤) انقل محتوى دليل staging ${options.stagingDir} إلى DOCUMENTS_DIR النهائي (rsync/ mv مع إبقاء التصاريح).`,
    `٥) أعد تشغيل التطبيق وشغّل npm run db:status — يجب أن يظهر consistent.`,
    `٦) تحقق بصريًا: عدد المرضى، آخر الدفعات، عينة أشعة تُفتح من ملفاتها.`,
    `٧) وثّق التبديل في سجل الحوادث مع SHA الأرشيف وطابع الزمن ومن أذن به.`,
  ];
}
