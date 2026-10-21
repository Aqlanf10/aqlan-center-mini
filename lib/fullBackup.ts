import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { backupSnapshotSqlLines, backupSnapshotEvents, backupSqlLines, getPool, type Queryable } from "./db";
import { readFileByKey } from "./files";
import { tarEnd, tarHeader, tarPadding } from "./tar";
import { renderBackupSnapshotEvent, validateBackupDeferredReferences, type BackupSnapshotEvent } from './backup-events';
import { beginSyntheticCapture, finishSyntheticCapture, sealSyntheticCapture, failSyntheticCapture,
  SYNTHETIC_U0_PROFILE, SYNTHETIC_U0_ENTRY, SYNTHETIC_LIMITS, recoverySha256, type SyntheticCaptureController, type SyntheticDeferredLink } from './restore/u0-synthetic-capture';

/**
 * النسخة الكاملة بملفٍّ واحد — قاعدة البيانات **وأشعّة المرضى معًا**.
 * (منقولة من مستودع الوكيل الآخر aqlan-center-main لمكوّناتنا.)
 *
 * كانت نسختنا ملفين يُنزّلان كلٌّ على حدة، وأشعة المرضى تُنزّل أرشيفًا منفصلًا —
 * فمن نسي الثاني نزّل نصف ذاكرة المركز وظنّ أنه كلّها. وهنا الملف واحد:
 * `database.sql` ثم `documents/` ثم `manifest.json` **أخيرًا**.
 *
 * ### ولماذا `manifest.json` أخيرًا
 *
 * لأنّ التنزيل المقطوع لا يستطيع أن يتنكّر كنسخةٍ كاملة: من يفتح الملف الناقص
 * لا يجد المفتاح الأخير فيعرف أنّ عليه إعادة التنزيل. ولو كان أولًا لقرأه
 * «سليمة» وبنى سلامةً على نصف أرشيف.
 *
 * ### لقطة واحدة متسقة (بمصدر صريح)
 *
 * حين يُمرَّر `source` (مسار الإنتاج) فإن بناء database.sql وقراءة metadata
 * المستندات يجريان **داخل معاملة REPEATABLE READ READ ONLY واحدة** على ذلك
 * المصدر: ما تراه جملة SQL هو بالضبط ما تراه قائمة المستندات — لا فجوة
 * بينهما ي slipped فيها مستندٌ أو صفٌّ بين COMMITين. ثم تُغلق المعاملة،
 * وبعدها وحدها تُقرأ البايتات الفيزيقية للملفات غير القابلة للتغيير — لا
 * يُبقى اتصال قاعدة مفتوحًا أثناء تدفّق الملفات الكبيرة.
 *
 * ### التفريد الفيزيقي
 *
 * صفّان في patient_documents قد يشيران إلى storage_key واحد (نفس الملف
 * مرفق بمريضين). الأرشيف يخزّن الملف الفيزيقي مرة واحدة (`documents/<key>`)،
 * وmanifest يصف **الأجسام الفيزيقية الفريدة** لا صفوف القاعدة: المفتاح
 * والبصمة والحجم فقط — database.sql يحمل كل صفوف القاعدة أصلاً. والتفريد
 * مشروطٌ باتفاق الصفوف المتشاركة على بصمة الملف وحجمه ذاتهما — تعارضٌ بينهما
 * يعني قاعدةً غير متسقة مع نفسها، فيُفشل النسخة مغلقًا لا يُختار أول صفٍّ بصمت.
 */

export interface BackupDocument {
  /** رقم الصف، أو معرّفٌ نصّي بمصدره (doc-7 / expense-3) حين تُجمع الجداول. */
  id: number | string;
  storage_key: string;
  sha256: string;
  size_bytes: string | number;
}

