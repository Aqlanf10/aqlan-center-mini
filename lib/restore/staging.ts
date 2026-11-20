import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import type { VerifiedArchive } from "../backupVolume";
import { loadMigrationFiles, migrate, migrationStatus } from "../migrations";
import { parseDatabaseHost } from "../db-tls";
import { restoreClientConfigFor } from "./client-config";
import { readTarGzEntries } from "./archive";
import { validateBackupArchive } from "./validate";
import { prepareBackupSql } from "./sql.mjs";
import { restorePatientNumberSequence } from "./patient-number-sequence.mjs";
import { loginPhotoRestoreProblem } from "./login-photo";
import { numberingCutoverHold, type RestoreCutoverBlocker, type RestoreNumberingEvidence } from "./cutover-readiness";

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
 *   → أبلِغ نجاح الاستعادة المعزولة، دون اعتماد التحويل أو استئناف الترقيم.
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
  readyForCutover: false;
  cutoverBlocker: RestoreCutoverBlocker | null;
  patientNumberSequence: RestoreNumberingEvidence;
  verification: {
    criticalProbeOk: boolean;
    migrationConsistent: boolean;
    tablesCount: number;
  };
  cutoverSteps: string[];
  errors: string[];
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

/**
 * تنفيذ الاستعادة المعزولة كاملة. كل خطوة تفشل توقف ما بعدها — والهدف
 * المعزول يمكن التخلي عنه بأمان في أي لحظة (هذا جوهر العزل).
 */
export function stagedRestore(options: StagedRestoreOptions): Promise<StagedRestoreResult> {
  return restoreStaged(options);
}

/** Internal admin-drill entry point. The guarded caller supplies the existing
 * verified history receipt, then resets its dedicated target only after we
 * have privately captured and validated the exact replay bytes. No unchecked
 * prepared-data input, validation opt-out, or occupied-target override. */
export function stagedRestoreForVerifiedDrill(
  options: Omit<StagedRestoreOptions, "allowNonEmptyTarget">,
  expected: Readonly<VerifiedArchive>,
  beforeReplay: () => Promise<void>,
): Promise<StagedRestoreResult> {
  return restoreStaged({ ...options, allowNonEmptyTarget: false }, { expected: { ...expected }, beforeReplay });
}

async function restoreStaged(
  options: StagedRestoreOptions,
  admission?: { expected: Readonly<VerifiedArchive>; beforeReplay: () => Promise<void> },
): Promise<StagedRestoreResult> {
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
    cutoverBlocker: null,
    patientNumberSequence: "unverified",
    verification: { criticalProbeOk: false, migrationConsistent: false, tablesCount: 0 },
    cutoverSteps: [],
    errors: [],
  };

  // ── الخطوة ١: قراءة الأرشيف كاملًا وتحقيقه — قبل أي لمس للهدف.
  let archive;
  try {
    archive = await readTarGzEntries(options.archivePath, admission?.expected);
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

  if (admission && (validated.sqlSha256 !== admission.expected.databaseSha256 || validated.documents.length !== admission.expected.documents)) {
    const reason = "Stored archive SQL digest or document count mismatch.";
    result.validationErrors.push(reason);
    result.errors.push(reason);
    return result;
  }

  let prepared: ReturnType<typeof prepareBackupSql>;
  try {
    prepared = prepareBackupSql(Buffer.from(validated.sql).toString("utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result.validationErrors.push(reason);
    result.errors.push(reason);
    return result;
  }

  // Nothing below reads the archive pathname. A reset may run arbitrary I/O
  // against the dedicated target, but it cannot replace our prepared payload.
  if (admission) await admission.beforeReplay();
  const client = new Client(restoreClientConfigFor(options.targetUrl));
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
      result.skippedMigrationRecordLines = prepared.skippedMigrationRecordLines;
      result.sqlRowsStatementLines = prepared.sqlRowsStatementLines;
      const dataSql = prepared.dataSql;
      await client.query("SET standard_conforming_strings = on");
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
        // The restored setting may point only at its reserved branding asset
        // already verified in this archive. Check before committing isolated
        // replay, writing files, or ever declaring this target ready for cutover.
        const { rows: photoSettings } = await client.query<{ value: string }>(
          "SELECT value FROM settings WHERE key = $1", ["clinic.login_photo_asset"],
        );
        const photoProblem = loginPhotoRestoreProblem(photoSettings[0]?.value ?? "", validated.documents);
        if (photoProblem) throw new Error(photoProblem);
        const patientNumberSequence = await restorePatientNumberSequence(client, prepared.patientNumberSequence);
        await client.query("COMMIT");
        result.patientNumberSequence = patientNumberSequence;
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
    result.cutoverBlocker = numberingCutoverHold(result.patientNumberSequence).cutoverBlocker;
    return result;
  } finally {
    await client.end().catch(() => {});
  }
}