/** المستند الفيزيقي الفريد كما يُوصف في manifest — الحد الأدنى للتحقق والاستعادة. */
export interface ManifestPhysicalFile {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * خيارات النسخة الكاملة — حقن اختياري لا يغيّر الصيغة ولا السلوك الافتراضي:
 *
 *  * `source` — مصدر قراءة صريح (اتصال مخصص). تمريره **يُلغي** استدعاء
 *    `ensureSchema` في مسار القاعدة (backupSqlLines تستدعيه حين يغيب المصدر
 *    فقط)، وهو ما يفرضه مسار النسخة الإنتاجية: لا إصلاح مخططٍ ضمن النسخ.
 *    ويمريره يفعّل اللقطة الموحّدة أعلاه (SQL + metadata في معاملة واحدة).
 *  * `appCommitSha` و`pgVersion` — حقول إثراء اختيارية في manifest.json
 *    (إضافية فقط: قارئ الاستعادة يتجاهل ما لا يعرفه، والصيغة والإصدار كما هما).
 */
export interface FullBackupOptions {
  /** Internal disposable-fixture capability only. Never created by operational routes/CLI. */
  syntheticRecovery?: SyntheticCaptureController;
  source?: Queryable;
  appCommitSha?: string | null;
  pgVersion?: string | null;
  /**
   * قارئ مستندات بديل (اختياري) — الافتراضي readFileByKey كما هو. مسار الإنتاج
   * يمرّر قارئًا يفحص احتواء realpath قبل القراءة (لا symlink يخرج من الدليل).
   */
  readDocument?: (storageKey: string) => Promise<Buffer | null>;
}

/**
 * تفريد صفوف المستندات بالمفتاح الفيزيقي — **بشرط اتفاق الصفوف المتشاركة**:
 * صفّان (أو أكثر) بمفتاحٍ واحد يعنيان ملفًا فيزيائيًّا واحدًا، فيُقبلان فقط
 * إن اتفقا على sha256 وحجم الملف ذاتهما؛ أي تعارضٍ بين الصفوف (بصمةٌ مختلفة
 * أو حجمٌ مختلف لنفس المفتاح) يُفشل النسخة كاملةً (fail closed) — لا اختيار
 * أول صفٍّ بصمت: database.sql سيحمل الصفين معًا، واستعادةُ ملفٍ فيزيائيٍّ
 * واحد تحت وصفي محتوىً متعارضين تنتج استعادةً غير متسقة داخليًّا. الدالة
 * نقية حصرًا لتُختبر بلا قاعدة.
 */
export function uniqueDocumentsByStorageKey(documents: BackupDocument[]): BackupDocument[] {
  const byKey = new Map<string, BackupDocument>();
  for (const document of documents) {
    const existing = byKey.get(document.storage_key);
    if (!existing) {
      byKey.set(document.storage_key, document);
      continue;
    }
    if (!samePhysicalMetadata(existing, document)) {
      throw new Error(
        `تعارض بيانات مستندٍ مكرر في اللقطة: storage_key واحد يشير إلى محتوىٍ أو حجمٍ مختلف `
        + `(صف ${existing.id} مقابل صف ${document.id}) — النسخة مرفوضة.`,
      );
    }
  }
  return [...byKey.values()];
}

/** هل يصف الصفّان الملفَ الفيزيائي نفسه؟ — بصمةٌ وحجمٌ متطابقان (الحجم رقميًّا). */
function samePhysicalMetadata(first: BackupDocument, second: BackupDocument): boolean {
  if (first.sha256 !== second.sha256) return false;
  const firstSize = Number(first.size_bytes);
  const secondSize = Number(second.size_bytes);
  return Number.isFinite(firstSize) && Number.isFinite(secondSize) && firstSize === secondSize;
}

interface BackupSnapshot {
  syntheticRecovery?: Buffer;
  sqlPath: string;
  sqlSha256: string;
  sqlSize: number;
  /** الصفوف الفريدة فيزيائيًّا — بالترتيب الذي قُرئت به من اللقطة. */
  documents: BackupDocument[];
}

/** SELECT metadata المستندات — أعمدة التحقق حصرًا، بلا عنوان ولا معرّف مريض. */
const DOCUMENT_METADATA_SQL =
  "SELECT id, storage_key, sha256, size_bytes FROM patient_documents ORDER BY id";

/**
 * ومرفقات سندات الصرف (0020) ملفاتٌ في المخزن نفسه — تدخل الأرشيف معها، وإلا
 * ضاعت فاتورة المورّد مع أول استعادة (أو مع إعادة الضبط التي تحذف ملفاتها بعد
 * النسخة). المعرّف نصّيٌّ مميَّز بالمصدر كي لا يلتبس صفّان من جدولين في رسالة خطأ.
 */
const DOCUMENT_AND_ATTACHMENT_METADATA_SQL =
  `SELECT 'doc-' || id AS id, storage_key, sha256, size_bytes FROM patient_documents
   UNION ALL
   SELECT 'expense-' || id AS id, storage_key, sha256, size_bytes FROM expense_attachments
   ORDER BY id`;

/**
 * metadata الملفات من داخل اللقطة. قاعدةٌ أقدم من 0020 (بلا expense_attachments)
 * تُقرأ مستنداتها وحدها — SELECT حصرًا في الحالتين، لا إصلاح مخطط ضمن النسخ.
 */
async function readDocumentMetadata(source: Queryable): Promise<BackupDocument[]> {
  const probe = (await source.query(
    "SELECT to_regclass('public.expense_attachments') IS NOT NULL AS present",
  )) as unknown as { rows: { present: boolean }[] };
  const sql = probe.rows[0]?.present ? DOCUMENT_AND_ATTACHMENT_METADATA_SQL : DOCUMENT_METADATA_SQL;
  const { rows } = (await source.query(sql)) as unknown as { rows: BackupDocument[] };
  return rows;
}

/**
 * التقاط اللقطة الموحّدة من مصدر صريح: معاملة واحدة تحمل SQL وmetadata معًا،
 * تُغلق COMMIT قبل أي قراءة فيزيائية للملفات. أي فشل: ROLLBACK ثم استثناء —
 * ولا يُترك اتصالٌ داخل معاملة.
 */
async function captureSnapshotFromSource(source: Queryable, stage: string, controller?: SyntheticCaptureController): Promise<BackupSnapshot> {
  if (controller) beginSyntheticCapture(controller, source);
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let completed = false;
  try {
    const sqlPath = join(stage, "database.sql");
    const sqlFile = await open(sqlPath, "wx", 0o600);
    const hash = createHash("sha256");
    let byteOffset = 0, statementOrdinal = 0;
    const links: SyntheticDeferredLink[] = [];
    const events: BackupSnapshotEvent[] = [];
    try {
      if (controller) {
        for await (const event of backupSnapshotEvents(source)) {
          const line = renderBackupSnapshotEvent(event);
          if (events.length >= SYNTHETIC_LIMITS.events || byteOffset + Buffer.byteLength(line) > SYNTHETIC_LIMITS.sqlBytes) throw new Error('Synthetic SQL size/count limit');
          if (event.kind === 'deferred-reference') links.push({ ...event, ordinal: statementOrdinal,
            startByte: byteOffset, endByte: byteOffset + Buffer.byteLength(line, 'utf8') - 1 });
          if (event.kind !== 'comment' && event.kind !== 'separator') statementOrdinal += 1;
          events.push(event);
          hash.update(line); await sqlFile.writeFile(line);
          byteOffset += Buffer.byteLength(line, 'utf8');
        }
        validateBackupDeferredReferences(events);
      } else {
        for await (const line of backupSnapshotSqlLines(source)) {
          hash.update(line); await sqlFile.writeFile(line);
        }
      }
    } finally {
      await sqlFile.close();
    }

    // metadata داخل المعاملة نفسها — اللقطة واحدة لا اثنتين.
    const documents = uniqueDocumentsByStorageKey(await readDocumentMetadata(source));
    const sqlSha256 = hash.digest("hex");
    const sqlSize = (await stat(sqlPath)).size;
    const syntheticRecovery = controller ? await finishSyntheticCapture(controller, { sha256: sqlSha256, bytes: sqlSize }, links) : undefined;

    await source.query("COMMIT");
    completed = true;

    return {
      sqlPath,
      sqlSha256,
      sqlSize,
      documents,
      ...(syntheticRecovery ? { syntheticRecovery } : {}),
    };
  } finally {
    if (!completed) await source.query("ROLLBACK").catch(() => {});
  }
}

/**
 * المسار الافتراضي القديم (بلا مصدر صريح): database.sql من backupSqlLines
 * (فتحها معاملتها الخاصة واستدعاء ensureSchema كما هو) ثم metadata من المجمع.
 * هذا مسار أداة التنزيل الإدارية القائمة — ليس مسار النسخ الإنتاجي.
 */
async function captureSnapshotDefault(stage: string): Promise<BackupSnapshot> {
  const sqlPath = join(stage, "database.sql");
  const sqlFile = await open(sqlPath, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    for await (const line of backupSqlLines()) {
      hash.update(line);
      await sqlFile.writeFile(line);
    }
  } finally {
    await sqlFile.close();
  }

  const rows = await readDocumentMetadata(getPool());
  return {
    sqlPath,
    sqlSha256: hash.digest("hex"),
    sqlSize: (await stat(sqlPath)).size,
    documents: uniqueDocumentsByStorageKey(rows),
  };
}

/**
 * تصيير الأرشيف من لقطةٍ مُلتقَتة: SQL ثم البايتات الفيزيقية للمستندات ثم
 * manifest أخيرًا. هنا — وبعد إغلاق المعاملة — وحدها تُقرأ الملفات الكبيرة.
 */
async function* renderArchiveBlocks(
  snapshot: BackupSnapshot,
  options: Pick<FullBackupOptions, "appCommitSha" | "pgVersion" | "readDocument">,
): AsyncGenerator<Uint8Array> {
  const now = new Date();
  yield tarHeader("database.sql", snapshot.sqlSize, now);
  for await (const chunk of createReadStream(snapshot.sqlPath)) yield chunk as Buffer;
  yield tarPadding(snapshot.sqlSize);

  for (const document of snapshot.documents) {
    const bytes = options.readDocument
      ? await options.readDocument(document.storage_key)
      : await readFileByKey(document.storage_key);
    if (!bytes || bytes.length !== Number(document.size_bytes)
        || createHash("sha256").update(bytes).digest("hex") !== document.sha256) {
      throw new Error(`Backup document missing or corrupt: ${document.id}`);
    }
    yield tarHeader(`documents/${safeTarName(document.storage_key)}`, bytes.length, now);
    yield bytes;
    yield tarPadding(bytes.length);
  }

  if (snapshot.syntheticRecovery) {
    yield tarHeader(SYNTHETIC_U0_ENTRY, snapshot.syntheticRecovery.length, now);
    yield snapshot.syntheticRecovery;
    yield tarPadding(snapshot.syntheticRecovery.length);
  }

  // يُكتب أخيرًا: التنزيل المقطوع لا يستطيع التنكر كنسخة كاملة.
  // أجسام فيزيقية فريدة حصرًا: المفتاح والبصمة والحجم — بلا عناوين ولا
  // معرّفات مرضى (database.sql يحمل الصفوف كلها، والاستعادة تحتاج وصفَ
  // الملف لا وصفَ صف). حقول الإثراء إضافية كما كانت.
  const manifest = Buffer.from(JSON.stringify({
    format: "aqlan-full-backup", version: snapshot.syntheticRecovery ? 2 : 1, createdAt: now.toISOString(),
    ...(snapshot.syntheticRecovery ? { recoveryProfile: SYNTHETIC_U0_PROFILE,
      recoverySha256: recoverySha256(snapshot.syntheticRecovery), recoveryBytes: snapshot.syntheticRecovery.length } : {}),
    databaseSha256: snapshot.sqlSha256,
    databaseBytes: snapshot.sqlSize,
    documentCount: snapshot.documents.length,
    documentsBytes: snapshot.documents.reduce(
      (total, document) => total + Number(document.size_bytes), 0),
    ...(options.appCommitSha ? { appCommitSha: options.appCommitSha } : {}),
    ...(options.pgVersion ? { pgVersion: options.pgVersion } : {}),
    documents: snapshot.documents.map((document): ManifestPhysicalFile => ({
      storageKey: document.storage_key,
      sha256: document.sha256,
      sizeBytes: Number(document.size_bytes),
    })),
  }, null, 2), "utf8");
  yield tarHeader("manifest.json", manifest.length, now);
  yield manifest;
  yield tarPadding(manifest.length);
  yield tarEnd();
}

/**
 * SQL ثم قائمة المستندات ثم الملفات ثم المفتاح.
 *
 * والدقيقة الحرجة هنا ترتيب القراءتين: **اللقطة (SQL + metadata) أولًا
 * بمعاملة واحدة، ثم الملفات الفيزيقية بعد إغلاقها**. فالملفات غير قابلة
 * للتعديل وتُكتب ذرّيًّا قبل وجود صفّها في القاعدة — فأي مستندٍ في لقطة
 * SQL مضمونٌ أنّ ملفّه على القرص لحظة قراءة المستندات، والعكس مستحيل بالبناء
 * الجديد: metadata جاءت من اللقطة نفسها التي جاء منها SQL.
 */
export async function* fullBackupBlocks(
  options: FullBackupOptions = {},
): AsyncGenerator<Uint8Array> {
  const source = options.source;
  const base = resolve(tmpdir());
  const stage = await mkdtemp(join(base, "aqlan-backup-"));
  /* الفحص **قبل** try لا داخل finally.
     كان الرمي داخل finally، وذلك يبتلع الخطأ الأصلي: نسخةٌ فشلت لسببٍ حقيقي
     (قرصٌ ممتلئ، قاعدةٌ منقطعة) كانت تُبلَّغ «مسار مؤقّت غير آمن» — فيُطارَد
     العطب في المكان الخطأ يوم الكارثة. وموضعه الصحيح هنا: إن كان المسار غير
     آمن فلا يُدخل النسخُ أصلًا. */
  if (!resolve(stage).startsWith(base + sep)) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw new Error("Unsafe backup temporary path");
  }
  try {
    if (options.syntheticRecovery && !source) throw new Error('Synthetic capture requires explicit source');
    const snapshot = source
      ? await captureSnapshotFromSource(source, stage, options.syntheticRecovery)
      : await captureSnapshotDefault(stage);
    if (options.syntheticRecovery) {
      const tarHash = createHash('sha256'); let tarBytes = 0;
      for await (const block of renderArchiveBlocks(snapshot, options)) {
        tarBytes += block.length;
        if (tarBytes > SYNTHETIC_LIMITS.tarBytes) throw new Error('Synthetic archive size limit');
        tarHash.update(block); yield block;
      }
      sealSyntheticCapture(options.syntheticRecovery, tarHash.digest('hex'));
    } else {
      yield* renderArchiveBlocks(snapshot, options);
    }
  } catch (error) {
    if (options.syntheticRecovery) failSyntheticCapture(options.syntheticRecovery);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * اسم آمن لمدخل الأرشيف: مفاتيح التخزين عندنا من نمط آمن أصلًا، لكن الحارس
 * هنا لا يثق بأحد — مدخلٌ يبدأ بـ`/` أو يحمل `..` يفسد الأرشيف كله.
 */
function safeTarName(key: string): string {
  const clean = key.replace(/[^A-Za-z0-9._-]/g, "_");
  return clean.startsWith(".") ? `d${clean}` : clean;
}
